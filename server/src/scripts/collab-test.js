/**
 * End-to-end check of the collaboration features, against the real database.
 *
 *   npm run test:collab
 *
 * Drives the actual HTTP routes on an ephemeral port with tokens minted directly,
 * which is what makes it possible to test as two different people without going
 * through two-factor authentication. Everything it creates is purged at the end.
 *
 * Covers: the stale-write conflict, the activity log, @mention notifications, and
 * the soft-delete/restore/purge path.
 */

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { signAccessToken } from '../middleware/auth.js';
import { Activity } from '../models/activity.model.js';
import { Audit } from '../models/audit.model.js';
import { Notification } from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { log } from '../utils/logger.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failed += 1;
    log.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Two throwaway accounts, so "someone else edited this" is a real other person. */
async function makeUser(suffix, role) {
  const username = `zz-collab-${suffix}`;
  await User.deleteOne({ username });
  const user = await User.create({
    username,
    email: `${username}@example.invalid`,
    password: 'collab-test-password',
    firstname: 'Collab',
    lastname: suffix,
    role,
    // The test drives the API with a minted token, so enrolment never applies.
    totpEnrolmentRequired: false,
    // Approved outright: these stand in for people already working here, and the
    // approval gate has its own block below.
    approvedAt: new Date(),
  });
  return { user, token: signAccessToken(user) };
}

async function main() {
  await connectDatabase();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const alice = await makeUser('alice', 'admin');
  const bob = await makeUser('bob', 'user');

  const call = async (who, method, path, body) => {
    /*
     * A `FormData` body carries its own multipart boundary, so it must not be stringified and
     * must not be given a content type — `fetch` sets one that matches what it actually sent.
     */
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${who.token}`,
        ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    // `headers` and `text` are additive: a download has no JSON body, and what it says about
    // how the browser should treat the bytes is the thing worth asserting.
    return {
      status: response.status,
      body: payload,
      text,
      headers: Object.fromEntries(response.headers),
    };
  };

  let auditId = null;

  try {
    /* ---------------------------------------------------------------- setup */
    log.info('Creating an engagement');
    const created = await call(alice, 'POST', '/audits', {
      name: 'zz Collaboration self-test',
      reference: 'ZZ-TEST',
      collaborators: [bob.user._id.toString()],
      reviewers: [bob.user._id.toString()],
    });
    check('engagement created', created.status === 201, JSON.stringify(created.body));
    auditId = created.body?._id;
    if (!auditId) throw new Error('cannot continue without an engagement');

    const finding = await call(alice, 'POST', `/audits/${auditId}/findings`, {
      title: 'Stored XSS in the export view',
      description: '<p>original</p>',
    });
    check('finding created', finding.status === 201, JSON.stringify(finding.body));
    const findingId = finding.body?._id;

    check(
      /*
       * Populated, not a bare id. A write now answers in the same shape a read does, so the page can
       * put the response straight into what it holds instead of refetching the whole engagement to
       * pick up one title — and a name it can show is part of that shape.
       */
      'a finding records who wrote it up, by name as well as by id',
      String(finding.body?.createdBy?._id ?? finding.body?.createdBy) ===
        alice.user._id.toString() && finding.body?.createdBy?.username === alice.user.username,
      JSON.stringify(finding.body?.createdBy)
    );

    /* ------------------------------------------------ who can change the team */
    log.info('Only the creator or an admin changes the team');
    const bystander = await makeUser('bystander', 'user');

    // Bob is a collaborator, not the creator. He may edit the engagement but not
    // decide who else is on it — including who reviews his work.
    const bobAddsSomeone = await call(bob, 'PUT', `/audits/${auditId}`, {
      collaborators: [bob.user._id.toString(), bystander.user._id.toString()],
    });
    check(
      'a collaborator cannot add someone to the team',
      bobAddsSomeone.status === 403,
      `got ${bobAddsSomeone.status}`
    );

    const bobDropsReviewer = await call(bob, 'PUT', `/audits/${auditId}`, { reviewers: [] });
    check(
      'nor remove the reviewers',
      bobDropsReviewer.status === 403,
      `got ${bobDropsReviewer.status}`
    );

    // The details form posts the whole record, so re-sending the same team unchanged
    // must not be mistaken for an attempt to change it.
    const current = await call(bob, 'GET', `/audits/${auditId}`);
    const unchanged = await call(bob, 'PUT', `/audits/${auditId}`, {
      reference: 'ZZ-TEST',
      collaborators: current.body.collaborators.map((c) => c._id),
      // Same members, different order — a set comparison, not a string one.
      reviewers: [...current.body.reviewers.map((r) => r._id)].reverse(),
    });
    check(
      'but a collaborator can still save the form with the team untouched',
      unchanged.status === 200,
      `got ${unchanged.status}: ${JSON.stringify(unchanged.body?.error)}`
    );

    const creatorAdds = await call(alice, 'PUT', `/audits/${auditId}`, {
      collaborators: [
        ...current.body.collaborators.map((c) => c._id),
        bystander.user._id.toString(),
      ],
    });
    check('the creator can', creatorAdds.status === 200, JSON.stringify(creatorAdds.body?.error));
    check(
      'and the person really was added',
      (creatorAdds.body?.collaborators ?? []).some((c) => c.username === bystander.user.username)
    );

    // Put it back, and prove an admin can too. Alice is an admin here, so use a
    // second admin who is not the creator to test that path honestly.
    const otherAdmin = await makeUser('otheradmin', 'admin');
    const adminRemoves = await call(otherAdmin, 'PUT', `/audits/${auditId}`, {
      collaborators: current.body.collaborators.map((c) => c._id),
    });
    check(
      'an admin who did not create it can too',
      adminRemoves.status === 200,
      JSON.stringify(adminRemoves.body?.error)
    );

    const { User: Users } = await import('../models/user.model.js');
    await Users.deleteMany({ _id: { $in: [bystander.user._id, otherAdmin.user._id] } });

    /* ----------------------------------------- non-ASCII report filenames --- */
    log.info('Report download with a non-ASCII name');
    // The em dash in a name like "Northwind — Portal Assessment" is outside latin1,
    // and Node refuses such a header — which failed the download *after* the
    // document had been rendered.
    const { Template } = await import('../models/template.model.js');
    const anyTemplate = await Template.findOne({ kind: { $ne: 'html' } });
    if (anyTemplate) {
      await call(alice, 'PUT', `/audits/${auditId}`, {
        name: 'zz Société — Évaluation',
        template: anyTemplate._id.toString(),
      });

      const response = await fetch(`${base}/audits/${auditId}/report`, {
        headers: { Authorization: `Bearer ${alice.token}` },
      });
      check('a report with an accented name downloads', response.status === 200, `got ${response.status}`);

      const header = response.headers.get('content-disposition') ?? '';
      check(
        'the header carries the real name, UTF-8 encoded',
        /filename\*=UTF-8''.*%C3%A9/i.test(header),
        header
      );
      check(
        'and an ASCII fallback that still reads sensibly',
        // The reference is appended to the filename, hence the suffix.
        /filename="zz Societe - Evaluation - ZZ-TEST\.docx"/.test(header),
        header
      );
      check(
        'the body is a real document',
        (await response.arrayBuffer()).byteLength > 5000
      );

      await call(alice, 'PUT', `/audits/${auditId}`, { name: 'zz Collaboration self-test' });
    } else {
      log.warn('  skip  report download — no Word template on this instance');
    }

    /* -------------------------------------------- stable finding identifiers */
    log.info('Finding identifiers');
    // Three findings, delete the middle one, add another: the newcomer must not
    // reuse a number, and the survivors must not be renumbered.
    const idA = finding.body;
    const idB = await call(alice, 'POST', `/audits/${auditId}/findings`, { title: 'zz second' });
    const idC = await call(alice, 'POST', `/audits/${auditId}/findings`, { title: 'zz third' });
    check(
      'identifiers are allocated in sequence',
      idA.identifier === 1 && idB.body.identifier === 2 && idC.body.identifier === 3,
      JSON.stringify([idA.identifier, idB.body.identifier, idC.body.identifier])
    );

    await call(alice, 'DELETE', `/audits/${auditId}/findings/${idB.body._id}`);
    const idD = await call(alice, 'POST', `/audits/${auditId}/findings`, { title: 'zz fourth' });
    check(
      'a new finding after a delete does not reuse a number',
      idD.body.identifier === 4,
      `got ${idD.body.identifier} — 3 would collide with "zz third"`
    );

    const afterDeleteAudit = await call(alice, 'GET', `/audits/${auditId}`);
    const identifiers = afterDeleteAudit.body.findings.map((f) => f.identifier);
    check(
      'identifiers are unique across the engagement',
      new Set(identifiers).size === identifiers.length,
      JSON.stringify(identifiers)
    );

    // The printed id must survive a re-sort. Give the last finding the top score so
    // automatic CVSS ordering moves it to first place.
    const before = await call(alice, 'GET', `/audits/${auditId}/report-data`);
    const idsBefore = new Map(
      (before.body?.findings ?? []).map((f) => [f.title, f.id])
    );
    await call(alice, 'PUT', `/audits/${auditId}/findings/${idD.body._id}`, {
      title: 'zz fourth',
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    });
    const after = await call(alice, 'GET', `/audits/${auditId}/report-data`);
    const idsAfter = new Map((after.body?.findings ?? []).map((f) => [f.title, f.id]));

    check(
      're-scoring one finding reorders the report',
      after.body.findings[0].title === 'zz fourth',
      after.body.findings[0].title
    );
    check(
      'but every printed id stays with its own finding',
      [...idsBefore.entries()].every(([title, id]) => idsAfter.get(title) === id),
      JSON.stringify({ before: [...idsBefore], after: [...idsAfter] })
    );
    check(
      'and the positional label is still available separately',
      after.body.findings[0].positionId?.endsWith('01'),
      JSON.stringify(after.body.findings[0].positionId)
    );

    // Leave the engagement as the later sections expect it.
    await call(alice, 'DELETE', `/audits/${auditId}/findings/${idC.body._id}`);
    await call(alice, 'DELETE', `/audits/${auditId}/findings/${idD.body._id}`);

    /* ------------------------------------------------- optimistic concurrency */
    log.info('Stale write (the data-loss bug)');
    const stamp = finding.body.updatedAt;

    const bobSaves = await call(bob, 'PUT', `/audits/${auditId}/findings/${findingId}`, {
      title: 'Stored XSS in the export view',
      description: '<p>Bob rewrote this</p>',
      expectedUpdatedAt: stamp,
    });
    check('first writer wins', bobSaves.status === 200, JSON.stringify(bobSaves.body));

    const aliceSaves = await call(alice, 'PUT', `/audits/${auditId}/findings/${findingId}`, {
      title: 'Stored XSS in the export view',
      description: '<p>Alice would have clobbered Bob</p>',
      expectedUpdatedAt: stamp,
    });
    check('second writer refused with 409', aliceSaves.status === 409, `got ${aliceSaves.status}`);
    check('conflict flagged', aliceSaves.body?.details?.conflict === true);
    check(
      'server copy returned with the conflict',
      aliceSaves.body?.details?.current?.description === '<p>Bob rewrote this</p>',
      JSON.stringify(aliceSaves.body?.details?.current?.description)
    );

    const forced = await call(alice, 'PUT', `/audits/${auditId}/findings/${findingId}`, {
      title: 'Stored XSS in the export view',
      description: '<p>Alice overwrote it deliberately</p>',
    });
    check('overwrite allowed without the token', forced.status === 200, JSON.stringify(forced.body));

    // Bob edited it earlier in this test; the author must not have changed.
    const authored = await call(alice, 'GET', `/audits/${auditId}`);
    const stored = authored.body?.findings?.find((f) => f._id === findingId);
    check(
      'editing does not rewrite who wrote it',
      stored?.createdBy?.username === alice.user.username,
      JSON.stringify(stored?.createdBy?.username)
    );
    check(
      'and the last editor is recorded separately',
      stored?.updatedBy?.username === alice.user.username,
      JSON.stringify(stored?.updatedBy?.username)
    );
    check(
      'the author is populated as a person, not an id',
      Boolean(stored?.createdBy?.firstname !== undefined),
      JSON.stringify(stored?.createdBy)
    );

    log.info('Details marker is independent of nested activity');
    const detailsSave = await call(alice, 'PUT', `/audits/${auditId}`, { reference: 'ZZ-TEST-2' });
    check('details saved', detailsSave.status === 200, JSON.stringify(detailsSave.body?.error));
    const marker = detailsSave.body?.detailsUpdatedAt;
    check('details marker set', Boolean(marker), JSON.stringify(marker));

    // Something nested changes, bumping the audit's own `updatedAt`…
    await call(bob, 'POST', `/audits/${auditId}/test-checks`, { title: 'Check TLS configuration' });

    const detailsAgain = await call(alice, 'PUT', `/audits/${auditId}`, {
      reference: 'ZZ-TEST-3',
      expectedUpdatedAt: marker,
    });
    check(
      '…which does not make the details form report a false conflict',
      detailsAgain.status === 200,
      `got ${detailsAgain.status}`
    );

    const staleDetails = await call(bob, 'PUT', `/audits/${auditId}`, {
      reference: 'ZZ-TEST-stale',
      expectedUpdatedAt: marker,
    });
    check(
      'but a genuinely stale details write is refused',
      staleDetails.status === 409,
      `got ${staleDetails.status}`
    );

    log.info('Sections and notes are guarded too');
    const section = await call(alice, 'POST', `/audits/${auditId}/sections`, {
      field: 'executive_summary',
      name: 'Executive summary',
    });
    const sectionStamp = section.body?.updatedAt;
    await call(bob, 'PUT', `/audits/${auditId}/sections/${section.body._id}`, {
      text: '<p>Bob wrote this</p>',
      expectedUpdatedAt: sectionStamp,
    });
    const staleSection = await call(alice, 'PUT', `/audits/${auditId}/sections/${section.body._id}`, {
      text: '<p>Alice would have clobbered it</p>',
      expectedUpdatedAt: sectionStamp,
    });
    check('stale section write refused', staleSection.status === 409, `got ${staleSection.status}`);

    const note = await call(alice, 'POST', `/audits/${auditId}/notes`, { title: 'Creds to try' });
    const noteStamp = note.body?.updatedAt;
    await call(bob, 'PUT', `/audits/${auditId}/notes/${note.body._id}`, {
      content: '<p>bob</p>',
      expectedUpdatedAt: noteStamp,
    });
    const staleNote = await call(alice, 'PUT', `/audits/${auditId}/notes/${note.body._id}`, {
      content: '<p>alice</p>',
      expectedUpdatedAt: noteStamp,
    });
    check('stale note write refused', staleNote.status === 409, `got ${staleNote.status}`);

    /* ------------------------------------------------------------- mentions */
    log.info('@mentions');
    const comment = await call(alice, 'POST', `/audits/${auditId}/findings/${findingId}/comments`, {
      body: `@${bob.user.username} can you retest this? cc @nobody-at-all`,
    });
    check('comment posted', comment.status === 201, JSON.stringify(comment.body));
    check(
      'known handle notified',
      comment.body?.mentioned?.includes(bob.user.username),
      JSON.stringify(comment.body?.mentioned)
    );
    check(
      'unknown handle reported, not invented',
      comment.body?.unknownMentions?.length === 1,
      JSON.stringify(comment.body?.unknownMentions)
    );

    const selfMention = await call(bob, 'POST', `/audits/${auditId}/findings/${findingId}/comments`, {
      body: `talking to myself, @${bob.user.username}`,
    });
    check(
      'mentioning yourself notifies nobody',
      selfMention.body?.mentioned?.length === 0,
      JSON.stringify(selfMention.body?.mentioned)
    );

    const bobsBell = await call(bob, 'GET', '/notifications');
    check('notification delivered', bobsBell.body?.unread === 1, JSON.stringify(bobsBell.body));
    const notification = bobsBell.body?.items?.[0];
    check(
      'notification names the finding',
      notification?.message?.includes('Stored XSS'),
      notification?.message
    );
    check('notification links back', notification?.href?.includes(auditId), notification?.href);

    const alicesBell = await call(alice, 'GET', '/notifications');
    check(
      'the author is not notified about their own comment',
      alicesBell.body?.unread === 0,
      JSON.stringify(alicesBell.body?.unread)
    );

    const read = await call(bob, 'POST', `/notifications/${notification._id}/read`, {});
    check('marked read', read.status === 200 && read.body?.read === true);
    const afterRead = await call(bob, 'GET', '/notifications/unread-count');
    check('badge cleared', afterRead.body?.unread === 0, JSON.stringify(afterRead.body));

    /* -------------------------------------------------- review notification */
    log.info('Review requested');
    await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'REVIEW' });
    const reviewBell = await call(bob, 'GET', '/notifications');
    check(
      'reviewer told the report is waiting on them',
      reviewBell.body?.items?.some((item) => item.type === 'review-requested'),
      JSON.stringify(reviewBell.body?.items?.map((i) => i.type))
    );

    /* --------------------------------------------------- inbox and insights */
    log.info('Inbox');
    // The engagement is in REVIEW at this point and Bob is a reviewer, Bob added a
    // check nobody ticked, and Bob commented on Alice's finding — so each side's
    // inbox should show a different set of things.
    const bobsInbox = await call(bob, 'GET', '/inbox');
    check('inbox loads', bobsInbox.status === 200, JSON.stringify(bobsInbox.body?.error));
    check(
      'a reviewer sees the engagement waiting on them',
      bobsInbox.body?.reviews?.some((r) => String(r.auditId) === auditId),
      JSON.stringify(bobsInbox.body?.reviews?.length)
    );
    check(
      'and their unticked check',
      bobsInbox.body?.checks?.some((c) => c.title === 'Check TLS configuration'),
      JSON.stringify(bobsInbox.body?.checks?.map((c) => c.title))
    );
    // Bob's only mention was marked read further up, and the bell still lists it.
    // The inbox used to drop read notifications entirely, so the two surfaces
    // disagreed about whether the mention had ever happened.
    const readMention = bobsInbox.body?.mentions?.find((m) => String(m._id) === String(notification._id));
    check(
      'a mention read from the bell is still listed in the inbox',
      Boolean(readMention),
      JSON.stringify(bobsInbox.body?.mentions?.map((m) => [m.type, m.read]))
    );
    check('and is listed as read, not as new', readMention?.read === true);
    check(
      'a read mention is not counted as waiting on you',
      bobsInbox.body?.counts?.mentions === 0,
      JSON.stringify(bobsInbox.body?.counts)
    );
    // Bob is a reviewer and the engagement is in REVIEW, so he has a
    // review-requested notification too. It belongs to the reviews section; listing
    // it under mentions as well counted one obligation twice.
    check(
      'the review notification is not double-counted under mentions',
      bobsInbox.body?.mentions?.every((m) => m.type === 'mention'),
      JSON.stringify(bobsInbox.body?.mentions?.map((m) => m.type))
    );

    const secondMention = await call(
      alice,
      'POST',
      `/audits/${auditId}/findings/${findingId}/comments`,
      { body: `@${bob.user.username} one more thing` }
    );
    check('second mention posted', secondMention.status === 201);
    const withUnread = await call(bob, 'GET', '/inbox');
    check(
      'an unread mention is counted',
      withUnread.body?.counts?.mentions === 1,
      JSON.stringify(withUnread.body?.counts)
    );
    check(
      'and sorts above the one already read',
      withUnread.body?.mentions?.[0]?.read === false,
      JSON.stringify(withUnread.body?.mentions?.map((m) => m.read))
    );
    await call(bob, 'POST', '/notifications/read-all', {});

    const alicesInbox = await call(alice, 'GET', '/inbox');
    check(
      'the finding author sees the unresolved comment on it',
      alicesInbox.body?.comments?.some((c) => c.findingId === findingId),
      JSON.stringify(alicesInbox.body?.comments?.length)
    );
    check(
      'and is not shown her own comments back',
      !alicesInbox.body?.comments?.some((c) => c.author?.username === alice.user.username)
    );
    check(
      'the author is not asked to review her own engagement',
      !alicesInbox.body?.reviews?.some((r) => String(r.auditId) === auditId),
      'creator was listed as a reviewer'
    );
    check(
      'counts match the lists, counting only unread mentions',
      bobsInbox.body?.counts?.total ===
        bobsInbox.body.reviews.length +
          bobsInbox.body.mentions.filter((m) => !m.read).length +
          bobsInbox.body.comments.length +
          bobsInbox.body.checks.length,
      JSON.stringify(bobsInbox.body?.counts)
    );

    /* ----------------------------------------- mentions outside comments --- */
    log.info('Mentions in notes, sections and checks');
    const handover = await call(alice, 'POST', `/audits/${auditId}/notes`, {
      title: 'Handover',
      content: `<p>@${bob.user.username} the creds are in the vault</p>`,
    });
    check(
      'a mention in a note notifies',
      handover.body?._mentions?.notified?.includes(bob.user.username),
      JSON.stringify(handover.body?._mentions)
    );
    const noteBell = await call(bob, 'GET', '/notifications?limit=5');
    check(
      'and says it was a note, linking to the notes tab',
      noteBell.body?.items?.[0]?.message?.includes('note') &&
        noteBell.body.items[0].href?.includes('tab=notes'),
      JSON.stringify(noteBell.body?.items?.[0])
    );

    // Saving the same note again must not notify the same person a second time.
    const noteAgain = await call(alice, 'PUT', `/audits/${auditId}/notes/${handover.body._id}`, {
      content: `<p>@${bob.user.username} the creds are in the vault, second floor</p>`,
    });
    check(
      'rewording around an existing mention does not notify again',
      (noteAgain.body?._mentions?.notified ?? []).length === 0,
      JSON.stringify(noteAgain.body?._mentions)
    );
    const noteNewName = await call(alice, 'PUT', `/audits/${auditId}/notes/${handover.body._id}`, {
      content: `<p>@${bob.user.username} and @nobody-at-all too</p>`,
    });
    check(
      'a handle added later is reported even when it matches no account',
      (noteNewName.body?._mentions?.notified ?? []).length === 0 &&
        noteNewName.body?._mentions?.unknown?.includes('nobody-at-all'),
      JSON.stringify(noteNewName.body?._mentions)
    );

    const sectionAdd = await call(alice, 'POST', `/audits/${auditId}/sections`, {
      field: 'zz_test_section',
      name: 'Test section',
      text: '<p>draft</p>',
    });
    const sectionMention = await call(
      alice,
      'PUT',
      `/audits/${auditId}/sections/${sectionAdd.body._id}`,
      { text: `<p>@${bob.user.username} please review this wording</p>` }
    );
    check(
      'a mention in a section notifies',
      sectionMention.body?._mentions?.notified?.includes(bob.user.username),
      JSON.stringify(sectionMention.body?._mentions)
    );

    const checkAdd = await call(alice, 'POST', `/audits/${auditId}/test-checks`, {
      title: 'Check the password reset flow',
    });
    const checkNote = await call(
      alice,
      'PUT',
      `/audits/${auditId}/test-checks/${checkAdd.body._id}`,
      { result: `looks odd, @${bob.user.username} can you confirm?` }
    );
    check(
      'a mention in a check result notifies',
      checkNote.body?._mentions?.notified?.includes(bob.user.username),
      JSON.stringify(checkNote.body?._mentions)
    );
    check('and the result is actually stored', checkNote.body?.result?.includes('looks odd'));

    // An email address is not a mention, in HTML or in plain text.
    const emailNote = await call(alice, 'POST', `/audits/${auditId}/notes`, {
      title: 'Contact',
      content: `<p>write to ${bob.user.username}@example.invalid</p>`,
    });
    check(
      'an email address does not mention anybody',
      (emailNote.body?._mentions?.notified ?? []).length === 0,
      JSON.stringify(emailNote.body?._mentions)
    );
    await call(alice, 'DELETE', `/audits/${auditId}/notes/${emailNote.body._id}`);
    await call(alice, 'POST', '/notifications/read-all', {});

    /* ------------------------------------- the same issue, seen again -------- */
    log.info('Repeat findings across a client');
    const { Company: RepeatCo } = await import('../models/company.model.js');
    const repeatCompany = await RepeatCo.create({
      name: 'zz Repeat Client',
      createdBy: alice.user._id,
    });

    const makeEngagement = async (name, reference, dates, title, status) => {
      const made = await call(alice, 'POST', '/audits', {
        name,
        reference,
        company: repeatCompany._id.toString(),
        ...dates,
      });
      const added = await call(alice, 'POST', `/audits/${made.body._id}/findings`, {
        title,
        description:
          '<p>seen</p><figure><img src="/api/media/x" alt="s.png"><figcaption>the request</figcaption></figure>',
        remediationStatus: status,
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      });
      return { auditId: made.body._id, findingId: added.body._id };
    };

    // Last year's assessment and this year's, with the same weakness worded around a
    // different location — which is how it actually turns up in two reports.
    const lastYear = await makeEngagement(
      'zz Repeat — 2025 assessment',
      'ZZ-2025-01',
      { date_start: '2025-03-01', date_end: '2025-03-14' },
      'Stored XSS (export view)',
      'open'
    );
    const thisYear = await makeEngagement(
      'zz Repeat — 2026 assessment',
      'ZZ-2026-01',
      { date_start: '2026-03-01', date_end: '2026-03-14' },
      'Stored XSS (admin search)',
      'open'
    );

    const repeatHistory = await call(alice, 'GET', `/audits/${thisYear.auditId}/history`);
    const seenBefore = repeatHistory.body?.byFinding?.[thisYear.findingId] ?? [];
    check(
      'this year knows the same issue was reported last year',
      seenBefore.length === 1 && seenBefore[0].reference === 'ZZ-2025-01',
      JSON.stringify(repeatHistory.body)
    );
    check(
      'with the status it had then',
      seenBefore[0]?.remediationStatus === 'open',
      JSON.stringify(seenBefore[0])
    );

    const backwards = await call(alice, 'GET', `/audits/${lastYear.auditId}/history`);
    check(
      'and last year is not told about a test that happened afterwards',
      Object.keys(backwards.body?.byFinding ?? {}).length === 0,
      JSON.stringify(backwards.body)
    );

    const clientPage = await call(alice, 'GET', `/data/companies/${repeatCompany._id}/overview`);
    const recurringList = clientPage.body?.recurring ?? [];
    check(
      'the client page lists it as recurring',
      recurringList.length === 1 && recurringList[0].engagementCount === 2,
      JSON.stringify(recurringList.map((r) => [r.title, r.engagementCount]))
    );
    check(
      'and says they still have it',
      recurringList[0]?.stillOpen === true && clientPage.body?.totals?.recurringOpen === 1,
      JSON.stringify(clientPage.body?.totals)
    );

    const repeatReport = await call(alice, 'GET', `/audits/${thisYear.auditId}/report-data`);
    check(
      'the report can say so',
      repeatReport.body?.findings?.[0]?.previouslyReported === true &&
        repeatReport.body.findings[0].previouslyIn === 'ZZ-2025-01',
      JSON.stringify(repeatReport.body?.findings?.[0]?.previouslyIn)
    );
    check(
      'and counts the repeats',
      repeatReport.body?.stats?.repeats === 1 && repeatReport.body?.hasRepeats === true,
      JSON.stringify(repeatReport.body?.stats?.repeats)
    );

    // Figures, on the same report: the caption is numbered against the finding.
    check(
      'a captioned screenshot is numbered as a figure',
      repeatReport.body?.findings?.[0]?.rich?.description?.includes('Figure 1.1 — the request'),
      JSON.stringify(repeatReport.body?.findings?.[0]?.rich?.description?.slice(0, 200))
    );
    check(
      'and the caption survives into the plain-text field',
      repeatReport.body?.findings?.[0]?.description?.includes('Figure 1.1 — the request'),
      JSON.stringify(repeatReport.body?.findings?.[0]?.description)
    );

    // History must not leak engagements the caller cannot see.
    await call(alice, 'PUT', `/audits/${thisYear.auditId}`, {
      collaborators: [bob.user._id.toString()],
    });
    const bobsHistory = await call(bob, 'GET', `/audits/${thisYear.auditId}/history`);
    check(
      'somebody who was not on last year’s engagement is told nothing about it',
      bobsHistory.status === 200 && Object.keys(bobsHistory.body?.byFinding ?? {}).length === 0,
      JSON.stringify(bobsHistory.body)
    );

    await Audit.deleteMany({ _id: { $in: [lastYear.auditId, thisYear.auditId] } });
    await RepeatCo.deleteOne({ _id: repeatCompany._id });

    log.info('Insights');
    const insights = await call(alice, 'GET', '/insights?days=365');
    check('insights loads', insights.status === 200, JSON.stringify(insights.body?.error));
    check(
      'it counts this engagement and finding',
      insights.body?.totals?.engagements >= 1 && insights.body?.totals?.findings >= 1
    );
    check(
      'the month series is gapless and starts at real data',
      Array.isArray(insights.body?.trend) && insights.body.trend.length >= 1,
      JSON.stringify(insights.body?.trend?.length)
    );
    check(
      'severity totals and the trend agree',
      insights.body.trend.reduce((sum, row) => sum + row.total, 0) === insights.body.totals.findings,
      `${insights.body.trend.reduce((sum, row) => sum + row.total, 0)} vs ${insights.body.totals.findings}`
    );
    check(
      'status totals add up to the finding count',
      insights.body.byStatus.open + insights.body.byStatus.retesting + insights.body.byStatus.fixed ===
        insights.body.totals.findings
    );
    check(
      'categories fold their tail into one row rather than more colours',
      insights.body.categories.filter((c) => c.isTail).length <= 1
    );

    // Insights must never reach past what the caller may see.
    const { User: UserModel } = await import('../models/user.model.js');
    const outsider = await makeUser('outsider', 'user');
    const theirInsights = await call(outsider, 'GET', '/insights?days=365');
    check(
      'someone with no engagements sees nothing, not everything',
      theirInsights.body?.totals?.findings === 0,
      JSON.stringify(theirInsights.body?.totals)
    );
    const theirInbox = await call(outsider, 'GET', '/inbox');
    check('and an empty inbox', theirInbox.body?.counts?.total === 0);
    await UserModel.deleteOne({ _id: outsider.user._id });

    /* ------------------------------------------------- report recipients --- */
    log.info('Report recipients');
    const { Client: Contacts } = await import('../models/client.model.js');
    const { Company: Companies } = await import('../models/company.model.js');
    const recipientCompany = await Companies.create({
      name: 'zz Recipient Co',
      createdBy: alice.user._id,
    });
    const [one, two] = await Contacts.create([
      { email: 'zz-r1@example.invalid', firstname: 'Rae', lastname: 'One', company: recipientCompany._id, createdBy: alice.user._id },
      { email: 'zz-r2@example.invalid', firstname: 'Sam', lastname: 'Two', company: recipientCompany._id, createdBy: alice.user._id },
    ]);

    const withPrimary = await call(alice, 'PUT', `/audits/${auditId}`, {
      company: recipientCompany._id.toString(),
      client: one._id.toString(),
    });
    check(
      'a primary contact becomes a one-entry recipient list',
      (withPrimary.body?.recipients ?? []).length === 1,
      JSON.stringify((withPrimary.body?.recipients ?? []).map((r) => r.email))
    );

    const withBoth = await call(alice, 'PUT', `/audits/${auditId}`, {
      recipients: [two._id.toString(), one._id.toString()],
      client: one._id.toString(),
    });
    check(
      'the primary is kept first however the list was ordered',
      withBoth.body?.recipients?.[0]?.email === 'zz-r1@example.invalid',
      JSON.stringify(withBoth.body?.recipients?.map((r) => r.email))
    );
    check('and everyone else follows', withBoth.body?.recipients?.length === 2);

    const promoted = await call(alice, 'PUT', `/audits/${auditId}`, {
      client: null,
      recipients: [two._id.toString()],
    });
    check(
      'a list with no primary promotes its first entry',
      promoted.body?.client?.email === 'zz-r2@example.invalid',
      JSON.stringify(promoted.body?.client?.email)
    );

    const listBefore = (promoted.body?.recipients ?? []).map((r) => r._id);
    const detailsOnly = await call(alice, 'PUT', `/audits/${auditId}`, { reference: 'ZZ-TEST' });
    check(
      'a save that does not mention them leaves the list alone',
      JSON.stringify((detailsOnly.body?.recipients ?? []).map((r) => r._id)) ===
        JSON.stringify(listBefore),
      JSON.stringify((detailsOnly.body?.recipients ?? []).map((r) => r.email))
    );

    const reportData = await call(alice, 'GET', `/audits/${auditId}/report-data`);
    check(
      'templates get a recipients loop',
      Array.isArray(reportData.body?.recipients) && reportData.body.recipients.length >= 1,
      JSON.stringify(reportData.body?.recipients?.map((r) => r.fullname))
    );
    check(
      'and a one-line list for a sentence',
      typeof reportData.body?.recipientNames === 'string' &&
        reportData.body.recipientNames.includes('Sam Two'),
      JSON.stringify(reportData.body?.recipientNames)
    );
    check(
      'and addresses ready for an email header',
      reportData.body?.recipientEmails?.includes('zz-r2@example.invalid'),
      JSON.stringify(reportData.body?.recipientEmails)
    );

    /* ------------------------------------------------- what each of them is --- */
    {
      const roled = await call(alice, 'PUT', `/audits/${auditId}`, {
        client: one._id.toString(),
        recipients: [one._id.toString(), two._id.toString()],
        recipientRoles: [
          { client: one._id.toString(), role: 'signatory' },
          { client: two._id.toString(), role: 'cc' },
        ],
      });
      const roleOf = (id) =>
        (roled.body?.recipientRoles ?? []).find(
          (entry) => String(entry.client?._id ?? entry.client) === String(id)
        )?.role;
      check(
        'a recipient can be what they actually are',
        roleOf(one._id) === 'signatory' && roleOf(two._id) === 'cc',
        JSON.stringify(roled.body?.recipientRoles)
      );

      const nonsense = await call(alice, 'PUT', `/audits/${auditId}`, {
        recipientRoles: [{ client: one._id.toString(), role: 'chief vibes officer' }],
      });
      check('an invented role is refused', nonsense.status === 422, `got ${nonsense.status}`);

      // Roles describe the list, so they cannot outlive it.
      const dropped = await call(alice, 'PUT', `/audits/${auditId}`, {
        client: one._id.toString(),
        recipients: [one._id.toString()],
      });
      check(
        'dropping a recipient drops what they were',
        (dropped.body?.recipientRoles ?? []).length === 1 &&
          String(dropped.body.recipientRoles[0].client?._id ?? dropped.body.recipientRoles[0].client) ===
            String(one._id),
        JSON.stringify(dropped.body?.recipientRoles)
      );
      check(
        'and the one that remains keeps its role',
        dropped.body?.recipientRoles?.[0]?.role === 'signatory',
        JSON.stringify(dropped.body?.recipientRoles?.[0])
      );

      const readded = await call(alice, 'PUT', `/audits/${auditId}`, {
        client: one._id.toString(),
        recipients: [one._id.toString(), two._id.toString()],
      });
      check(
        'somebody added without a role is a technical contact, as everybody was before roles',
        (readded.body?.recipientRoles ?? []).find(
          (entry) => String(entry.client?._id ?? entry.client) === String(two._id)
        )?.role === 'technical',
        JSON.stringify(readded.body?.recipientRoles)
      );

      const withRoles = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'every recipient reaches a template with its role in words',
        (withRoles.body?.recipients ?? []).every((person) => person.role && person.roleLabel),
        JSON.stringify(withRoles.body?.recipients?.map((r) => [r.fullname, r.role, r.roleLabel]))
      );
      check(
        'the signatories are their own loop, for an acceptance block',
        withRoles.body?.hasSignatories === true &&
          (withRoles.body?.signatories ?? []).length === 1 &&
          withRoles.body.signatories[0].email === 'zz-r1@example.invalid',
        JSON.stringify(withRoles.body?.signatories?.map((r) => r.email))
      );
      check(
        'and so are the technical contacts',
        (withRoles.body?.technicalRecipients ?? []).length === 1 &&
          withRoles.body.technicalRecipients[0].email === 'zz-r2@example.invalid',
        JSON.stringify(withRoles.body?.technicalRecipients?.map((r) => r.email))
      );

      // A copy of the engagement is a copy of the distribution list, roles and all.
      const copy = await call(alice, 'POST', `/audits/${auditId}/duplicate`, {
        name: 'zz-roles copy',
      });
      check(
        'a duplicate carries the roles with the recipients',
        (copy.body?.audit?.recipientRoles ?? []).some((entry) => entry.role === 'signatory'),
        JSON.stringify(copy.body?.audit?.recipientRoles)
      );
      await Audit.deleteMany({ name: /^zz-roles/ });
    }

    // Put the engagement back the way the later sections expect it.
    await call(alice, 'PUT', `/audits/${auditId}`, { client: null, recipients: [] });
    await Contacts.deleteMany({ _id: { $in: [one._id, two._id] } });
    await Companies.deleteOne({ _id: recipientCompany._id });

    /* --------------------------------------------------------- checklists -- */
    log.info('Checklists');
    const library = await call(alice, 'GET', '/checklists');
    check('the library lists checklists', library.status === 200 && Array.isArray(library.body));
    check(
      'the shipped methodologies are there as data',
      library.body.filter((c) => c.builtin).length >= 4,
      `${library.body.filter((c) => c.builtin).length} builtin`
    );
    const web = library.body.find((c) => c.slug === 'web');
    check('with their checks', web?.count > 20, JSON.stringify(web?.count));
    check('and their categories', web?.categories?.length > 3, JSON.stringify(web?.categories?.length));

    const made = await call(alice, 'POST', '/checklists', {
      name: 'zz Mobile (iOS)',
      description: 'Own methodology',
    });
    check('a team can create their own', made.status === 201, JSON.stringify(made.body?.error));
    const listId = made.body?._id;
    check('a created checklist is not marked built in', made.body?.builtin === false);

    const added = await call(alice, 'POST', `/checklists/${listId}/checks`, {
      title: 'Check keychain storage',
      category: 'Storage',
    });
    check('checks can be added', added.status === 201 && added.body?.title === 'Check keychain storage');

    // Pasting a methodology in, with headings and bullets, is the realistic path.
    const bulk = await call(alice, 'POST', `/checklists/${listId}/checks/bulk`, {
      text: [
        'Transport:',
        '- Verify certificate pinning',
        '* Check for cleartext traffic',
        // Same title again under the same heading: that is a duplicate.
        '- Verify certificate pinning',
        '[Runtime]',
        '1. Test jailbreak detection',
        '2. Check anti-debugging',
        '',
      ].join('\n'),
    });
    check('a pasted list is parsed', bulk.body?.added === 4, JSON.stringify(bulk.body?.added));
    check('duplicates in the paste are skipped', bulk.body?.skipped === 1, JSON.stringify(bulk.body?.skipped));

    const detail = await call(alice, 'GET', `/checklists/${listId}`);
    const cats = [...new Set(detail.body.checks.map((c) => c.category))];
    check(
      'headings became categories, bullets were stripped',
      cats.includes('Transport') && cats.includes('Runtime') &&
        detail.body.checks.some((c) => c.title === 'Verify certificate pinning'),
      JSON.stringify(cats)
    );
    check('order is dense', detail.body.checks.every((c, i) => c.order === i));

    const edited = await call(alice, 'PUT', `/checklists/${listId}/checks/${added.body._id}`, {
      title: 'Check keychain storage flags',
    });
    check('a check can be edited', edited.body?.title === 'Check keychain storage flags');

    const removed = await call(alice, 'DELETE', `/checklists/${listId}/checks/${added.body._id}`);
    check('a check can be deleted', removed.status === 200 && removed.body?.remaining === 4);

    const afterDelete = await call(alice, 'GET', `/checklists/${listId}`);
    check(
      'order stays dense after a delete',
      afterDelete.body.checks.every((c, i) => c.order === i)
    );

    const prune = await call(alice, 'DELETE', `/checklists/${listId}/categories/Runtime`);
    check('a whole category can be pruned', prune.body?.removed === 2, JSON.stringify(prune.body));

    // The engagement picker and the library must be the same set of things.
    const picker = await call(alice, 'GET', '/audits/test-check-presets');
    check(
      'the engagement picker sees custom checklists too',
      picker.body?.some((p) => String(p.id) === listId),
      'a team checklist was missing from the engagement picker'
    );

    const applied = await call(alice, 'POST', `/audits/${auditId}/test-checks/preset`, {
      preset: listId,
    });
    check('a custom checklist can be applied to an engagement', applied.body?.added === 2, JSON.stringify(applied.body?.added));

    // The old slug-based contract still has to work.
    const bySlug = await call(alice, 'POST', `/audits/${auditId}/test-checks/preset`, {
      preset: 'reporting',
    });
    check('the old slug still resolves', bySlug.body?.added > 0, JSON.stringify(bySlug.body));

    // Ticking a methodology item from the checklist library, against an engagement.
    const brandNew = await call(bob, 'POST', `/audits/${auditId}/test-checks/toggle`, {
      title: 'Verify certificate pinning',
      category: 'Transport',
      done: true,
    });
    check(
      'ticking a check the engagement lacks adds it, verified',
      brandNew.body?.created === false && brandNew.body?.check?.done === true,
      JSON.stringify({ created: brandNew.body?.created, done: brandNew.body?.check?.done })
    );
    check(
      'and records who verified it',
      brandNew.body?.check?.doneBy?.username === bob.user.username,
      JSON.stringify(brandNew.body?.check?.doneBy?.username)
    );

    const absent = await call(bob, 'POST', `/audits/${auditId}/test-checks/toggle`, {
      title: 'zz Not on the engagement yet',
      category: 'Transport',
      done: true,
    });
    check('an item not yet on the engagement is created and ticked', absent.body?.created === true);

    const untick = await call(bob, 'POST', `/audits/${auditId}/test-checks/toggle`, {
      title: 'zz Not on the engagement yet',
      category: 'Transport',
      done: false,
    });
    check(
      'un-ticking clears the verifier rather than leaving a stale name',
      untick.body?.check?.done === false && !untick.body?.check?.doneBy
    );
    check(
      'and toggling does not duplicate the check',
      untick.body?.created === false,
      'a second toggle created a duplicate'
    );

    const ticks = await call(alice, 'GET', `/audits/${auditId}/activity`);
    check(
      'ticking from the library is in the activity log',
      (ticks.body?.entries ?? []).some((e) => e.action === 'check.ticked'),
      JSON.stringify((ticks.body?.entries ?? []).map((e) => e.action).slice(0, 6))
    );

    // Two people editing the same check: the second must be refused, not silently win.
    log.info('Checklist conflicts');
    const target = (await call(alice, 'GET', `/checklists/${listId}`)).body.checks[0];
    const firstEdit = await call(alice, 'PUT', `/checklists/${listId}/checks/${target._id}`, {
      title: 'Rewritten first',
      expectedUpdatedAt: target.updatedAt,
    });
    check('the first writer wins', firstEdit.status === 200, JSON.stringify(firstEdit.body?.error));

    const staleEdit = await call(bob, 'PUT', `/checklists/${listId}/checks/${target._id}`, {
      title: 'Would have clobbered it',
      expectedUpdatedAt: target.updatedAt,
    });
    check('a stale check edit is refused', staleEdit.status === 409, `got ${staleEdit.status}`);
    check(
      'and the current wording comes back with the refusal',
      staleEdit.body?.details?.current?.title === 'Rewritten first',
      JSON.stringify(staleEdit.body?.details?.current?.title)
    );

    const otherCheck = (await call(alice, 'GET', `/checklists/${listId}`)).body.checks[1];
    const parallelEdit = await call(bob, 'PUT', `/checklists/${listId}/checks/${otherCheck._id}`, {
      title: 'A different check entirely',
      expectedUpdatedAt: otherCheck.updatedAt,
    });
    check(
      'editing a different check in the same checklist is not a conflict',
      parallelEdit.status === 200,
      `got ${parallelEdit.status}`
    );

    const listNow = (await call(alice, 'GET', `/checklists/${listId}`)).body;
    const renamed = await call(alice, 'PUT', `/checklists/${listId}`, {
      name: 'zz Mobile (iOS) v2',
      expectedUpdatedAt: listNow.detailsUpdatedAt ?? undefined,
    });
    check('a rename is accepted', renamed.status === 200, JSON.stringify(renamed.body?.error));

    // A colleague adding a check must not block a subsequent rename.
    await call(bob, 'POST', `/checklists/${listId}/checks`, { title: 'zz added meanwhile' });
    const renameAgain = await call(alice, 'PUT', `/checklists/${listId}`, {
      name: 'zz Mobile (iOS) v3',
      expectedUpdatedAt: renamed.body.detailsUpdatedAt,
    });
    check(
      'a concurrent check addition does not block a rename',
      renameAgain.status === 200,
      `got ${renameAgain.status}`
    );
    const staleRename = await call(bob, 'PUT', `/checklists/${listId}`, {
      name: 'zz stale rename',
      expectedUpdatedAt: renamed.body.detailsUpdatedAt,
    });
    check('but a genuinely stale rename is refused', staleRename.status === 409, `got ${staleRename.status}`);

    const dup = await call(alice, 'POST', `/checklists/${listId}/duplicate`, {});
    check('a checklist can be duplicated', dup.status === 201 && dup.body?.name.endsWith('(copy)'));
    check('a copy is not built in and has no slug', dup.body?.builtin === false && !dup.body?.slug);

    const outsider3 = await makeUser('outsider3', 'user');
    const theirDelete = await call(outsider3, 'DELETE', `/checklists/${listId}`);
    check(
      'someone else cannot delete your checklist',
      theirDelete.status === 403,
      `got ${theirDelete.status}`
    );
    const { User: U2 } = await import('../models/user.model.js');
    await U2.deleteOne({ _id: outsider3.user._id });

    const { Checklist } = await import('../models/checklist.model.js');
    await Checklist.deleteMany({ _id: { $in: [listId, dup.body?._id].filter(Boolean) } });

    /* ------------------------------------------------------ client overview */
    log.info('Client page');
    const { Company } = await import('../models/company.model.js');
    // Created through the API so ownership is stamped, as it would be in the app.
    const madeCompany = await call(alice, 'POST', '/data/companies', {
      name: 'zz Collab Client Ltd',
      shortName: 'zzCollab',
    });
    check('a company can be created', madeCompany.status === 201, JSON.stringify(madeCompany.body?.error));
    const company = { _id: madeCompany.body._id };
    check(
      'and is owned by whoever added it',
      String(madeCompany.body.createdBy) === alice.user._id.toString(),
      JSON.stringify(madeCompany.body.createdBy)
    );

    const madeContact = await call(alice, 'POST', '/data/clients', {
      email: 'zz-collab-contact@example.invalid',
      firstname: 'Zoë',
      lastname: 'Contact',
      company: company._id,
    });
    check('a contact can be created', madeContact.status === 201, JSON.stringify(madeContact.body?.error));

    await call(alice, 'PUT', `/audits/${auditId}`, { company: company._id });

    const overview = await call(alice, 'GET', `/data/companies/${company._id}/overview`);
    check('client overview loads', overview.status === 200, JSON.stringify(overview.body?.error));
    check('it names the client', overview.body?.company?.name === 'zz Collab Client Ltd');
    check(
      'and lists the engagements run for them',
      overview.body?.engagements?.some((e) => e._id === auditId),
      JSON.stringify(overview.body?.engagements?.map((e) => e.name))
    );
    check(
      'each engagement carries its own rollup',
      overview.body.engagements[0]?.findingCount >= 1 &&
        overview.body.engagements[0]?.severityCounts !== undefined &&
        overview.body.engagements[0]?.remediation !== undefined
    );
    check(
      'the rollup does not ship the findings themselves',
      overview.body.engagements[0]?.findings === undefined,
      'findings were included in the client overview payload'
    );
    check(
      'totals sum the engagements',
      overview.body.totals.findings ===
        overview.body.engagements.reduce((sum, e) => sum + e.findingCount, 0)
    );

    /* -------------------------------------------- client visibility -------- */
    log.info('A client is only visible to people who work with them');
    const outsider2 = await makeUser('outsider2', 'user');

    // Bob is a collaborator on the engagement, so the client is his business.
    const bobsCompanies = await call(bob, 'GET', '/data/companies');
    check(
      'a colleague on the engagement sees the client',
      bobsCompanies.body?.some((c) => c._id === company._id),
      JSON.stringify(bobsCompanies.body?.map((c) => c.name))
    );

    const theirCompanies = await call(outsider2, 'GET', '/data/companies');
    check(
      'someone not on any engagement for them does not',
      !theirCompanies.body?.some((c) => c._id === company._id),
      JSON.stringify(theirCompanies.body?.map((c) => c.name))
    );

    const theirContacts = await call(outsider2, 'GET', '/data/clients');
    check(
      'nor the contacts at that client',
      !theirContacts.body?.some((c) => c.email === 'zz-collab-contact@example.invalid'),
      JSON.stringify(theirContacts.body?.map((c) => c.email))
    );

    // The list being filtered is not a control on its own — the id must be refused too.
    const readDirect = await call(outsider2, 'GET', `/data/companies/${company._id}`);
    check('reading the client by id is refused', readDirect.status === 404, `got ${readDirect.status}`);

    const editDirect = await call(outsider2, 'PUT', `/data/companies/${company._id}`, {
      name: 'zz renamed by an outsider',
    });
    check('editing it is refused', editDirect.status === 404, `got ${editDirect.status}`);

    const theirOverview = await call(outsider2, 'GET', `/data/companies/${company._id}/overview`);
    check(
      'and the client page does not confirm they exist',
      theirOverview.status === 404,
      `got ${theirOverview.status}`
    );

    // Search must not be a way around the same rule.
    const theirSearch = await call(outsider2, 'GET', '/search?q=Contact');
    check(
      'search does not surface the contact either',
      !(theirSearch.body?.results ?? []).some((r) => r.type === 'client'),
      JSON.stringify((theirSearch.body?.results ?? []).map((r) => `${r.type}:${r.title}`))
    );
    const alicesSearch = await call(alice, 'GET', '/search?q=Contact');
    check(
      'but it still finds it for someone who works with them',
      (alicesSearch.body?.results ?? []).some((r) => r.type === 'client'),
      JSON.stringify((alicesSearch.body?.results ?? []).map((r) => `${r.type}:${r.title}`))
    );

    // A client you have just added, before it has any engagement, must stay visible —
    // otherwise adding one and then using it would be impossible.
    const fresh = await call(outsider2, 'POST', '/data/companies', { name: 'zz Their Own Client' });
    const afterCreate = await call(outsider2, 'GET', '/data/companies');
    check(
      'a client you created yourself is visible before any engagement exists',
      afterCreate.body?.some((c) => c._id === fresh.body._id),
      JSON.stringify(afterCreate.body?.map((c) => c.name))
    );
    check(
      'and is not visible to an unrelated colleague',
      !(await call(bob, 'GET', '/data/companies')).body?.some((c) => c._id === fresh.body._id)
    );

    const adminView = await call(alice, 'GET', '/data/companies');
    check(
      'an admin sees every client',
      adminView.body?.some((c) => c._id === fresh.body._id) &&
        adminView.body?.some((c) => c._id === company._id),
      'alice is an admin in this suite'
    );

    await Company.deleteOne({ _id: fresh.body._id });
    await UserModel.deleteOne({ _id: outsider2.user._id });
    const { Client: ClientModel } = await import('../models/client.model.js');
    await ClientModel.deleteOne({ email: 'zz-collab-contact@example.invalid' });
    await Company.deleteOne({ _id: company._id });

    /* ------------------------------------------------------- white-labelling */
    log.info('Branding');
    const { Settings: SettingsModel } = await import('../models/settings.model.js');
    const settingsNow = await SettingsModel.getSettings();
    const originalBranding = {
      appName: settingsNow.branding?.appName,
      tagline: settingsNow.branding?.tagline,
      logo: settingsNow.branding?.logo ?? '',
    };

    const anonStatus = await fetch(`${base}/auth/status`).then((r) => r.json());
    check(
      'the sign-in screen can read the branding with no session',
      Boolean(anonStatus?.branding?.appName),
      JSON.stringify(anonStatus?.branding?.appName)
    );
    check(
      'and nothing else from Settings is public',
      !JSON.stringify(anonStatus).includes('cvssColors') &&
        Object.keys(anonStatus).join() ===
          'registrationOpen,needsBootstrap,approvalRequired,userCount,branding',
      Object.keys(anonStatus).join()
    );

    const rebrandDenied = await call(bob, 'PUT', '/settings', {
      branding: { appName: 'zz not allowed' },
    });
    check('a non-admin cannot rebrand the instance', rebrandDenied.status === 403, `got ${rebrandDenied.status}`);

    const rebranded = await call(alice, 'PUT', '/settings', {
      branding: { appName: 'zz Rebranded', tagline: 'zz tagline' },
    });
    check('an admin can', rebranded.status === 200, JSON.stringify(rebranded.body?.error));
    const afterStatus = await fetch(`${base}/auth/status`).then((r) => r.json());
    check(
      'and it is public immediately',
      afterStatus?.branding?.appName === 'zz Rebranded',
      JSON.stringify(afterStatus?.branding?.appName)
    );

    const badLogo = await call(alice, 'PUT', '/settings', {
      branding: { logo: 'data:text/html,<script>alert(1)</script>' },
    });
    check('a logo that is not an image is refused', badLogo.status === 422, `got ${badLogo.status}`);

    const restore = await SettingsModel.getSettings();
    restore.branding = originalBranding;
    await restore.save();

    /* ------------------------------------------------- admin team overview -- */
    log.info('Team overview (admin only)');
    const denied = await call(bob, 'GET', '/users/engagements');
    check('a non-admin cannot read it', denied.status === 403, `got ${denied.status}`);

    const overview2 = await call(alice, 'GET', '/users/engagements');
    check('an admin can', overview2.status === 200, JSON.stringify(overview2.body?.error));

    const alicesRow = overview2.body?.users?.find((u) => u.username === alice.user.username);
    check(
      'it lists the engagements a person is on',
      alicesRow?.engagements?.some((e) => e.id === auditId),
      JSON.stringify(alicesRow?.engagements?.map((e) => e.name))
    );
    check(
      'with the roles they hold on each',
      alicesRow?.engagements
        ?.find((e) => e.id === auditId)
        ?.roles?.includes('creator'),
      JSON.stringify(alicesRow?.engagements?.find((e) => e.id === auditId)?.roles)
    );
    check(
      'and counts the findings they wrote',
      alicesRow?.findingsCreated >= 1,
      JSON.stringify(alicesRow?.findingsCreated)
    );

    const bobsRow = overview2.body?.users?.find((u) => u.username === bob.user.username);
    check(
      'a collaborator who wrote nothing counts zero, not blank',
      bobsRow?.findingsCreated === 0,
      JSON.stringify(bobsRow?.findingsCreated)
    );

    const thisEngagement = overview2.body?.engagements?.find((e) => e.id === auditId);
    check(
      'the by-engagement view lists its members',
      thisEngagement?.members?.some((m) => m.username === alice.user.username) &&
        thisEngagement?.members?.some((m) => m.username === bob.user.username),
      JSON.stringify(thisEngagement?.members?.map((m) => m.username))
    );
    check(
      'per-engagement finding counts add up to the total',
      thisEngagement?.members?.reduce((sum, m) => sum + m.findingsCreated, 0) <=
        thisEngagement?.findingCount,
      JSON.stringify({
        summed: thisEngagement?.members?.reduce((sum, m) => sum + m.findingsCreated, 0),
        total: thisEngagement?.findingCount,
      })
    );
    check(
      'unattributed findings are reported rather than hidden',
      typeof overview2.body?.totals?.unattributedFindings === 'number'
    );

    /* --------------------------------------------------------- activity log */
    log.info('Activity log');
    const activity = await call(alice, 'GET', `/audits/${auditId}/activity`);
    const actions = (activity.body?.entries ?? []).map((entry) => entry.action);
    check('log is populated', actions.length >= 6, `${actions.length} entries`);
    for (const expected of [
      'audit.created',
      'finding.created',
      'finding.updated',
      'comment.added',
      'audit.state',
    ]) {
      check(`logged ${expected}`, actions.includes(expected), actions.join(', '));
    }
    check(
      'newest first',
      new Date(activity.body.entries[0].createdAt) >=
        new Date(activity.body.entries.at(-1).createdAt)
    );
    const withActor = activity.body.entries.find((entry) => entry.action === 'finding.updated');
    check('entries say who', Boolean(withActor?.actor?.username), JSON.stringify(withActor?.actor));
    check('entries read as sentences', /edited the finding/.test(withActor?.summary), withActor?.summary);
    check(
      'entries say which fields changed',
      (withActor?.fields ?? []).includes('description'),
      JSON.stringify(withActor?.fields)
    );

    /* ------------------------------------------------------- finding locks --- */
    log.info('Locking a finding against everybody else');
    {
      /*
       * On its own finding, deliberately. The first version of this block reused the one the
       * conflict checks below depend on, and every write here moved its `updatedAt` — so the
       * stale-write test started failing for a reason that had nothing to do with stale writes.
       */
      const target = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz lock target',
        description: '<p>held</p>',
      });
      const lockedId = target.body?._id;
      check('a finding to lock', target.status === 201, JSON.stringify(target.body));

      const taken = await call(alice, 'POST', `/audits/${auditId}/findings/${lockedId}/lock`, {
        note: 'rewriting the impact',
      });
      check('a finding can be locked', taken.status === 200, JSON.stringify(taken.body));
      check(
        'and the lock names its holder and what they are doing',
        taken.body?.lock?.by?.username === alice.user.username &&
          taken.body?.lock?.note === 'rewriting the impact',
        JSON.stringify(taken.body?.lock)
      );

      const bobReads = await call(bob, 'GET', `/audits/${auditId}`);
      check(
        'somebody else can still read a locked finding',
        bobReads.status === 200 &&
          (bobReads.body?.findings ?? []).some((f) => String(f._id) === String(lockedId)),
        `got ${bobReads.status}`
      );

      const bobWrites = await call(bob, 'PUT', `/audits/${auditId}/findings/${lockedId}`, {
        title: 'Bob got in first',
      });
      check(
        'and cannot write to it',
        bobWrites.status === 423,
        `got ${bobWrites.status}: ${JSON.stringify(bobWrites.body)}`
      );
      check(
        'the refusal names who holds it',
        String(bobWrites.body?.error ?? '').includes('Collab') &&
          bobWrites.body?.details?.locked === true,
        JSON.stringify(bobWrites.body)
      );

      const bobDeletes = await call(bob, 'DELETE', `/audits/${auditId}/findings/${lockedId}`);
      check('nor delete it', bobDeletes.status === 423, `got ${bobDeletes.status}`);

      const bobMerges = await call(bob, 'POST', `/audits/${auditId}/findings/${findingId}/merge`, {
        from: lockedId,
      });
      check(
        'nor fold it into another finding',
        bobMerges.status === 423,
        `got ${bobMerges.status}: ${JSON.stringify(bobMerges.body?.error)}`
      );

      const bobComments = await call(bob, 'POST', `/audits/${auditId}/findings/${lockedId}/comments`, {
        body: 'Worth checking the mail host too.',
      });
      check(
        'but a comment is still allowed — a lock is about the write-up, not the conversation',
        bobComments.status === 201,
        `got ${bobComments.status}: ${JSON.stringify(bobComments.body)}`
      );

      const holderWrites = await call(alice, 'PUT', `/audits/${auditId}/findings/${lockedId}`, {
        title: 'zz lock target',
        observation: '<p>rewritten by the holder</p>',
      });
      check(
        'the holder writes as normal',
        holderWrites.status === 200,
        `got ${holderWrites.status}: ${JSON.stringify(holderWrites.body?.error)}`
      );

      /* A lock is not a way to hold a finding hostage: a lead can take it back, a consultant cannot. */
      const bobForces = await call(bob, 'POST', `/audits/${auditId}/findings/${lockedId}/lock`, {
        force: true,
      });
      check(
        'a consultant cannot force somebody else off',
        bobForces.status === 403,
        `got ${bobForces.status}`
      );

      const released = await call(alice, 'DELETE', `/audits/${auditId}/findings/${lockedId}/lock`);
      check('the holder can release it', released.status === 200, JSON.stringify(released.body));

      const bobWritesAfter = await call(bob, 'PUT', `/audits/${auditId}/findings/${lockedId}`, {
        title: 'zz lock target',
        remediation: '<p>Bob writes once it is unlocked</p>',
      });
      check(
        'and then anybody may write again',
        bobWritesAfter.status === 200,
        `got ${bobWritesAfter.status}: ${JSON.stringify(bobWritesAfter.body?.error)}`
      );

      /*
       * A lapsed lock. Both halves of the rule have to be aged for this: the holder has not been seen
       * for an hour *and* the lock was taken an hour ago. Ageing only the presence — which is what the
       * first version of this check did — leaves a lock that was taken seconds ago, and a lock taken
       * seconds ago is live no matter who took it. That is the whole reason the rule counts both.
       */
      await call(bob, 'POST', `/audits/${auditId}/findings/${lockedId}/lock`, {});
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await User.updateOne({ _id: bob.user._id }, { $set: { lastSeenAt: anHourAgo } });
      await Audit.updateOne(
        { _id: auditId, 'findings._id': lockedId },
        { $set: { 'findings.$.lockedAt': anHourAgo } }
      );

      const aliceWritesThrough = await call(alice, 'PUT', `/audits/${auditId}/findings/${lockedId}`, {
        title: 'zz lock target',
        scope: '<p>written through a lapsed lock</p>',
      });
      check(
        'a lock whose holder has gone quiet stops blocking anybody',
        aliceWritesThrough.status === 200,
        `got ${aliceWritesThrough.status}: ${JSON.stringify(aliceWritesThrough.body?.error)}`
      );

      await Audit.updateOne(
        { _id: auditId, 'findings._id': lockedId },
        { $set: { 'findings.$.lockedBy': bob.user._id, 'findings.$.lockedAt': anHourAgo } }
      );
      const listed = await call(alice, 'GET', `/audits/${auditId}/locks`);
      check(
        'the engagement can list what is locked, by whom, and whether it has lapsed',
        listed.status === 200 &&
          (listed.body?.locks ?? []).some(
            (entry) => String(entry.finding) === String(lockedId) && entry.stale === true
          ),
        JSON.stringify(listed.body)
      );

      // Taken out of the way of everything below.
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${lockedId}/lock`);
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${lockedId}`);
    }

    /* ------------------------------------------- one action, many findings ---- */
    log.info('Bulk actions on findings');
    {
      /*
       * Its own five findings. A batch changes everything it is given, so borrowing the findings the
       * conflict and lock blocks depend on would move their `updatedAt` and break assertions that
       * have nothing to do with this.
       */
      const made = [];
      for (const [index, title] of [
        'zz bulk one',
        'zz bulk two',
        'zz bulk three',
        'zz bulk four',
        'zz bulk five',
      ].entries()) {
        const created = await call(alice, 'POST', `/audits/${auditId}/findings`, {
          title,
          description: `<p>number ${index + 1}</p>`,
          cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
        });
        made.push(created.body._id);
      }
      check('five findings to work on', made.every(Boolean), JSON.stringify(made.length));

      /* ---------------------------------------------------- a status, on all five */
      const statuses = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'status',
        value: 'retesting',
      });
      check(
        'one call sets the status on all of them',
        statuses.status === 200 && statuses.body?.changed?.length === 5,
        JSON.stringify([statuses.status, statuses.body?.changed?.length, statuses.body?.skipped])
      );

      const afterStatus = await call(alice, 'GET', `/audits/${auditId}`);
      const rowsOf = (body) => (body.findings ?? []).filter((f) => made.includes(String(f._id)));
      check(
        'and the finding’s own history records each one, which is what a retest turns on',
        rowsOf(afterStatus.body).every(
          (f) =>
            f.remediationStatus === 'retesting' &&
            (f.statusHistory ?? []).some((entry) => entry.status === 'retesting')
        ),
        JSON.stringify(rowsOf(afterStatus.body).map((f) => [f.title, f.remediationStatus, (f.statusHistory ?? []).length]))
      );

      const again = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'status',
        value: 'retesting',
      });
      check(
        // Counting a no-op as a change would make the number the page reports a lie.
        'setting the same value again changes nothing and says so',
        again.body?.changed?.length === 0 &&
          (again.body?.skipped ?? []).every((row) => row.reason === 'unchanged'),
        JSON.stringify(again.body)
      );

      /* ------------------------------------------------- a re-score has to say why */
      const noReason = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'severity',
        value: 'Low',
      });
      check(
        // The single-finding route refuses this too. A bulk endpoint that did not would be the way round it.
        'a batch re-score with no reason is refused, exactly as one at a time is',
        noReason.status === 400 && /why/i.test(noReason.body?.error ?? ''),
        JSON.stringify([noReason.status, noReason.body?.error])
      );

      const rescored = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'severity',
        value: 'Low',
        reason: 'Compensating control agreed with the client at the kickoff.',
      });
      check(
        'with one, every finding carries the override and the sentence that explains it',
        rescored.body?.changed?.length === 5,
        JSON.stringify(rescored.body?.skipped)
      );
      const afterScore = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'and the vectors are untouched — an override is not a rescoring of the CVSS',
        rowsOf(afterScore.body).every(
          (f) =>
            f.severityOverride === 'Low' &&
            /Compensating control/.test(f.severityOverrideReason ?? '') &&
            f.cvssv3 === 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N'
        ),
        JSON.stringify(rowsOf(afterScore.body).map((f) => [f.severityOverride, f.cvssv3]))
      );
      check(
        'and it says who stood behind it',
        rowsOf(afterScore.body).every((f) => String(f.severityOverrideBy?._id ?? f.severityOverrideBy) === String(alice.user._id)),
        JSON.stringify(rowsOf(afterScore.body).map((f) => f.severityOverrideBy))
      );

      const cleared = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'severity',
        value: '',
      });
      check(
        'clearing the override needs no reason, because it is a return to the score',
        cleared.status === 200 && cleared.body?.changed?.length === 5,
        JSON.stringify([cleared.status, cleared.body?.error])
      );

      /* ------------------------------------------------------- the other fields --- */
      const categorised = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'category',
        value: 'zz Web application',
      });
      check(
        'a category can be set across a selection, which is how a taxonomy stops having three spellings',
        categorised.body?.changed?.length === 5,
        JSON.stringify(categorised.body?.skipped)
      );
      const prioritised = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'priority',
        value: 3,
      });
      check('and a priority', prioritised.body?.changed?.length === 5, JSON.stringify(prioritised.body));
      check(
        'but not a priority that is not one',
        (
          await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
            ids: made,
            action: 'priority',
            value: 9,
          })
        ).status === 400,
        'priority 9 was accepted'
      );
      check(
        'nor a status nothing uses',
        (
          await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
            ids: made,
            action: 'status',
            value: 'mostly-fixed',
          })
        ).status === 400,
        'an invented status was accepted'
      );
      check(
        'nor an empty selection',
        (
          await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
            ids: [],
            action: 'status',
            value: 'open',
          })
        ).status === 422,
        'a batch of nothing was accepted'
      );

      /* --------------------------------------------- what somebody else is holding */
      /*
       * The behaviour that decides whether people trust this: a locked finding is *skipped and
       * named*, not a failure of the whole batch. One colleague reading a write-up must not block a
       * change to the other four, or everybody learns to work around the feature.
       */
      await call(bob, 'POST', `/audits/${auditId}/findings/${made[0]}/lock`, { note: 'reading it' });
      const partial = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made,
        action: 'status',
        value: 'fixed',
      });
      check(
        'a locked finding is skipped rather than failing the batch',
        partial.status === 200 && partial.body?.changed?.length === 4,
        JSON.stringify([partial.status, partial.body?.changed?.length])
      );
      check(
        'and the skip names it, the reason and who holds it',
        (partial.body?.skipped ?? []).some(
          (row) => row.id === made[0] && row.reason === 'locked' && /Collab/.test(row.by ?? '')
        ),
        JSON.stringify(partial.body?.skipped)
      );
      const afterPartial = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'the locked one really is untouched',
        rowsOf(afterPartial.body).find((f) => String(f._id) === made[0])?.remediationStatus ===
          'retesting',
        JSON.stringify(rowsOf(afterPartial.body).map((f) => [f.title, f.remediationStatus]))
      );
      await call(bob, 'DELETE', `/audits/${auditId}/findings/${made[0]}/lock`);

      const allLocked = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: ['0'.repeat(24)],
        action: 'status',
        value: 'open',
      });
      check(
        // 200 with an empty account of it: nothing was written, and that is not a failed request.
        'a batch where nothing is workable answers with the reasons rather than an error',
        allLocked.status === 200 &&
          allLocked.body?.changed?.length === 0 &&
          allLocked.body?.skipped?.[0]?.reason === 'missing',
        JSON.stringify([allLocked.status, allLocked.body])
      );

      /* ------------------------------------------------------------ one log entry */
      const bulkEntries = await Activity.countDocuments({
        audit: auditId,
        action: 'finding.updated',
        'meta.bulk': true,
      });
      check(
        // Forty rows saying the same thing is not a log.
        'a batch writes one activity entry, not one per finding',
        bulkEntries >= 1,
        `expected at least one bulk entry, found ${bulkEntries}`
      );

      /* ------------------------------------------------------------ renumbering --- */
      /*
       * The trash has to be empty first, and blocks above this one have put findings in it. That is
       * the guard working rather than an inconvenience — a restore brings a finding back carrying
       * its number — so the trash is emptied here and refilled below to check the refusal.
       */
      const binBefore = await call(alice, 'GET', `/audits/${auditId}/findings/deleted`);
      for (const row of binBefore.body ?? []) {
        await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${row.findingId}`);
      }
      const renumbered = await call(alice, 'POST', `/audits/${auditId}/findings/renumber`, {});
      check(
        'findings can be renumbered to match the order they are shown in',
        renumbered.status === 200 && renumbered.body?.total >= 5,
        JSON.stringify([renumbered.status, renumbered.body?.renumbered, renumbered.body?.total])
      );
      const numbers = (renumbered.body?.order ?? []).map((row) => row.identifier);
      check(
        'leaving a sequence with no gaps in it, which is what the report prints',
        numbers.length > 0 && numbers.every((value, index) => value === index + 1),
        JSON.stringify(numbers)
      );

      /* ---------------------------------------------------------------- deleting */
      const trashed = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made.slice(0, 2),
        action: 'delete',
      });
      check(
        'a selection can be deleted',
        trashed.status === 200 && trashed.body?.changed?.length === 2,
        JSON.stringify(trashed.body)
      );
      const bin = await call(alice, 'GET', `/audits/${auditId}/findings/deleted`);
      check(
        // The same trash a single delete uses: a batch is exactly where somebody deletes one they
        // meant to keep.
        'and every one of them is in the trash, restorable',
        made.slice(0, 2).every((id) => (bin.body ?? []).some((row) => String(row.findingId) === id)),
        JSON.stringify((bin.body ?? []).map((row) => row.title))
      );

      check(
        // A restore brings a finding back carrying its number, so renumbering around the trash
        // would hand a live finding a number the trash can produce a second copy of.
        'renumbering is refused while anything restorable still holds a number',
        (await call(alice, 'POST', `/audits/${auditId}/findings/renumber`, {})).status === 400,
        'renumbering ran with findings still in the trash'
      );

      /* ----------------------------------------------------------- moving them --- */
      const elsewhere = await call(alice, 'POST', '/audits', { name: 'zz bulk destination' });
      const moved = await call(alice, 'POST', `/audits/${auditId}/findings/bulk`, {
        ids: made.slice(2),
        action: 'transfer',
        target: elsewhere.body._id,
        mode: 'move',
      });
      check(
        'a selection can be moved to another engagement in one go',
        moved.status === 200 && moved.body?.changed?.length === 3,
        JSON.stringify([moved.status, moved.body?.changed?.length, moved.body?.skipped])
      );
      const landedOn = await call(alice, 'GET', `/audits/${elsewhere.body._id}`);
      check(
        'each one arriving with a number of its own on the engagement it lands on',
        (landedOn.body?.findings ?? []).length === 3 &&
          new Set((landedOn.body.findings ?? []).map((f) => f.identifier)).size === 3,
        JSON.stringify((landedOn.body?.findings ?? []).map((f) => [f.title, f.identifier]))
      );
      const sourceAfter = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'and gone from the one they left',
        !made.slice(2).some((id) => (sourceAfter.body?.findings ?? []).some((f) => String(f._id) === id)),
        JSON.stringify((sourceAfter.body?.findings ?? []).map((f) => f.title))
      );
      check(
        'with one entry on each engagement’s log rather than one per finding',
        (await Activity.countDocuments({
          audit: elsewhere.body._id,
          action: 'finding.transferred',
        })) === 1,
        'the batch move did not log once'
      );
      check(
        'and a target this person is not on is refused',
        (
          await call(bob, 'POST', `/audits/${elsewhere.body._id}/findings/bulk`, {
            ids: (landedOn.body.findings ?? []).map((f) => String(f._id)),
            action: 'transfer',
            target: auditId,
          })
        ).status === 403,
        'somebody moved findings off an engagement they are not on'
      );

      /* Tidying: the trash rows, the spare engagement, and the findings left over. */
      for (const row of bin.body ?? []) {
        await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${row.findingId}`);
      }
      await Audit.deleteOne({ _id: elsewhere.body._id });
      await Activity.deleteMany({ audit: elsewhere.body._id });
    }

    /* ------------------------------------------- where a document came from ---- */
    log.info('Render provenance');
    {
      const { Template: Templates3 } = await import('../models/template.model.js');
      const { RenderRecord } = await import('../models/render-record.model.js');
      const PizZip3 = (await import('pizzip')).default;
      const fs3 = await import('node:fs/promises');
      const path3 = await import('node:path');
      const env3 = (await import('../config/env.js')).default;
      const { Document: Doc3, Packer: Pack3, Paragraph: P3 } = await import('docx');
      const { Settings: SettingsModel3 } = await import('../models/settings.model.js');

      /* A template of its own, so nothing here depends on what the instance happens to have. */
      const templateBytes = await Pack3.toBuffer(
        new Doc3({ sections: [{ children: [new P3('zz provenance: {{ name }}')] }] })
      );
      await fs3.writeFile(path3.join(env3.storage.templates, 'zz-prov.docx'), templateBytes);
      const tpl3 = await Templates3.create({
        name: 'zz provenance template',
        kind: 'docx',
        ext: 'docx',
        filename: 'zz-prov.docx',
        purpose: 'report',
        size: templateBytes.length,
        uploadedBy: alice.user._id,
      });

      /* Put back at the end of the block: later blocks generate reports from whatever was here. */
      const templateBefore = (await Audit.findById(auditId).select('template')).template ?? null;
      await Audit.updateOne({ _id: auditId }, { $set: { template: tpl3._id } });
      const before = await RenderRecord.countDocuments({ audit: auditId });
      /*
       * Fetched directly rather than through `call`, which reads every response as text — and text
       * is exactly what a .docx is not. The bytes are the point here: the stamp is inside them.
       */
      const docx = async () => {
        const response = await fetch(`${base}/audits/${auditId}/report`, {
          headers: { Authorization: `Bearer ${alice.token}` },
        });
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
      };
      const generated = await docx();
      check(
        'a report generates with a template of its own',
        generated.status === 200 && generated.bytes.subarray(0, 2).toString() === 'PK',
        `${generated.status}, ${generated.bytes.length} bytes`
      );

      const records = await RenderRecord.find({ audit: auditId }).sort({ createdAt: -1 });
      check(
        'and produces exactly one record of how it was made',
        records.length === before + 1,
        `${records.length} records, was ${before}`
      );
      const record = records[0];
      check(
        // The four things that move independently and none of which was recorded before.
        'naming the template, its version, who pressed the button and which build did it',
        record.templateName === 'zz provenance template' &&
          /^[0-9a-f]{10}$/.test(record.templateVersion) &&
          String(record.by) === String(alice.user._id) &&
          Boolean(record.build),
        JSON.stringify({
          template: record.templateName,
          version: record.templateVersion,
          build: record.build,
        })
      );
      check(
        'with the settings that decided what it looks like, snapshotted rather than referenced',
        record.settings && typeof record.settings.updateFieldsOnOpen === 'boolean',
        JSON.stringify(record.settings)
      );
      check(
        'and what went into it, counted',
        record.counts?.findings === (await Audit.findById(auditId)).findings.length,
        JSON.stringify(record.counts)
      );

      const record2 = await RenderRecord.findOne({ renderId: record.renderId });
      check('the render id is unique enough to look one up by', Boolean(record2), 'not found by id');

      const lookup = await call(alice, 'GET', `/renders/${record.renderId}`);
      check(
        // The whole point of stamping the file: somebody holding a mystery .docx can trace it.
        'a render can be looked up by the id written inside the document',
        lookup.status === 200 && lookup.body?.template === 'zz provenance template',
        JSON.stringify([lookup.status, lookup.body?.template])
      );
      check(
        'and an id nothing was rendered under says so rather than answering emptily',
        (await call(alice, 'GET', '/renders/not-a-render-id')).status === 404,
        'a missing render did not 404'
      );

      const listed = await call(alice, 'GET', `/renders?audit=${auditId}`);
      check(
        'the engagement can list what it has produced',
        listed.status === 200 && (listed.body?.renders ?? []).some((row) => row.renderId === record.renderId),
        JSON.stringify((listed.body?.renders ?? []).map((row) => row.template))
      );
      check(
        'and asking for a list without saying which engagement is refused',
        (await call(alice, 'GET', '/renders')).status === 400,
        'a list with no engagement was answered'
      );

      /* --------------------------------------------- and it is inside the file --- */
      const zip3 = new PizZip3(generated.bytes);
      const props = zip3.file('docProps/custom.xml')?.asText() ?? '';
      check(
        'the document itself carries the render id, so an orphaned file is traceable',
        props.includes(record.renderId) && props.includes('EngyTemplateVersion'),
        props.slice(0, 200)
      );
      check(
        'declared in the content types and related from the package, or Word shows nothing',
        (zip3.file('[Content_Types].xml')?.asText() ?? '').includes('/docProps/custom.xml') &&
          (zip3.file('_rels/.rels')?.asText() ?? '').includes('docProps/custom.xml'),
        'the custom properties part was not registered'
      );

      /* ------------------------------------------------ what changed since then --- */
      const settingsDoc3 = await SettingsModel3.getSettings();
      const wasUpdating = settingsDoc3.report?.private?.updateFieldsOnOpen;
      settingsDoc3.report.private.updateFieldsOnOpen = !(wasUpdating !== false);
      settingsDoc3.markModified('report');
      await settingsDoc3.save();

      await docx();
      const after = await call(alice, 'GET', `/renders?audit=${auditId}`);
      const newest = (after.body?.renders ?? [])[0];
      check(
        // The question that prompted all of this: "the last one had a table of contents".
        'a setting changed between two renders is reported as the difference between them',
        (newest?.changedSincePrevious ?? []).some((row) =>
          /refreshes fields/i.test(row.what)
        ),
        JSON.stringify(newest?.changedSincePrevious)
      );

      settingsDoc3.report.private.updateFieldsOnOpen = wasUpdating;
      settingsDoc3.markModified('report');
      await settingsDoc3.save();

      /* ------------------------------------------ one house style, several documents */
      const baseBytes = await Pack3.toBuffer(
        new Doc3({
          styles: {
            paragraphStyles: [
              { id: 'ZzHouse', name: 'Zz House', basedOn: 'Normal', run: { color: '112233' } },
            ],
          },
          sections: [{ children: [new P3('base body')] }],
        })
      );
      await fs3.writeFile(path3.join(env3.storage.templates, 'zz-prov-base.docx'), baseBytes);
      const baseTpl = await Templates3.create({
        name: 'zz house base',
        kind: 'docx',
        ext: 'docx',
        filename: 'zz-prov-base.docx',
        purpose: 'report',
        size: baseBytes.length,
        uploadedBy: alice.user._id,
      });

      const pointed = await call(alice, 'PUT', `/templates/${tpl3._id}`, {
        inherits: String(baseTpl._id),
        inheritParts: { styles: true },
      });
      check(
        'a template can be pointed at a base for its house style',
        pointed.status === 200 && String(pointed.body?.inherits) === String(baseTpl._id),
        JSON.stringify([pointed.status, pointed.body?.inherits])
      );
      check(
        'a template cannot inherit from itself',
        (await call(alice, 'PUT', `/templates/${tpl3._id}`, { inherits: String(tpl3._id) })).status ===
          400,
        'a template was allowed to inherit from itself'
      );
      check(
        // A → B → A is a render that recurses until the process gives up.
        'nor form a loop through another',
        (await call(alice, 'PUT', `/templates/${baseTpl._id}`, { inherits: String(tpl3._id) })).status ===
          400,
        'a loop was allowed'
      );

      const inherited = await docx();
      check(
        'and the render takes the base’s styles without touching its own words',
        inherited.status === 200,
        String(inherited.status)
      );
      const zipInherited = new PizZip3(inherited.bytes);
      check(
        'the base’s style is defined in the produced document',
        (zipInherited.file('word/styles.xml')?.asText() ?? '').includes('ZzHouse'),
        'the inherited style is missing'
      );
      check(
        'while the document still says what the child template says',
        (zipInherited.file('word/document.xml')?.asText() ?? '').includes('zz provenance') &&
          !(zipInherited.file('word/document.xml')?.asText() ?? '').includes('base body'),
        'the body came from the wrong template'
      );

      /* -------------------------------------------------------------- HTML partials */
      const partial = await call(alice, 'POST', '/templates/html', {
        name: 'zz house header',
        html: '<header>{{ name }} — zz letterhead</header>',
        purpose: 'report',
      });
      const usesIt = await call(alice, 'POST', '/templates/html', {
        name: 'zz html child',
        html: '{{> zz house header }}<main>{{ reference }}</main>',
        purpose: 'report',
      });
      check(
        'an HTML template and a partial for it',
        partial.status === 201 && usesIt.status === 201,
        JSON.stringify([partial.status, usesIt.status])
      );
      check(
        // Inheriting .docx parts makes no sense for markup, and half-applying it would be worse.
        'an HTML template is told to use a partial rather than inherit parts',
        (await call(alice, 'PUT', `/templates/${usesIt.body._id}`, { inherits: String(baseTpl._id) }))
          .status === 400,
        'an HTML template was allowed to inherit .docx parts'
      );

      await Audit.updateOne({ _id: auditId }, { $set: { template: usesIt.body._id } });
      const asHtml = await call(alice, 'GET', `/audits/${auditId}/report.html`);
      check(
        'the HTML render expands the partial and then renders the tags inside it',
        asHtml.status === 200 &&
          /zz letterhead/.test(asHtml.text ?? '') &&
          !/\{\{/.test(asHtml.text ?? ''),
        (asHtml.text ?? '').slice(0, 200)
      );

      /* Tidying: the templates, their files, the records and the engagement's own template back. */
      await Audit.updateOne(
        { _id: auditId },
        templateBefore ? { $set: { template: templateBefore } } : { $unset: { template: '' } }
      );
      await RenderRecord.deleteMany({ audit: auditId });
      await Templates3.deleteMany({ name: /^zz (provenance|house|html)/ });
      for (const file of ['zz-prov.docx', 'zz-prov-base.docx']) {
        await fs3.unlink(path3.join(env3.storage.templates, file)).catch(() => {});
      }
    }

    /* ---------------------------------------------------------- the pulse ---- */
    log.info('The pulse, for live refresh');
    {
      /*
       * What the other browser polls. The contract is narrow on purpose: the fingerprint must change
       * when anything a colleague could have done changes, and must not change when nothing has. A
       * fingerprint that moved on its own would refetch the engagement every eight seconds for
       * everybody, which is the cost this route exists to avoid.
       */
      const first = await call(bob, 'GET', `/audits/${auditId}/pulse`);
      check('the pulse answers', first.status === 200, JSON.stringify(first.body).slice(0, 200));
      check(
        'and carries a fingerprint, the counts and the findings',
        typeof first.body?.fingerprint === 'string' &&
          typeof first.body?.counts?.findings === 'number' &&
          Array.isArray(first.body?.findings),
        JSON.stringify(first.body).slice(0, 200)
      );

      const again = await call(bob, 'GET', `/audits/${auditId}/pulse`);
      check(
        'it does not move on its own',
        again.body?.fingerprint === first.body?.fingerprint,
        `${first.body?.fingerprint} → ${again.body?.fingerprint}`
      );

      const edited = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz pulse finding',
      });
      const pulseFinding = edited.body?._id;
      const afterWrite = await call(bob, 'GET', `/audits/${auditId}/pulse`);
      check(
        'somebody else adding a finding moves it',
        afterWrite.body?.fingerprint !== first.body?.fingerprint,
        `${first.body?.fingerprint} → ${afterWrite.body?.fingerprint}`
      );
      check(
        'and the pulse says who touched what',
        (afterWrite.body?.findings ?? []).some(
          (f) => String(f.id) === String(pulseFinding) && f.updatedBy?.fullname
        ),
        JSON.stringify(afterWrite.body?.findings?.at(-1))
      );

      const locked = await call(alice, 'POST', `/audits/${auditId}/findings/${pulseFinding}/lock`, {});
      check('locking is a change too', locked.status === 200, JSON.stringify(locked.body));
      const afterLock = await call(bob, 'GET', `/audits/${auditId}/pulse`);
      check(
        'so the other side learns about a lock without asking for the whole engagement',
        afterLock.body?.fingerprint !== afterWrite.body?.fingerprint &&
          (afterLock.body?.findings ?? []).some(
            (f) => String(f.id) === String(pulseFinding) && f.lockedBy?.fullname
          ),
        JSON.stringify(afterLock.body?.findings?.at(-1))
      );

      const outsider = await makeUser('outsider', 'user');
      const refused = await call(outsider, 'GET', `/audits/${auditId}/pulse`);
      check(
        'and it is not a way to watch an engagement you cannot open',
        refused.status === 403 || refused.status === 404,
        `got ${refused.status}`
      );
      await User.deleteOne({ _id: outsider.user._id });

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${pulseFinding}/lock`);
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${pulseFinding}`);
    }

    /* ------------------------------------------------------ trash lifecycle */
    log.info('Trash');
    await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'EDIT' });
    const trashed = await call(alice, 'DELETE', `/audits/${auditId}`);
    check('delete is a soft delete', trashed.body?.trashed === true, JSON.stringify(trashed.body));
    check(
      'retention window reported',
      typeof trashed.body?.retentionDays === 'number',
      JSON.stringify(trashed.body?.retentionDays)
    );

    const hidden = await call(alice, 'GET', `/audits/${auditId}`);
    check('trashed engagement is not readable', hidden.status === 404, `got ${hidden.status}`);

    const list = await call(alice, 'GET', '/audits');
    check(
      'trashed engagement is off the list',
      !(list.body ?? []).some((audit) => audit._id === auditId)
    );

    const trash = await call(alice, 'GET', '/audits/trash');
    const entry = (trash.body?.audits ?? []).find((audit) => audit._id === auditId);
    check('it is in the trash', Boolean(entry));
    check('with a countdown', typeof entry?.daysLeft === 'number', JSON.stringify(entry?.daysLeft));

    const restored = await call(alice, 'POST', `/audits/${auditId}/restore`, {});
    check('restore works', restored.status === 200, JSON.stringify(restored.body));
    const back = await call(alice, 'GET', `/audits/${auditId}`);
    check('and the work is intact', back.body?.findings?.length === 1, JSON.stringify(back.status));

    const purgeTooSoon = await call(alice, 'DELETE', `/audits/${auditId}/purge`);
    check(
      'purging something not in the trash is refused',
      purgeTooSoon.status === 400,
      `got ${purgeTooSoon.status}`
    );

    /* ---------------------------------------------------------- sign-off --- */
    log.info('Sign-off');
    const { Settings } = await import('../models/settings.model.js');
    const settings = await Settings.getSettings();
    // Staleness has to be observable, so the clearing behaviour is off for this part
    // — the block below turns it on deliberately. Restored in the outer finally.
    const enabledBefore = settings.reviews.enabled;
    const removingBefore = settings.reviews.private.removeApprovalsUponUpdate;
    const mandatoryBefore = settings.reviews.public.mandatoryReview;
    const minReviewersBefore = settings.reviews.public.minReviewers;
    settings.reviews.enabled = false;
    settings.reviews.private.removeApprovalsUponUpdate = false;
    await settings.save();

    // The trash test left this in EDIT.
    await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'REVIEW' });

    const notAReviewer = await call(alice, 'POST', `/audits/${auditId}/approve`, {});
    check(
      'somebody who is not a reviewer cannot sign off',
      notAReviewer.status === 403 && /reviewer/i.test(notAReviewer.body?.error ?? ''),
      `${notAReviewer.status} ${notAReviewer.body?.error}`
    );

    // Alice created this engagement. Being made a reviewer must not buy her the
    // ability to sign off her own work — the count would otherwise be her own name.
    await call(alice, 'PUT', `/audits/${auditId}`, {
      reviewers: [bob.user._id.toString(), alice.user._id.toString()],
    });
    const selfApproval = await call(alice, 'POST', `/audits/${auditId}/approve`, {});
    check(
      'the author cannot sign off their own report, even as a reviewer',
      selfApproval.status === 403 && /created/i.test(selfApproval.body?.error ?? ''),
      `${selfApproval.status} ${selfApproval.body?.error}`
    );
    await call(alice, 'PUT', `/audits/${auditId}`, { reviewers: [bob.user._id.toString()] });

    await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'EDIT' });
    const tooEarly = await call(bob, 'POST', `/audits/${auditId}/approve`, {});
    check(
      'a report still being written cannot be signed off',
      tooEarly.status === 400,
      `${tooEarly.status} ${tooEarly.body?.error}`
    );
    await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'REVIEW' });

    const signed = await call(bob, 'POST', `/audits/${auditId}/approve`, {});
    check('a reviewer can sign off', signed.status === 200 && signed.body?.approved === true);

    const withSignature = await call(alice, 'GET', `/audits/${auditId}`);
    const signature = withSignature.body?.approvals?.[0];
    check(
      'the signature records who',
      signature?.user?.username === bob.user.username,
      JSON.stringify(signature?.user)
    );
    check('and when', Boolean(signature?.at), JSON.stringify(signature?.at));
    check(
      'and what content it covers',
      Boolean(signature?.fingerprint) &&
        signature.fingerprint === withSignature.body?.contentFingerprint,
      `${signature?.fingerprint} vs ${withSignature.body?.contentFingerprint}`
    );

    const withdrawn = await call(bob, 'POST', `/audits/${auditId}/approve`, {});
    check(
      'and can be withdrawn',
      withdrawn.status === 200 && withdrawn.body?.approved === false,
      JSON.stringify(withdrawn.body)
    );
    await call(bob, 'POST', `/audits/${auditId}/approve`, {});

    /* --------------------------------------------- a signature covers text --- */
    // A comment is not a change to the report, so it must not invalidate anything.
    await call(alice, 'POST', `/audits/${auditId}/findings/${findingId}/comments`, {
      body: 'internal note, changes nothing the client reads',
    });
    const afterComment = await call(alice, 'GET', `/audits/${auditId}`);
    check(
      'commenting does not invalidate a signature',
      afterComment.body?.approvals?.[0]?.fingerprint === afterComment.body?.contentFingerprint,
      'a comment moved the fingerprint'
    );

    await call(alice, 'PUT', `/audits/${auditId}/findings/${findingId}`, {
      title: 'Stored XSS in the export view',
      description: '<p>rewritten after it was signed off</p>',
    });
    const afterRewrite = await call(alice, 'GET', `/audits/${auditId}`);
    check(
      'rewriting the report leaves the signature behind',
      afterRewrite.body?.approvals?.length === 1 &&
        afterRewrite.body.approvals[0].fingerprint !== afterRewrite.body.contentFingerprint,
      JSON.stringify({
        signed: afterRewrite.body?.approvals?.[0]?.fingerprint,
        now: afterRewrite.body?.contentFingerprint,
      })
    );

    const staleInbox = await call(bob, 'GET', '/inbox');
    check(
      'so the review is back in the reviewer inbox',
      staleInbox.body?.reviews?.some((r) => String(r.auditId) === auditId),
      JSON.stringify(staleInbox.body?.reviews?.map((r) => r.approvals))
    );

    const staleReport = await call(alice, 'GET', `/audits/${auditId}/report-data`);
    check(
      'and the report does not print it as an approval',
      (staleReport.body?.approvals ?? []).length === 0 &&
        staleReport.body?.staleApprovalCount === 1,
      JSON.stringify({
        approvals: staleReport.body?.approvals?.length,
        stale: staleReport.body?.staleApprovalCount,
      })
    );

    /* ------------------------------------------------------------- quorum --- */
    settings.reviews.enabled = true;
    settings.reviews.public.mandatoryReview = true;
    settings.reviews.public.minReviewers = 1;
    await settings.save();

    const staleQuorum = await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'APPROVED' });
    check(
      'a stale signature does not satisfy a mandatory review',
      staleQuorum.status === 400 && /no longer cover/i.test(staleQuorum.body?.error ?? ''),
      `${staleQuorum.status} ${staleQuorum.body?.error}`
    );

    await call(bob, 'POST', `/audits/${auditId}/approve`, {});
    const renewed = await call(bob, 'POST', `/audits/${auditId}/approve`, {});
    check('renewing a signature works', renewed.body?.approved === true, JSON.stringify(renewed.body));
    const nowApproved = await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'APPROVED' });
    check(
      'and a current one does',
      nowApproved.status === 200,
      `${nowApproved.status} ${nowApproved.body?.error}`
    );

    /* ---------------------------------------------- old-style approvals --- */
    // Written straight to the collection the way every existing engagement holds
    // them: bare user ids, which Mongoose cannot hydrate into subdocuments.
    const { migrateApprovals } = await import('../services/approvals-migration.service.js');
    const raw = await Audit.findById(auditId).select('_id');
    await Audit.collection.updateOne({ _id: raw._id }, { $set: { approvals: [bob.user._id] } });
    const migrated = await migrateApprovals();
    check('old approvals migrate to records', migrated === 1, `modified ${migrated}`);
    const afterMigration = await call(alice, 'GET', `/audits/${auditId}`);
    check(
      'keeping who, admitting it does not know when',
      afterMigration.body?.approvals?.[0]?.user?.username === bob.user.username &&
        afterMigration.body.approvals[0].at === null,
      JSON.stringify(afterMigration.body?.approvals?.[0])
    );
    check(
      'and an unknown fingerprint is not treated as stale',
      afterMigration.body?.approvals?.[0]?.fingerprint === '',
      JSON.stringify(afterMigration.body?.approvals?.[0]?.fingerprint)
    );
    const migratedReport = await call(alice, 'GET', `/audits/${auditId}/report-data`);
    check(
      'so it still counts as an approval',
      (migratedReport.body?.approvals ?? []).length === 1,
      JSON.stringify(migratedReport.body?.approvalCount)
    );
    check('running the migration again does nothing', (await migrateApprovals()) === 0);

    // Leave a clean slate for the block below, which signs off from scratch, and put
    // the instance's own settings back before it reads them.
    await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'REVIEW' });
    await call(bob, 'POST', `/audits/${auditId}/approve`, {});
    settings.reviews.enabled = enabledBefore;
    settings.reviews.private.removeApprovalsUponUpdate = removingBefore;
    settings.reviews.public.mandatoryReview = mandatoryBefore;
    settings.reviews.public.minReviewers = minReviewersBefore;
    await settings.save();

    /* ------------------------------------------------- approvals on update */
    log.info('Approvals cleared when approved content changes');
    // Set the nested paths rather than replacing `reviews` wholesale — assigning a
    // plain-object spread of a Mongoose subdocument drops the nested defaults.
    const wasEnabled = settings.reviews.enabled;
    const wasRemoving = settings.reviews.private.removeApprovalsUponUpdate;
    settings.reviews.enabled = true;
    settings.reviews.private.removeApprovalsUponUpdate = true;
    await settings.save();

    try {
      await call(bob, 'POST', `/audits/${auditId}/approve`, {});
      const approvedState = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'approval recorded',
        (approvedState.body?.approvals ?? []).length === 1,
        JSON.stringify(approvedState.body?.approvals?.length)
      );

      await call(alice, 'PUT', `/audits/${auditId}/findings/${findingId}`, {
        title: 'Stored XSS in the export view',
        description: '<p>changed after sign-off</p>',
      });
      const afterEdit = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'sign-off dropped when the content changed under it',
        (afterEdit.body?.approvals ?? []).length === 0,
        JSON.stringify(afterEdit.body?.approvals?.length)
      );
      const log2 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'and that is in the log',
        (log2.body?.entries ?? []).some((e) => e.action === 'audit.approvals-cleared')
      );
    } finally {
      settings.reviews.enabled = wasEnabled;
      settings.reviews.private.removeApprovalsUponUpdate = wasRemoving;
      await settings.save();
    }


    /* -------------------------------------------- deleting a finding --------- */
    {
    log.info('Deleted findings can be restored');
    const { DeletedFinding } = await import('../models/deleted-finding.model.js');

    const doomed = await call(alice, 'POST', `/audits/${auditId}/findings`, {
      title: 'zz Doomed finding',
      description: '<p>an hour of writing</p>',
      poc: '<p>evidence <img src="/api/media/aaaaaaaaaaaaaaaaaaaaaaaa"></p>',
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    });
    const doomedId = doomed.body?._id;
    await call(alice, 'POST', `/audits/${auditId}/findings/${doomedId}/comments`, {
      body: 'worth keeping',
    });

    const binned = await call(alice, 'DELETE', `/audits/${auditId}/findings/${doomedId}`);
    check(
      'deleting says how long it can be restored for',
      binned.status === 200 && typeof binned.body?.restorableForDays === 'number',
      JSON.stringify(binned.body)
    );

    const withoutIt = await call(alice, 'GET', `/audits/${auditId}`);
    check(
      'the finding leaves the engagement',
      !(withoutIt.body?.findings ?? []).some((f) => f._id === doomedId),
      'it was still in the findings list'
    );
    // The whole reason it lives in another collection: nothing that reads an
    // engagement can accidentally include it.
    const reportWithout = await call(alice, 'GET', `/audits/${auditId}/report-data`);
    check(
      'and cannot reach the report',
      !(reportWithout.body?.findings ?? []).some((f) => f.title === 'zz Doomed finding'),
      'a deleted finding was in the report data'
    );

    const findingTrash = await call(alice, 'GET', `/audits/${auditId}/findings/deleted`);
    const binnedRow = (findingTrash.body ?? []).find((row) => row.findingId === doomedId);
    check(
      'it is listed as restorable, with who and when',
      Boolean(binnedRow) && binnedRow.severity === 'Critical' && Boolean(binnedRow.deletedAt),
      JSON.stringify(findingTrash.body)
    );

    // Evidence must survive: a restored finding with holes where its screenshots were
    // is not a restore.
    const { collectOrphanMedia } = await import('../services/media.service.js');
    const sweep = await collectOrphanMedia({ graceMs: 0, dryRun: true });
    check(
      'its evidence still counts as referenced',
      !sweep.orphans.some((file) => String(file._id) === 'aaaaaaaaaaaaaaaaaaaaaaaa'),
      'a restorable finding’s image was about to be swept'
    );

    const back = await call(alice, 'POST', `/audits/${auditId}/findings/${doomedId}/restore`, {});
    check('restoring works', back.status === 200, JSON.stringify(back.body?.error));
    check(
      'with the same id, so its comments come back with it',
      back.body?._id === doomedId && (back.body?.comments ?? []).length === 1,
      JSON.stringify({ id: back.body?._id, comments: back.body?.comments?.length })
    );
    const emptied = await call(alice, 'GET', `/audits/${auditId}/findings/deleted`);
    check(
      'and it is out of the trash',
      // Not "the trash is empty": earlier parts of this suite delete findings too, and
      // they are all restorable now, which is the point.
      !(emptied.body ?? []).some((row) => row.findingId === doomedId),
      JSON.stringify(emptied.body?.map((row) => row.title))
    );

    const twice = await call(alice, 'POST', `/audits/${auditId}/findings/${doomedId}/restore`, {});
    check(
      'restoring something already restored is refused, not duplicated',
      twice.status === 404,
      `got ${twice.status}`
    );
    const stillOne = await call(alice, 'GET', `/audits/${auditId}`);
    check(
      'and the finding exists exactly once',
      (stillOne.body?.findings ?? []).filter((f) => f._id === doomedId).length === 1,
      'the finding was duplicated'
    );

    /* ------------------------------ emptying the trash by hand ---------------- */
    // The trash makes a mis-click survivable; it should not make a deliberate deletion take
    // a fortnight, and the alternative people reach for otherwise is emptying the
    // collection by hand.
    await call(alice, 'DELETE', `/audits/${auditId}/findings/${doomedId}`);

    const notInTheTrash = await call(
      alice,
      'DELETE',
      `/audits/${auditId}/findings/deleted/${findingId}`
    );
    check(
      'a finding that is not in the trash cannot be purged from it',
      notInTheTrash.status === 404,
      `got ${notInTheTrash.status}`
    );

    const stranger2 = await makeUser('purger', 'user');
    const notOnIt2 = await call(
      stranger2,
      'DELETE',
      `/audits/${auditId}/findings/deleted/${doomedId}`
    );
    check(
      'somebody off the engagement cannot empty its trash',
      notOnIt2.status === 404 || notOnIt2.status === 403,
      `got ${notOnIt2.status}`
    );

    const purged = await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${doomedId}`);
    check('whoever deleted it can delete it for good', purged.status === 200, JSON.stringify(purged.body));
    check(
      'and it is gone from the trash rather than hidden in it',
      (await DeletedFinding.countDocuments({ audit: auditId, findingId: doomedId })) === 0,
      'the row was still there'
    );

    const noRestore = await call(alice, 'POST', `/audits/${auditId}/findings/${doomedId}/restore`, {});
    check(
      'with nothing left to restore',
      noRestore.status === 404,
      `got ${noRestore.status}`
    );

    // The one deletion in the app with nothing left to inspect afterwards, so the log is
    // the only trace it ever existed.
    const purgeLog = await call(alice, 'GET', `/audits/${auditId}/activity`);
    check(
      'and it is written down, because nothing else survives it',
      (purgeLog.body?.entries ?? []).some((entry) => entry.action === 'finding.purged'),
      JSON.stringify((purgeLog.body?.entries ?? []).slice(0, 3).map((e) => e.action))
    );

    const twicePurged = await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${doomedId}`);
    check(
      'purging it again says so rather than pretending it worked',
      twicePurged.status === 404,
      `got ${twicePurged.status}`
    );

    /*
     * Deleting a finding for good frees the number it held.
     *
     * Allocation reserves numbers still in the trash so a restore cannot collide — and once
     * there is nothing to restore, holding the number back would leave a gap in the report
     * ids for a finding nobody can ever see again.
     */
    const numbered = await call(alice, 'POST', `/audits/${auditId}/findings`, {
      title: 'zz Number reuse check',
    });
    const heldNumber = numbered.body?.identifier;
    await call(alice, 'DELETE', `/audits/${auditId}/findings/${numbered.body._id}`);
    const whileInTheTrash = await call(alice, 'POST', `/audits/${auditId}/findings`, {
      title: 'zz While in the trash',
    });
    check(
      'a number held in the trash is not handed out twice',
      whileInTheTrash.body?.identifier !== heldNumber,
      `both got ${heldNumber}`
    );
    await call(alice, 'DELETE', `/audits/${auditId}/findings/${whileInTheTrash.body._id}`);
    await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${whileInTheTrash.body._id}`);
    await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${numbered.body._id}`);

    await DeletedFinding.deleteMany({ audit: auditId });
    }

    /* --------------------------------------------------- the schedule -------- */
    log.info('Schedule');
    {
      const { Booking } = await import('../models/booking.model.js');
      const { User: Users2 } = await import('../models/user.model.js');

      const mine = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        start: '2026-09-07',
        end: '2026-09-11',
        note: 'remote',
      });
      check('anyone on the engagement can book their own time', mine.status === 201, JSON.stringify(mine.body?.error));
      check(
        'the booking comes back with the person and the engagement resolved',
        mine.body?.user?.username === bob.user.username && Boolean(mine.body?.audit?.name),
        JSON.stringify({ user: mine.body?.user?.username, audit: mine.body?.audit?.name })
      );

      const backwards = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        start: '2026-09-11',
        end: '2026-09-07',
      });
      check('a booking cannot end before it starts', backwards.status === 400, `got ${backwards.status}`);

      // Somebody who is not on the engagement cannot be given time on it — the booking
      // would put days against something they cannot open.
      const stranger = await makeUser('stranger', 'user');
      const notOnIt = await call(alice, 'POST', '/schedule', {
        audit: auditId,
        user: stranger.user._id.toString(),
        start: '2026-09-07',
        end: '2026-09-08',
      });
      check(
        'somebody off the team cannot be booked to it',
        notOnIt.status === 400 && /not on this engagement/i.test(notOnIt.body?.error ?? ''),
        `${notOnIt.status} ${notOnIt.body?.error}`
      );

      // Booking someone else is the creator's call or an admin's — the same rule that
      // governs the team itself. Bob is a collaborator, not the creator.
      const bobBooksAlice = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        user: alice.user._id.toString(),
        start: '2026-09-14',
        end: '2026-09-15',
      });
      check(
        'a collaborator cannot book somebody else',
        bobBooksAlice.status === 403,
        `got ${bobBooksAlice.status}`
      );
      const creatorBooks = await call(alice, 'POST', '/schedule', {
        audit: auditId,
        user: bob.user._id.toString(),
        start: '2026-09-09',
        end: '2026-09-15',
        note: 'second week',
      });
      check('the creator can', creatorBooks.status === 201, JSON.stringify(creatorBooks.body?.error));

      // Overlap: two bookings, same person, shared days. Reported, never refused — the
      // point of a schedule is to show the clash.
      const window = await call(bob, 'GET', '/schedule?from=2026-08-31&to=2026-10-04');
      const bobs = (window.body?.bookings ?? []).filter(
        (entry) => entry.user?.username === bob.user.username
      );
      check(
        'overlapping bookings are both kept',
        bobs.length === 2,
        JSON.stringify(bobs.map((b) => [b.start, b.end]))
      );

      // Overlap, not containment: a booking that merely spans the window must appear.
      const spanning = await call(alice, 'POST', '/schedule', {
        audit: auditId,
        user: alice.user._id.toString(),
        start: '2026-08-20',
        end: '2026-10-20',
      });
      const narrow = await call(alice, 'GET', '/schedule?from=2026-09-01&to=2026-09-30');
      check(
        'a booking that spans the window is in it',
        (narrow.body?.bookings ?? []).some((entry) => entry._id === spanning.body._id),
        'a booking straddling the month was missed'
      );

      const outside = await call(alice, 'GET', '/schedule?from=2027-01-01&to=2027-01-31');
      check(
        'and a month with nothing in it comes back empty',
        (outside.body?.bookings ?? []).length === 0,
        JSON.stringify(outside.body?.bookings?.length)
      );

      check(
        'the engagement list is scoped to what the caller may book against',
        (window.body?.engagements ?? []).every((entry) => entry.team.includes(String(bob.user._id))) ||
          (window.body?.engagements ?? []).length >= 1,
        JSON.stringify(window.body?.engagements?.map((e) => e.name))
      );

      const theirs = await call(bob, 'GET', '/schedule');
      const alicesBooking = (theirs.body?.bookings ?? []).find(
        (entry) => entry._id === spanning.body._id
      );
      check(
        'the whole team sees each other on the shared engagement',
        Boolean(alicesBooking),
        'a colleague could not see a booking on their own engagement'
      );

      // An outsider sees nothing, because they see no engagements.
      const theirSchedule = await call(stranger, 'GET', '/schedule');
      check(
        'somebody on no engagements has an empty schedule',
        (theirSchedule.body?.bookings ?? []).length === 0 &&
          (theirSchedule.body?.engagements ?? []).length === 0,
        JSON.stringify(theirSchedule.body)
      );

      const cannotDelete = await call(bob, 'DELETE', `/schedule/${spanning.body._id}`);
      check(
        "and cannot delete somebody else's booking",
        cannotDelete.status === 403,
        `got ${cannotDelete.status}`
      );
      const deleted = await call(bob, 'DELETE', `/schedule/${mine.body._id}`);
      check('but can remove their own', deleted.status === 200, `got ${deleted.status}`);

      const scheduleLog = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'bookings show up in the engagement log',
        (scheduleLog.body?.entries ?? []).some((entry) => entry.action === 'booking.added'),
        JSON.stringify(scheduleLog.body?.entries?.slice(0, 4).map((e) => e.action))
      );

      await Booking.deleteMany({ audit: auditId });
      await Users2.deleteOne({ _id: stranger.user._id });
    }

    /* ------------------------------------------------ skills and experience --- */
    log.info('Skills');
    {
      const mine = await call(alice, 'PUT', `/users/${alice.user._id}/profile`, {
        headline: 'Lead tester — web and cloud',
        yearsExperience: 11,
        languages: ['English', 'Romanian'],
        skills: [
          { name: 'Web application testing', level: 'expert' },
          { name: 'Active Directory', level: 'working' },
        ],
        certifications: [
          { name: 'OSCP', issuer: 'Offensive Security', obtainedAt: '2019-04-02', expiresAt: '' },
          // Expired last month: the page exists to notice this.
          { name: 'CREST CRT', issuer: 'CREST', expiresAt: '2026-07-01' },
        ],
      });
      check('you can record your own skills', mine.status === 200, JSON.stringify(mine.body?.error));
      check(
        'and they come back as stored',
        mine.body?.skills?.length === 2 && mine.body?.yearsExperience === 11,
        JSON.stringify(mine.body?.skills)
      );

      const bad = await call(alice, 'PUT', `/users/${alice.user._id}/profile`, {
        skills: [{ name: 'Nonsense', level: 'wizard' }],
      });
      // 422 rather than 400: a schema failure comes from the validation middleware, which
      // reports unprocessable content and names the offending field.
      check('an invented level is refused', bad.status === 422, `got ${bad.status}`);

      // Readable by anyone signed in: "who should I ask about this" is not an admin question.
      const roster = await call(bob, 'GET', '/users/skills');
      const alices = (roster.body?.people ?? []).find(
        (person) => person.username === alice.user.username
      );
      check(
        'everyone signed in can read the roster',
        roster.status === 200 && alices?.skills?.length === 2,
        `${roster.status} ${JSON.stringify(alices?.skills)}`
      );
      check(
        'with a tally of every skill and who holds it',
        (roster.body?.skills ?? []).some(
          (skill) => skill.name === 'Web application testing' && skill.people >= 1
        ),
        JSON.stringify(roster.body?.skills)
      );
      check(
        'and nothing about anybody’s account security',
        !JSON.stringify(roster.body).includes('totpSecret') &&
          !JSON.stringify(roster.body).includes('password'),
        'the roster leaked account fields'
      );

      /* ------------------------------- what the page reads, not what it derives */
      // Bob gets a second profile, so "one deep" and "nobody deep" are different answers
      // rather than artefacts of a one-person roster.
      await call(bob, 'PUT', `/users/${bob.user._id}/profile`, {
        headline: 'Mobile and cloud',
        yearsExperience: 5,
        languages: ['English'],
        skills: [
          { name: 'Web application testing', level: 'strong' },
          { name: 'Active Directory', level: 'learning' },
          { name: 'Mobile (Android)', level: 'learning' },
        ],
        certifications: [
          // Comfortably in date, so the counts have one of each state to report.
          { name: 'CCSK', issuer: 'Cloud Security Alliance', expiresAt: '2035-01-01' },
        ],
      });

      const rich = await call(bob, 'GET', '/users/skills');
      const web = (rich.body?.skills ?? []).find((skill) => skill.name === 'Web application testing');
      check(
        'a skill carries who holds it and at what level',
        web?.levels?.expert === 1 && web?.levels?.strong === 1 && web?.holders?.length === 2,
        JSON.stringify(web)
      );
      check(
        'strongest holder first, because that is who gets asked',
        web?.holders?.[0]?.level === 'expert',
        JSON.stringify(web?.holders?.map((h) => h.level))
      );
      check(
        'depth counts only people who could be handed the work',
        web?.depth === 2,
        JSON.stringify({ depth: web?.depth, levels: web?.levels })
      );

      const ad = (rich.body?.skills ?? []).find((skill) => skill.name === 'Active Directory');
      check(
        'two people knowing a little is a depth of zero, not a count of two',
        ad?.people === 2 && ad?.depth === 0,
        JSON.stringify({ people: ad?.people, depth: ad?.depth })
      );

      const cover = rich.body?.coverage ?? {};
      check(
        'the coverage block says how much is even recorded',
        cover.people >= 2 && cover.recorded >= 2 && cover.distinctSkills >= 3,
        JSON.stringify({ people: cover.people, recorded: cover.recorded, skills: cover.distinctSkills })
      );
      check(
        'a skill nobody holds above working knowledge is named as such',
        (cover.noneDeep ?? []).some((row) => row.name === 'Active Directory') &&
          (cover.noneDeep ?? []).some((row) => row.name === 'Mobile (Android)'),
        JSON.stringify(cover.noneDeep)
      );
      check(
        'and a skill two people can carry is not called thin',
        !(cover.oneDeep ?? []).some((row) => row.name === 'Web application testing'),
        JSON.stringify(cover.oneDeep)
      );

      // One deep: drop Bob to learning and the same skill becomes a single point of failure.
      await call(bob, 'PUT', `/users/${bob.user._id}/profile`, {
        skills: [{ name: 'Web application testing', level: 'learning' }],
      });
      const thin = await call(bob, 'GET', '/users/skills');
      const risk = (thin.body?.coverage?.oneDeep ?? []).find(
        (row) => row.name === 'Web application testing'
      );
      check(
        'one strong holder makes a skill one deep, and names them',
        risk?.person?.fullname?.includes('Collab') && risk?.learners === 1,
        JSON.stringify(risk)
      );

      check(
        'certifications are counted by where they stand, not just how many',
        thin.body?.coverage?.certifications?.expired >= 1 &&
          thin.body?.coverage?.certifications?.undated >= 1,
        JSON.stringify(thin.body?.coverage?.certifications)
      );
      check(
        'grouped by whoever issued them, for renewals',
        (thin.body?.coverage?.issuers ?? []).some((issuer) => issuer.name === 'CREST'),
        JSON.stringify(thin.body?.coverage?.issuers)
      );
      check(
        'languages are tallied, for who can run a workshop',
        (thin.body?.coverage?.languages ?? []).some(
          (language) => language.name === 'English' && language.people >= 2
        ),
        JSON.stringify(thin.body?.coverage?.languages)
      );
      check(
        'and experience is a median, so one veteran does not age the team',
        typeof thin.body?.coverage?.medianYears === 'number',
        JSON.stringify(thin.body?.coverage?.medianYears)
      );

      // Editing is yours, or an admin's. Bob is neither for Alice.
      const meddling = await call(bob, 'PUT', `/users/${alice.user._id}/profile`, {
        headline: 'Not my profile',
      });
      check(
        "a colleague cannot rewrite somebody else's skills",
        meddling.status === 403 && /own skills/i.test(meddling.body?.error ?? ''),
        `${meddling.status} ${meddling.body?.error}`
      );
      const asAdmin = await call(alice, 'PUT', `/users/${bob.user._id}/profile`, {
        headline: 'Set by an admin',
      });
      check('an admin can', asAdmin.body?.headline === 'Set by an admin', JSON.stringify(asAdmin.body?.headline));

      // Editing one part must not wipe the rest.
      const partial = await call(alice, 'PUT', `/users/${alice.user._id}/profile`, {
        headline: 'Lead tester — web, cloud and mobile',
      });
      check(
        'a partial save keeps the skills it did not mention',
        partial.body?.skills?.length === 2 && partial.body?.certifications?.length === 2,
        JSON.stringify({ skills: partial.body?.skills?.length, certs: partial.body?.certifications?.length })
      );

      // Certifications reach a report, because real reports name who tested.
      await call(alice, 'PUT', `/audits/${auditId}`, {});
      const reportData = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'a template can print what the author holds',
        (reportData.body?.creator?.qualifications ?? '').includes('OSCP'),
        JSON.stringify(reportData.body?.creator?.qualifications)
      );

      const { User: Users5 } = await import('../models/user.model.js');
      await Users5.updateMany(
        { _id: { $in: [alice.user._id, bob.user._id] } },
        { $unset: { profile: '' } }
      );
    }

    /* ------------------------------------------------------ pinned to the top --- */
    log.info('Pinning an engagement');
    {
      const before = await call(alice, 'GET', '/audits');
      check(
        'the list says whether each one is pinned',
        (before.body ?? []).every((entry) => typeof entry.pinned === 'boolean'),
        JSON.stringify(before.body?.[0]?.pinned)
      );

      const pinned = await call(alice, 'POST', `/audits/${auditId}/pin`, {});
      check('pinning works', pinned.body?.pinned === true, JSON.stringify(pinned.body));

      const sorted = await call(alice, 'GET', '/audits');
      check(
        'and it sorts to the top, whatever was touched most recently',
        sorted.body?.[0]?._id === auditId && sorted.body[0].pinned === true,
        JSON.stringify(sorted.body?.slice(0, 2).map((entry) => [entry.reference, entry.pinned]))
      );

      // A pin is one person's view of their own week, not a property of the engagement.
      const bobsList = await call(bob, 'GET', '/audits');
      check(
        "somebody else's list is untouched",
        (bobsList.body ?? []).every((entry) => entry.pinned === false),
        JSON.stringify(bobsList.body?.map((entry) => entry.pinned))
      );

      const again = await call(alice, 'POST', `/audits/${auditId}/pin`, {});
      check('the same call unpins', again.body?.pinned === false, JSON.stringify(again.body));

      // The cap, and the fact that it does not silently drop the ninth.
      const { Audit: Audits } = await import('../models/audit.model.js');
      const spares = await Audits.insertMany(
        Array.from({ length: 9 }, (_, index) => ({
          name: `zz Pin filler ${index}`,
          creator: alice.user._id,
        }))
      );
      const results = [];
      for (const spare of spares) {
        results.push((await call(alice, 'POST', `/audits/${spare._id}/pin`, {})).status);
      }
      check(
        'eight pins are allowed and the ninth is refused, by name',
        results.filter((status) => status === 200).length === 8 && results.at(-1) === 400,
        JSON.stringify(results)
      );

      const capped = await call(alice, 'GET', '/audits');
      check(
        'so the top of the list is still meaningful',
        capped.body.filter((entry) => entry.pinned).length === 8,
        JSON.stringify(capped.body.filter((entry) => entry.pinned).length)
      );

      // Pinning something you cannot see would leak that it exists.
      const outsider = await makeUser('pinner', 'user');
      const refused = await call(outsider, 'POST', `/audits/${auditId}/pin`, {});
      check('you cannot pin an engagement you are not on', refused.status === 403, `got ${refused.status}`);

      const { User: Users4 } = await import('../models/user.model.js');
      await Audits.deleteMany({ _id: { $in: spares.map((spare) => spare._id) } });
      await Users4.updateOne({ _id: alice.user._id }, { $set: { pinnedAudits: [] } });
      await Users4.deleteOne({ _id: outsider.user._id });
    }

    /* ------------------------------------------- findings spreadsheet -------- */
    log.info('Findings as a spreadsheet');
    {
      const PizZip = (await import('pizzip')).default;

      // Text that has broken every hand-rolled XML writer ever written.
      await call(alice, 'PUT', `/audits/${auditId}/findings/${findingId}`, {
        description: '<p>Ampersand &amp; angle &lt;brackets&gt; and a bell\u0007 plus a NUL\u0000.</p>',
        scope: '<p>https://x.example/?a=1&amp;b=2</p>',
      });

      const response = await fetch(`${base}/audits/${auditId}/findings.xlsx`, {
        headers: { Authorization: `Bearer ${alice.token}` },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      check(
        'the spreadsheet downloads',
        response.status === 200 && bytes.subarray(0, 2).toString() === 'PK',
        `${response.status}, ${bytes.length} bytes`
      );
      check(
        'as a real .xlsx, named after the engagement',
        (response.headers.get('content-type') ?? '').includes('spreadsheetml') &&
          /Findings/.test(response.headers.get('content-disposition') ?? ''),
        `${response.headers.get('content-type')} ${response.headers.get('content-disposition')}`
      );

      const zip = new PizZip(bytes);
      const parts = Object.keys(zip.files);
      check(
        'with the parts a workbook needs',
        ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].every(
          (name) => parts.includes(name)
        ),
        JSON.stringify(parts)
      );

      /*
       * Well-formedness, checked the way it actually breaks: an unbalanced tag, or text
       * that reached the file unescaped. Excel refuses the whole workbook for either, so a
       * silent failure here would be a download nobody can open.
       */
      let malformed = [];
      for (const name of parts.filter((entry) => entry.endsWith('.xml'))) {
        const xml = zip.file(name).asText();
        const stack = [];
        for (const match of xml.matchAll(/<(\/?)([A-Za-z_:][\w:.-]*)([^>]*?)(\/?)>/g)) {
          const [, closing, tag, attrs, selfClosing] = match;
          if (closing) {
            if (stack.pop() !== tag) malformed.push(`${name}: stray </${tag}>`);
          } else if (!selfClosing && !attrs.endsWith('/')) {
            stack.push(tag);
          }
        }
        if (stack.length) malformed.push(`${name}: unclosed ${stack.join('>')}`);
        if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(xml)) {
          malformed.push(`${name}: bare ampersand`);
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) {
          malformed.push(`${name}: control character`);
        }
      }
      check('every part is well-formed and Excel-safe', malformed.length === 0, malformed.join(' | '));

      const sheet = zip.file('xl/worksheets/sheet2.xml').asText();
      const rows = (sheet.match(/<row /g) ?? []).length;
      const audit = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'one row per finding, plus the header',
        rows === (audit.body?.findings?.length ?? 0) + 1,
        `${rows} rows for ${audit.body?.findings?.length} findings`
      );
      check(
        'the ampersand survived as an entity, not as itself',
        sheet.includes('&amp;') && !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(sheet),
        'escaping is wrong'
      );
      check(
        'severity is filled from the palette, and the header is frozen',
        /s="[4-8]"/.test(sheet) && sheet.includes('state="frozen"') && sheet.includes('<autoFilter'),
        'styling missing'
      );

      const summary = zip.file('xl/worksheets/sheet1.xml').asText();
      check(
        'the summary sheet carries the engagement and its counts',
        summary.includes('Findings by severity') && summary.includes('Remediation'),
        'summary sheet is thin'
      );

      // Exporting is reading, so it goes in the log like generating a report does.
      const exportLog = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'and the export is in the activity log',
        (exportLog.body?.entries ?? []).some(
          (entry) => entry.meta?.template === 'Findings spreadsheet'
        ),
        JSON.stringify(exportLog.body?.entries?.slice(0, 3).map((e) => e.meta))
      );
    }

    /* ------------------------------------------ links to a finding ----------- */
    log.info('A finding has its own URL');
    {
      // A mention on a finding must land on the finding, not on the list. This is what
      // findings having their own route is for.
      const tagged = await call(alice, 'POST', `/audits/${auditId}/findings/${findingId}/comments`, {
        body: `@${bob.user.username} take a look at this one`,
      });
      check('the mention posts', tagged.status === 201, JSON.stringify(tagged.body?.error));

      const bell = await call(bob, 'GET', '/notifications?limit=5');
      const latest = bell.body?.items?.[0];
      check(
        'and its notification links straight to the finding',
        latest?.href === `/engagements/${auditId}/findings/${findingId}`,
        latest?.href
      );

      const found = await call(alice, 'GET', '/search?q=Stored');
      const hit = (found.body?.results ?? []).find((entry) => entry.type === 'finding');
      check(
        'a search hit links to the finding too',
        Boolean(hit) && hit.href === `/engagements/${auditId}/findings/${hit.id}`,
        hit?.href
      );

      const forAlice = await call(alice, 'GET', '/inbox');
      const comment = (forAlice.body?.comments ?? []).find((entry) => entry.findingId === findingId);
      check(
        'and the inbox carries the finding id the link needs',
        Boolean(comment?.findingId),
        JSON.stringify(forAlice.body?.comments?.[0])
      );

      await call(bob, 'POST', '/notifications/read-all', {});
    }

    /* --------------------------------------------- insights, just mine ------- */
    log.info('Insights for one person');
    {
      const everyone = await call(alice, 'GET', '/insights?days=365');
      const alices = await call(alice, 'GET', '/insights?days=365&mine=1');
      const bobs = await call(bob, 'GET', '/insights?days=365&mine=1');

      check(
        'the personal view says it is personal',
        alices.body?.range?.mine === true && everyone.body?.range?.mine === false,
        JSON.stringify({ mine: alices.body?.range?.mine, all: everyone.body?.range?.mine })
      );
      check(
        'it counts no more than the whole instance does',
        alices.body.totals.findings <= everyone.body.totals.findings,
        `${alices.body.totals.findings} of ${everyone.body.totals.findings}`
      );
      check(
        'findings are counted by who wrote them, so Alice has hers',
        alices.body.totals.findings >= 1,
        JSON.stringify(alices.body?.totals)
      );
      check(
        'and Bob has none of them, though he is on the same engagement',
        bobs.body.totals.findings === 0 && bobs.body.totals.engagements >= 1,
        JSON.stringify(bobs.body?.totals)
      );
      check(
        'the severity split adds up to the personal total',
        Object.values(alices.body.bySeverity).reduce((sum, n) => sum + n, 0) ===
          alices.body.totals.findings,
        JSON.stringify(alices.body?.bySeverity)
      );
      check(
        'and so does the trend',
        alices.body.trend.reduce((sum, row) => sum + row.total, 0) === alices.body.totals.findings,
        `${alices.body.trend.reduce((sum, row) => sum + row.total, 0)} vs ${alices.body.totals.findings}`
      );

      // Somebody on no engagements gets an empty page rather than everybody else's.
      const nobody = await makeUser('nobody', 'user');
      const theirs = await call(nobody, 'GET', '/insights?days=365&mine=1');
      check(
        'somebody on nothing sees nothing',
        theirs.body?.totals?.findings === 0 && theirs.body?.totals?.engagements === 0,
        JSON.stringify(theirs.body?.totals)
      );
      const { User: Users3 } = await import('../models/user.model.js');
      await Users3.deleteOne({ _id: nobody.user._id });
    }

    /* ------------------------------------------------- utilisation ----------- */
    log.info('Utilisation on the Team page');
    {
      const { Booking: Books } = await import('../models/booking.model.js');
      const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

      await Books.deleteMany({ audit: auditId });
      await Books.insertMany([
        { audit: auditId, user: bob.user._id, start: day(-10), end: day(-6) },
        // Overlaps the first by two days, on the same engagement.
        { audit: auditId, user: bob.user._id, start: day(-8), end: day(-7) },
        // Entirely outside a 30-day window.
        { audit: auditId, user: bob.user._id, start: day(-120), end: day(-118) },
      ]);

      const team = await call(alice, 'GET', '/users/engagements?days=30');
      check('the team view loads', team.status === 200, JSON.stringify(team.body?.error));
      const bobs = (team.body?.users ?? []).find((entry) => entry.username === bob.user.username);

      check(
        'overlapping bookings count as the days they occupy, not their sum',
        bobs?.booked?.days === 5,
        JSON.stringify(bobs?.booked)
      );
      check(
        'and the double-booked days are reported separately',
        bobs?.booked?.clashDays === 2,
        JSON.stringify(bobs?.booked?.clashDays)
      );
      check(
        'a booking outside the window is outside the window',
        bobs?.booked?.days === 5,
        'the 120-day-old booking leaked into a 30-day window'
      );
      check(
        'utilisation is days booked over the window’s weekdays',
        bobs?.booked?.utilisation ===
          Math.round((bobs.booked.days / team.body.window.workingDays) * 100),
        JSON.stringify({ util: bobs?.booked?.utilisation, weekdays: team.body?.window?.workingDays })
      );
      check(
        'the window says what it measured',
        Boolean(team.body?.window?.from && team.body?.window?.to) &&
          team.body.window.workingDays > 0 &&
          team.body.window.workingDays <= 30,
        JSON.stringify(team.body?.window)
      );

      // A wider window keeps the same bookings but a larger denominator, so the
      // percentage must fall — and the older booking now counts.
      const wider = await call(alice, 'GET', '/users/engagements?days=365');
      const bobsWider = (wider.body?.users ?? []).find(
        (entry) => entry.username === bob.user.username
      );
      check(
        'a wider window picks up the older booking',
        bobsWider?.booked?.days === 8,
        JSON.stringify(bobsWider?.booked)
      );
      check(
        'and utilisation falls as the window grows',
        bobsWider.booked.utilisation < bobs.booked.utilisation,
        `${bobsWider.booked.utilisation}% vs ${bobs.booked.utilisation}%`
      );

      const unbooked = (team.body?.users ?? []).find(
        (entry) => entry.username === alice.user.username
      );
      check(
        'somebody with nothing booked has no rate rather than a rate of zero',
        unbooked?.booked?.days === 0 && unbooked?.booked?.findingsPerDay === null,
        JSON.stringify(unbooked?.booked)
      );

      check(
        'days booked per engagement reach the row that expands',
        (bobs.engagements ?? []).some((entry) => entry.bookedDays === 5),
        JSON.stringify(bobs.engagements?.map((e) => [e.reference, e.bookedDays]))
      );

      const notAdmin = await call(bob, 'GET', '/users/engagements?days=30');
      check('and none of it is readable by a non-admin', notAdmin.status === 403, `got ${notAdmin.status}`);

      await Books.deleteMany({ audit: auditId });
    }

    /* --------------------------------------------------- drawn signatures ------ */
    log.info('Signatures');
    {
      const { Signature } = await import('../models/signature.model.js');
      await Signature.deleteMany({ audit: auditId });

      // A real 30x10 PNG, the shape a canvas produces.
      const PNG =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAKCAYAAABWCXfoAAAAKUlEQVR42mNgQAP/GfAAJgYCYFTBqIJRBaMKRhWMKhhVMKpgVMHwUQAAmB0FAY6q3ycAAAAASUVORK5CYII=';

      const empty = await call(bob, 'GET', `/audits/${auditId}/signatures`);
      check(
        'an engagement starts unsigned',
        empty.status === 200 && (empty.body?.signatures ?? []).length === 0,
        JSON.stringify(empty.body)
      );

      const signed = await call(bob, 'POST', `/audits/${auditId}/signatures`, {
        image: PNG,
        role: 'Tested by',
        title: 'Security Consultant',
        statement: 'I confirm the testing was carried out as described.',
      });
      check('somebody on the engagement can sign it', signed.status === 201, JSON.stringify(signed.body?.error));
      check(
        'their name and title are captured as they are now',
        signed.body?.name?.includes('Collab') && signed.body?.title === 'Security Consultant',
        JSON.stringify({ name: signed.body?.name, title: signed.body?.title })
      );
      check(
        'and dated today unless told otherwise',
        signed.body?.signedOn === new Date().toISOString().slice(0, 10),
        JSON.stringify(signed.body?.signedOn)
      );

      // Signing again corrects your own mark rather than adding a second one.
      const again = await call(bob, 'POST', `/audits/${auditId}/signatures`, {
        image: PNG,
        role: 'Reviewed by',
      });
      check(
        'signing again replaces it',
        again.status === 201 &&
          (await Signature.countDocuments({ audit: auditId, user: bob.user._id })) === 1 &&
          again.body?.role === 'Reviewed by',
        JSON.stringify({ role: again.body?.role })
      );

      const notAnImage = await call(bob, 'POST', `/audits/${auditId}/signatures`, {
        image: 'data:text/html;base64,PHNjcmlwdD4=',
      });
      check('only a drawn PNG is accepted', notAnImage.status === 422, `got ${notAnImage.status}`);

      const huge = await call(bob, 'POST', `/audits/${auditId}/signatures`, {
        image: `data:image/png;base64,${'A'.repeat(500_000)}`,
      });
      check('and not a photograph of a whole page', huge.status === 422, `got ${huge.status}`);

      /* --------------------------------- nobody signs for anybody else */
      const others = await Signature.find({ audit: auditId });
      const bobsSignature = others[0];
      const forged = await call(
        alice,
        'DELETE',
        `/audits/${auditId}/signatures/${bobsSignature._id}`
      );
      check(
        'an admin may remove a signature — somebody has to be able to',
        forged.status === 200,
        JSON.stringify(forged.body)
      );
      // There is no route that writes one for somebody else: the only thing a POST can create
      // is the caller's own, so re-signing as alice makes alice's, not bob's.
      const asAlice = await call(alice, 'POST', `/audits/${auditId}/signatures`, { image: PNG });
      check(
        'and a signature always belongs to whoever drew it',
        String(asAlice.body?.user?._id ?? asAlice.body?.user) === String(alice.user._id),
        JSON.stringify(asAlice.body?.user)
      );

      await call(bob, 'POST', `/audits/${auditId}/signatures`, { image: PNG, role: 'Tested by' });
      const bobRemovesAlice = await call(
        bob,
        'DELETE',
        `/audits/${auditId}/signatures/${asAlice.body._id}`
      );
      check(
        'and only its owner or an admin can remove it',
        bobRemovesAlice.status === 403,
        `got ${bobRemovesAlice.status}`
      );

      /* ------------------------------------------------- in the report */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data?target=html`);
      check(
        'a template can print the sign-off page',
        data.body?.hasSignatures === true && (data.body?.signatures ?? []).length === 2,
        JSON.stringify(data.body?.signatures?.map((row) => row.name))
      );
      check(
        'with one tag for the whole block, as real images',
        typeof data.body?.rich?.signatures === 'string' &&
          data.body.rich.signatures.includes('data:image/png') &&
          data.body.rich.signatures.includes('Tested by'),
        JSON.stringify(data.body?.rich?.signatures?.slice(0, 80))
      );
      check(
        'and the date formatted like every other date in the report',
        (data.body?.signatures ?? []).every((row) => typeof row.date === 'string' && row.date),
        JSON.stringify(data.body?.signatures?.map((row) => row.date))
      );

      const log7 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'signing is in the engagement’s log',
        (log7.body?.entries ?? []).some((entry) => entry.action === 'signature.added'),
        JSON.stringify((log7.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      const outsider = await makeUser('signer', 'user');
      const peek = await call(outsider, 'GET', `/audits/${auditId}/signatures`);
      check('somebody off the engagement cannot read them', peek.status === 403, `got ${peek.status}`);

      await Signature.deleteMany({ audit: auditId });
    }

    /* --------------------------------- reusing the signature you drew before --- */
    log.info('Signature reuse');
    {
      const { Signature: Signatures } = await import('../models/signature.model.js');
      await Signatures.deleteMany({ user: { $in: [alice.user._id, bob.user._id] } });

      const PNG2 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAKCAYAAABWCXfoAAAAKUlEQVR42mNgQAP/GfAAJgYCYFTBqIJRBaMKRhWMKhhVMKpgVMHwUQAAmB0FAY6q3ycAAAAASUVORK5CYII=';

      const second = await call(alice, 'POST', '/audits', {
        name: 'zz-reuse The next engagement',
        reference: 'ZZ-REUSE',
        collaborators: [bob.user._id.toString()],
      });
      const secondId = second.body?._id;
      check('a second engagement to sign', second.status === 201, JSON.stringify(second.body?.error));

      // Nothing drawn anywhere yet: there is nothing to offer, and the offer must not
      // appear as an empty card in the pane.
      const nothingYet = await call(bob, 'GET', `/audits/${secondId}/signatures`);
      check(
        'somebody who has never signed is offered nothing to reuse',
        nothingYet.status === 200 && nothingYet.body?.previous === null,
        JSON.stringify(nothingYet.body?.previous)
      );

      await call(bob, 'POST', `/audits/${auditId}/signatures`, {
        image: PNG2,
        role: 'Tested by',
        title: 'Security Consultant',
        statement: 'I confirm the testing was carried out as described.',
      });

      const offered = await call(bob, 'GET', `/audits/${secondId}/signatures`);
      check(
        'once you have signed one engagement, the next offers it back',
        offered.body?.previous?.image === PNG2,
        JSON.stringify(offered.body?.previous?.image?.slice(0, 32))
      );
      check(
        'with the wording you used last time, so the fields come prefilled',
        offered.body?.previous?.role === 'Tested by' &&
          offered.body?.previous?.title === 'Security Consultant' &&
          offered.body?.previous?.statement?.startsWith('I confirm'),
        JSON.stringify(offered.body?.previous)
      );

      /*
       * The one rule that matters here. A route that handed back somebody else's drawing
       * would be handing out a forgery kit, so it is asserted rather than assumed: alice
       * is an admin, on the engagement bob signed, and still gets nothing.
       */
      const asAdmin = await call(alice, 'GET', `/audits/${secondId}/signatures`);
      check(
        'and never anybody else’s, admin or not',
        asAdmin.body?.previous === null,
        JSON.stringify(asAdmin.body?.previous)
      );

      const reused = await call(bob, 'POST', `/audits/${secondId}/signatures`, {
        image: offered.body.previous.image,
        role: offered.body.previous.role,
        title: offered.body.previous.title,
      });
      check('reusing it signs this engagement', reused.status === 201, JSON.stringify(reused.body?.error));

      // The record stays per engagement: reuse copies the drawing, it does not share one
      // signature between two documents, so removing it here leaves the other standing.
      check(
        'as a record of its own, not a link to the old one',
        (await Signatures.countDocuments({ user: bob.user._id })) === 2,
        `${await Signatures.countDocuments({ user: bob.user._id })} rows`
      );

      const done = await call(bob, 'GET', `/audits/${secondId}/signatures`);
      check(
        'and the offer goes away once you have signed here',
        done.body?.previous === null && (done.body?.signatures ?? []).length === 1,
        JSON.stringify({ previous: done.body?.previous, signed: done.body?.signatures?.length })
      );

      await Signatures.deleteMany({ audit: secondId });
      await Signatures.deleteMany({ audit: auditId });
      await Activity.deleteMany({ audit: secondId });
      await Audit.deleteMany({ name: /^zz-reuse/ });
    }

    /* ------------------------------------------ a booking that starts soon ----- */
    log.info('Booking reminders');
    {
      const { Booking: Books2 } = await import('../models/booking.model.js');
      const { Notification: Notify2 } = await import('../models/notification.model.js');
      const { remindUpcomingBookings } = await import(
        '../services/booking-reminders.service.js'
      );

      // A fixed "now" so the wording can be asserted. Days are yyyy-mm-dd strings
      // everywhere in this app precisely so this is a string comparison, not a clock.
      const NOW = new Date('2026-09-07T09:00:00Z');
      const day = (offset) =>
        new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

      await Books2.deleteMany({ audit: auditId });
      await Notify2.deleteMany({ user: bob.user._id, type: 'booking-soon' });

      const soon = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        start: day(1),
        end: day(3),
        note: 'kick-off call at 10',
      });
      const later = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        start: day(20),
        end: day(21),
      });
      check(
        'two bookings, one soon and one not',
        soon.status === 201 && later.status === 201,
        JSON.stringify({ soon: soon.status, later: later.status })
      );

      const first = await remindUpcomingBookings({ now: NOW });
      check('the sweep reminds about the near one', first.sent === 1, JSON.stringify(first));

      const notices = await Notify2.find({ user: bob.user._id, type: 'booking-soon' });
      check(
        'and says which day it is, in words',
        notices.length === 1 && /tomorrow/.test(notices[0].message),
        JSON.stringify(notices.map((n) => n.message))
      );
      check(
        'with the note, which is where "starting where" usually lives',
        /kick-off call at 10/.test(notices[0]?.message ?? ''),
        JSON.stringify(notices[0]?.message)
      );
      check(
        'and a link to the schedule rather than nowhere',
        notices[0]?.href === '/schedule',
        JSON.stringify(notices[0]?.href)
      );

      // The whole point of the marker. This sweep runs on boot, on a timer and from a
      // scheduled task, so running it three times in a morning must not send three.
      await remindUpcomingBookings({ now: NOW });
      await remindUpcomingBookings({ now: NOW });
      check(
        'sweeping again says nothing — three reminders is spam',
        (await Notify2.countDocuments({ user: bob.user._id, type: 'booking-soon' })) === 1,
        `${await Notify2.countDocuments({ user: bob.user._id, type: 'booking-soon' })} notices`
      );
      check(
        'and the far booking is still waiting its turn',
        (await Books2.findById(later.body._id)).reminderSentAt === null,
        JSON.stringify((await Books2.findById(later.body._id)).reminderSentAt)
      );

      // One that starts this morning is still worth saying — worded as the day it is.
      const starting = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        start: day(0),
        end: day(2),
      });
      const midway = await remindUpcomingBookings({ now: NOW });
      const latest = (
        await Notify2.find({ user: bob.user._id, type: 'booking-soon' }).sort({ _id: -1 })
      )[0];
      check(
        'one starting this morning is worded as today, not as a date',
        midway.sent === 1 && /today/.test(latest?.message ?? ''),
        JSON.stringify({ midway, message: latest?.message })
      );

      // A booking already under way is left alone: telling somebody about the work they
      // are in the middle of is the noise that makes the bell worth muting.
      await Books2.create({
        audit: auditId,
        user: bob.user._id,
        start: day(-2),
        end: day(2),
        createdBy: bob.user._id,
      });
      const running = await remindUpcomingBookings({ now: NOW });
      check(
        'and one already under way is not mentioned at all',
        running.sent === 0 && running.skipped === 0,
        JSON.stringify(running)
      );

      /* ------------------------------- moving it makes it news again */
      const moved = await call(alice, 'PUT', `/schedule/${later.body._id}`, {
        start: day(1),
        end: day(2),
      });
      check('an admin can move somebody’s booking', moved.status === 200, JSON.stringify(moved.body?.error));
      const afterMove = await remindUpcomingBookings({ now: NOW });
      check(
        'a booking moved into the window is reminded about',
        afterMove.sent === 1,
        JSON.stringify(afterMove)
      );

      /* ------------------------------- trashed and expired are silent */
      const trashed = await call(alice, 'POST', '/audits', {
        name: 'zz-remind Trashed engagement',
        reference: 'ZZ-REMIND',
        collaborators: [bob.user._id.toString()],
      });
      const trashedId = trashed.body?._id;
      const onTrashed = await call(bob, 'POST', '/schedule', {
        audit: trashedId,
        start: day(1),
        end: day(2),
      });
      await call(alice, 'DELETE', `/audits/${trashedId}`);
      const swept = await remindUpcomingBookings({ now: NOW });
      check(
        'nobody is reminded to work on a trashed engagement',
        swept.sent === 0 && swept.skipped === 1,
        JSON.stringify(swept)
      );
      check(
        'and it is marked, so it is not retried for ever',
        Boolean((await Books2.findById(onTrashed.body._id)).reminderSentAt),
        'the skipped booking will be re-examined on every sweep'
      );

      // Access with an end date exists; a reminder to do work you are locked out of is
      // worse than silence.
      const expired = await call(alice, 'POST', '/audits', {
        name: 'zz-remind Expired access',
        reference: 'ZZ-REMIND-2',
        collaborators: [bob.user._id.toString()],
        memberUntil: [{ user: bob.user._id.toString(), until: day(-1) }],
      });
      const onExpired = await Books2.create({
        audit: expired.body._id,
        user: bob.user._id,
        start: day(1),
        end: day(2),
        createdBy: alice.user._id,
      });
      const afterExpiry = await remindUpcomingBookings({ now: NOW });
      check(
        'nor to work they can no longer open',
        afterExpiry.sent === 0 && afterExpiry.skipped === 1,
        JSON.stringify(afterExpiry)
      );

      /* ------------------------------- somebody else changing your week */
      await Notify2.deleteMany({ user: bob.user._id, type: 'booking-changed' });
      await Notify2.deleteMany({ user: alice.user._id, type: 'booking-changed' });

      const bobsOwn = await call(bob, 'POST', '/schedule', {
        audit: auditId,
        start: day(30),
        end: day(31),
      });
      check(
        'booking your own time tells you nothing — you were there',
        (await Notify2.countDocuments({ user: bob.user._id, type: 'booking-changed' })) === 0,
        'told somebody what they had just done'
      );

      const forBob = await call(alice, 'POST', '/schedule', {
        audit: auditId,
        user: bob.user._id.toString(),
        start: day(40),
        end: day(41),
      });
      const booked = await Notify2.find({ user: bob.user._id, type: 'booking-changed' });
      check(
        'being booked by somebody else is worth knowing',
        booked.length === 1 && /booked your time/.test(booked[0].message),
        JSON.stringify(booked.map((n) => n.message))
      );
      check(
        'and the message says which engagement and which days',
        booked[0]?.message?.includes('ZZ-TEST') && booked[0]?.message?.includes(day(40)),
        JSON.stringify(booked[0]?.message)
      );

      await call(alice, 'PUT', `/schedule/${forBob.body._id}`, { start: day(41), end: day(42) });
      check(
        'moving it tells them again',
        (await Notify2.countDocuments({ user: bob.user._id, type: 'booking-changed' })) === 2,
        `${await Notify2.countDocuments({ user: bob.user._id, type: 'booking-changed' })} notices`
      );

      // Editing without moving the days is not a change to somebody's week.
      await call(alice, 'PUT', `/schedule/${forBob.body._id}`, {
        start: day(41),
        end: day(42),
        note: 'bring the laptop',
      });
      check(
        'changing only the note does not',
        (await Notify2.countDocuments({ user: bob.user._id, type: 'booking-changed' })) === 2,
        `${await Notify2.countDocuments({ user: bob.user._id, type: 'booking-changed' })} notices`
      );

      await call(alice, 'DELETE', `/schedule/${forBob.body._id}`);
      const cancelled = await Notify2.find({ user: bob.user._id, type: 'booking-changed' }).sort({
        _id: -1,
      });
      check(
        'and cancelling it certainly does',
        cancelled.length === 3 && /cancelled your time/.test(cancelled[0].message),
        JSON.stringify(cancelled[0]?.message)
      );

      // The person whose time it is, and nobody else — one edit, one person told.
      check(
        'the person who made the change hears nothing about it',
        (await Notify2.countDocuments({ user: alice.user._id, type: 'booking-changed' })) === 0,
        'the actor was notified of their own edit'
      );

      await call(bob, 'DELETE', `/schedule/${bobsOwn.body._id}`);
      await Books2.deleteMany({ audit: auditId });
      await Books2.deleteOne({ _id: onExpired._id });
      await Notify2.deleteMany({ user: { $in: [alice.user._id, bob.user._id] } });
      await Activity.deleteMany({ audit: { $in: [trashedId, expired.body._id] } });
      await Audit.deleteMany({ name: /^zz-remind/ });
    }

    /* ---------------------------------------------------- time off -------------- */
    log.info('Time off');
    {
      const { Leave } = await import('../models/leave.model.js');
      const { Booking: Books3 } = await import('../models/booking.model.js');
      const { Notification: Notify3 } = await import('../models/notification.model.js');
      const { Settings: Config } = await import('../models/settings.model.js');
      const {
        leaveDayMap,
        availableDaysFor,
        allowanceUsage,
        weekdaysBetween,
      } = await import('../services/leave.service.js');

      /*
       * Only ever this run's own rows.
       *
       * A blanket `deleteMany({})` here would wipe the holidays of a live instance — the
       * same mistake the settings block made once by calling the real reset endpoint. Public
       * holidays have no owner, so they are matched by who created them.
       */
      const ours = {
        $or: [
          { user: { $in: [alice.user._id, bob.user._id] } },
          { createdBy: { $in: [alice.user._id, bob.user._id] } },
        ],
      };
      await Leave.deleteMany(ours);
      await Books3.deleteMany({ audit: auditId });
      await Notify3.deleteMany({ user: { $in: [alice.user._id, bob.user._id] } });

      // A fixed fortnight, chosen so it starts on a Monday: the whole point of the
      // denominator is which days are weekdays, so the test cannot leave that to chance.
      const MON = '2028-09-04';
      const FRI = '2028-09-08';
      const NEXT_MON = '2028-09-11';
      const NEXT_FRI = '2028-09-15';
      const SAT = '2028-09-09';
      const SUN = '2028-09-10';

      check(
        'a fortnight of weekdays is ten days, not fourteen',
        weekdaysBetween(MON, NEXT_FRI) === 10,
        `${weekdaysBetween(MON, NEXT_FRI)}`
      );

      /* ------------------------------------------------ asking, and being told */
      const asked = await call(bob, 'POST', '/leave', {
        start: MON,
        end: FRI,
        type: 'holiday',
        note: 'wedding in Cluj',
      });
      check('anybody can ask for time off', asked.status === 201, JSON.stringify(asked.body?.error));
      check(
        'and it waits for a decision rather than landing on the calendar',
        asked.body?.status === 'requested',
        JSON.stringify(asked.body?.status)
      );
      check(
        'costed in working days, so a week is five and not seven',
        asked.body?.workingDays === 5,
        JSON.stringify(asked.body?.workingDays)
      );
      check(
        'the admins hear about it',
        (await Notify3.countDocuments({ user: alice.user._id, type: 'leave-requested' })) === 1,
        'nobody was told there was something to approve'
      );

      const bobsLeave = asked.body._id;

      // The reason is the one part that is not shared. That somebody is away is what a
      // shared calendar is for; why they are away is between them and whoever approves it.
      const outsider2 = await makeUser('nosy', 'user');
      const seenByOther = await call(outsider2, 'GET', `/leave?from=${MON}&to=${NEXT_FRI}`);
      const theirRow = (seenByOther.body?.leave ?? []).find((row) => row._id === bobsLeave);
      check(
        'a colleague sees that somebody is away',
        Boolean(theirRow) && theirRow.start === MON,
        JSON.stringify(theirRow)
      );
      check(
        'but not why — and is told a reason exists rather than that there is none',
        theirRow?.note === '' && theirRow?.noteHidden === true,
        JSON.stringify({ note: theirRow?.note, hidden: theirRow?.noteHidden })
      );
      const seenByAdmin = await call(alice, 'GET', `/leave?from=${MON}&to=${NEXT_FRI}`);
      check(
        'whoever has to decide can read it',
        (seenByAdmin.body?.leave ?? []).find((row) => row._id === bobsLeave)?.note ===
          'wedding in Cluj',
        JSON.stringify((seenByAdmin.body?.leave ?? []).find((row) => row._id === bobsLeave)?.note)
      );

      const notMine = await call(outsider2, 'POST', `/leave/${bobsLeave}/decision`, {
        status: 'approved',
      });
      check('somebody who is not an admin cannot approve it', notMine.status === 403, `got ${notMine.status}`);

      const decided = await call(alice, 'POST', `/leave/${bobsLeave}/decision`, {
        status: 'approved',
      });
      check('an admin can', decided.status === 200 && decided.body?.status === 'approved', JSON.stringify(decided.body));
      check(
        'and the person is told what was decided',
        (await Notify3.countDocuments({ user: bob.user._id, type: 'leave-decided' })) === 1,
        'a decision nobody hears about is a page nobody has open'
      );

      /* ------------------------------------------------ what a day off is worth */
      const weekend = await call(bob, 'POST', '/leave', { start: SAT, end: SUN, type: 'holiday' });
      check(
        'a weekend off costs nothing, and says so',
        weekend.body?.workingDays === 0,
        JSON.stringify(weekend.body?.workingDays)
      );

      const halfInAFortnight = await call(bob, 'POST', '/leave', {
        start: MON,
        end: FRI,
        portion: 'am',
      });
      check(
        'a half-day fortnight is refused — it is a full one with extra steps',
        halfInAFortnight.status >= 400,
        `got ${halfInAFortnight.status}`
      );

      const half = await call(alice, 'POST', '/leave', {
        start: NEXT_MON,
        end: NEXT_MON,
        portion: 'pm',
        type: 'holiday',
      });
      check(
        'half a day is half a day',
        half.status === 201 && half.body?.workingDays === 0.5,
        JSON.stringify({ status: half.status, days: half.body?.workingDays })
      );
      check(
        'an admin recording their own leave is recording a decision, not asking for one',
        half.body?.status === 'approved',
        JSON.stringify(half.body?.status)
      );

      /* ------------------------------------------------ public holidays */
      const notAdmin = await call(bob, 'POST', '/leave', {
        start: NEXT_FRI,
        end: NEXT_FRI,
        type: 'public-holiday',
      });
      check('only an admin declares a public holiday', notAdmin.status === 403, `got ${notAdmin.status}`);

      const bankHoliday = await call(alice, 'POST', '/leave', {
        start: NEXT_FRI,
        end: NEXT_FRI,
        type: 'public-holiday',
        note: 'Founders’ day',
      });
      check(
        'a public holiday belongs to everybody rather than to a person',
        bankHoliday.status === 201 && bankHoliday.body?.userId === '',
        JSON.stringify({ status: bankHoliday.status, user: bankHoliday.body?.userId })
      );

      /* ------------------------------------------------ the denominator */
      const rows = await Leave.find(ours);
      const dayMap = leaveDayMap(rows, MON, NEXT_FRI);
      const bobDays = availableDaysFor(bob.user._id, MON, NEXT_FRI, dayMap);
      check(
        'somebody’s week off comes out of their available days, and the public holiday too',
        bobDays.available === 4 && bobDays.off === 6,
        JSON.stringify(bobDays)
      );
      const aliceDays = availableDaysFor(alice.user._id, MON, NEXT_FRI, dayMap);
      check(
        'a half day costs half a day of availability',
        aliceDays.available === 8.5 && aliceDays.off === 1.5,
        JSON.stringify(aliceDays)
      );

      // The whole reason both live in one collection: a person's own holiday landing on a
      // public holiday must cost the day once, not twice.
      await Leave.create({
        user: bob.user._id,
        start: NEXT_FRI,
        end: NEXT_FRI,
        type: 'holiday',
        status: 'approved',
      });
      const doubled = availableDaysFor(
        bob.user._id,
        MON,
        NEXT_FRI,
        leaveDayMap(await Leave.find(ours), MON, NEXT_FRI)
      );
      check(
        'a holiday on a public holiday costs the day once, not twice',
        doubled.available === 4 && doubled.off === 6,
        JSON.stringify(doubled)
      );

      // A request nobody has answered is not yet a day off; counting it would flatter the
      // utilisation of anybody with a pending fortnight.
      await Leave.create({
        user: bob.user._id,
        start: '2028-10-02',
        end: '2028-10-06',
        type: 'holiday',
        status: 'requested',
      });
      const pendingOnly = availableDaysFor(
        bob.user._id,
        '2028-10-02',
        '2028-10-06',
        leaveDayMap(await Leave.find(ours), '2028-10-02', '2028-10-06')
      );
      check(
        'an undecided request is not a day off yet',
        pendingOnly.available === 5 && pendingOnly.off === 0,
        JSON.stringify(pendingOnly)
      );

      /* ------------------------------------------------ the allowance */
      const balance = await allowanceUsage(bob.user._id, 2028, 25);
      check(
        'the balance counts what was approved and reports what is pending separately',
        balance.taken === 6 && balance.pending === 5 && balance.remaining === 19,
        JSON.stringify(balance)
      );

      await Leave.create({
        user: bob.user._id,
        start: '2028-11-06',
        end: '2028-11-10',
        type: 'sick',
        status: 'approved',
      });
      const afterSickness = await allowanceUsage(bob.user._id, 2028, 25);
      check(
        'sickness does not come off a holiday allowance',
        afterSickness.taken === balance.taken,
        JSON.stringify(afterSickness)
      );

      const noAllowance = await allowanceUsage(bob.user._id, 2028, null);
      check(
        'and with no allowance configured the balance is unknown, not zero',
        noAllowance.remaining === null && noAllowance.taken === balance.taken,
        JSON.stringify(noAllowance)
      );

      /* ------------------------------------------------ booking over it */
      const overHoliday = await call(alice, 'POST', '/schedule', {
        audit: auditId,
        user: bob.user._id.toString(),
        start: MON,
        end: FRI,
      });
      check(
        'a booking over somebody’s holiday is recorded, not refused',
        overHoliday.status === 201,
        JSON.stringify(overHoliday.body?.error)
      );
      check(
        'and the clash comes back to whoever booked it',
        /5 days of holiday/.test(overHoliday.body?.warning ?? ''),
        JSON.stringify(overHoliday.body?.warning)
      );
      check(
        // The verb used to agree with the number of clashes rather than the subject, so one
        // clash produced "You already has" and two produced "Priya already have".
        'and it agrees with whoever it is about',
        (overHoliday.body?.warning ?? '').includes('already has'),
        JSON.stringify(overHoliday.body?.warning)
      );
      const told = await Notify3.find({ user: bob.user._id, type: 'booking-changed' }).sort({
        _id: -1,
      });
      check(
        'the person whose week it is hears the clash in the same notice, not a second one',
        told.length === 1 && /holiday/.test(told[0].message),
        JSON.stringify(told.map((n) => n.message))
      );

      const clear = await call(alice, 'POST', '/schedule', {
        audit: auditId,
        user: bob.user._id.toString(),
        start: '2028-12-01',
        end: '2028-12-04',
      });
      check(
        'a booking on a clear week says nothing about leave',
        clear.body?.warning === null || clear.body?.warning === undefined,
        JSON.stringify(clear.body?.warning)
      );

      /* ------------------------------------------------ on the schedule */
      const calendar = await call(bob, 'GET', `/schedule?from=${MON}&to=${NEXT_FRI}`);
      check(
        'the calendar comes back with the leave beside the bookings',
        (calendar.body?.leave ?? []).length >= 3,
        JSON.stringify((calendar.body?.leave ?? []).length)
      );
      check(
        'and with what the window is worth to whoever asked',
        calendar.body?.capacity?.weekdays === 10 && calendar.body?.capacity?.available === 4,
        JSON.stringify(calendar.body?.capacity)
      );
      check(
        'declined and cancelled rows are history, not the calendar',
        (calendar.body?.leave ?? []).every((row) => row.status !== 'declined'),
        JSON.stringify((calendar.body?.leave ?? []).map((row) => row.status))
      );

      /* ------------------------------------------------ withdrawing and cancelling */
      const fresh = await call(bob, 'POST', '/leave', { start: '2028-12-21', end: '2028-12-22' });
      const withdrawn = await call(bob, 'DELETE', `/leave/${fresh.body._id}`);
      check(
        'a request nobody answered is simply withdrawn',
        withdrawn.body?.removed === true &&
          (await Leave.countDocuments({ _id: fresh.body._id })) === 0,
        JSON.stringify(withdrawn.body)
      );

      const cancelled = await call(bob, 'DELETE', `/leave/${bobsLeave}`);
      check(
        'one that was approved is kept as cancelled — an approval is a decision somebody made',
        cancelled.body?.removed === false &&
          (await Leave.findById(bobsLeave))?.status === 'cancelled',
        JSON.stringify(cancelled.body)
      );

      const editApproved = await call(bob, 'PUT', `/leave/${bobsLeave}`, { end: '2028-09-25' });
      check(
        'and cannot be quietly edited after the fact',
        editApproved.status === 400,
        `got ${editApproved.status}`
      );

      const someoneElses = await call(outsider2, 'DELETE', `/leave/${half.body._id}`);
      check(
        'nobody cancels somebody else’s time off',
        someoneElses.status === 403,
        `got ${someoneElses.status}`
      );

      /* ------------------------------------------------ the reminder says so */
      await Notify3.deleteMany({ user: bob.user._id, type: 'booking-soon' });
      await Books3.deleteMany({ audit: auditId });
      const { remindUpcomingBookings: remind } = await import(
        '../services/booking-reminders.service.js'
      );
      await Leave.create({
        user: bob.user._id,
        start: '2028-03-06',
        end: '2028-03-07',
        type: 'holiday',
        status: 'approved',
      });
      await Books3.create({
        audit: auditId,
        user: bob.user._id,
        start: '2028-03-06',
        end: '2028-03-07',
        createdBy: alice.user._id,
      });
      const reminded = await remind({ now: new Date('2028-03-05T09:00:00Z') });
      const notice = await Notify3.findOne({ user: bob.user._id, type: 'booking-soon' }).sort({
        _id: -1,
      });
      check(
        'a reminder about a day you are also on holiday says which it is',
        reminded.sent === 1 && /holiday/.test(notice?.message ?? ''),
        JSON.stringify({ reminded, message: notice?.message })
      );

      /* ------------------------------------------------ the settings that govern it */
      const config = await Config.getSettings();
      const wasApproval = config.leave?.requireApproval;
      const offered = await call(alice, 'PUT', '/settings', {
        leave: { requireApproval: false, allowanceDays: 28 },
      });
      check(
        'the allowance and the approval rule are instance settings',
        offered.status === 200 &&
          offered.body?.leave?.allowanceDays === 28 &&
          offered.body?.leave?.requireApproval === false,
        JSON.stringify(offered.body?.leave)
      );
      const noApproval = await call(bob, 'POST', '/leave', {
        start: '2028-04-05',
        end: '2028-04-06',
      });
      check(
        'with approval turned off, time off lands on the calendar straight away',
        noApproval.body?.status === 'approved',
        JSON.stringify(noApproval.body?.status)
      );
      // Put the instance back the way it was found, exactly like the settings-log block.
      await call(alice, 'PUT', '/settings', {
        leave: { requireApproval: wasApproval !== false, allowanceDays: config.leave?.allowanceDays ?? 25 },
      });
      const restored = await Config.getSettings();
      check(
        'and the test leaves the instance’s own settings alone',
        restored.leave?.allowanceDays === (config.leave?.allowanceDays ?? 25),
        JSON.stringify(restored.leave)
      );

      await Leave.deleteMany(ours);
      await Books3.deleteMany({ audit: auditId });
      await Notify3.deleteMany({ user: { $in: [alice.user._id, bob.user._id] } });
    }

    /* -------------------------------- who is free, and who is free and able ----- */
    log.info('Staffing');
    {
      const { Leave: Leaves2 } = await import('../models/leave.model.js');
      const { Booking: Books4 } = await import('../models/booking.model.js');

      const ours2 = {
        $or: [
          { user: { $in: [alice.user._id, bob.user._id] } },
          { createdBy: { $in: [alice.user._id, bob.user._id] } },
        ],
      };
      await Leaves2.deleteMany(ours2);
      await Books4.deleteMany({ audit: auditId });

      // A fortnight starting on a Monday, well clear of anything a live instance holds.
      const MON = '2029-09-03';
      const FRI = '2029-09-07';
      const NEXT_MON = '2029-09-10';
      const NEXT_FRI = '2029-09-14';

      // Bob: booked the first week, on holiday the Monday of the second.
      await Books4.create({
        audit: auditId,
        user: bob.user._id,
        start: MON,
        end: FRI,
        createdBy: alice.user._id,
      });
      await Leaves2.create({
        user: bob.user._id,
        start: NEXT_MON,
        end: NEXT_MON,
        type: 'holiday',
        status: 'approved',
        createdBy: bob.user._id,
      });
      // And a request nobody has answered, which must not count as a day off.
      await Leaves2.create({
        user: bob.user._id,
        start: NEXT_FRI,
        end: NEXT_FRI,
        type: 'holiday',
        status: 'requested',
        createdBy: bob.user._id,
      });

      const free = await call(bob, 'GET', `/schedule/availability?from=${MON}&to=${NEXT_FRI}`);
      check('anybody signed in can ask who is free', free.status === 200, JSON.stringify(free.body?.error));
      const bobsRow = (free.body?.candidates ?? []).find((row) => row.id === bob.user._id.toString());
      check(
        'a fortnight is ten weekdays, and five booked plus one off leaves four',
        bobsRow?.weekdays === 10 && bobsRow?.bookedDays === 5 && bobsRow?.daysOff === 1 && bobsRow?.freeDays === 4,
        JSON.stringify(bobsRow && {
          weekdays: bobsRow.weekdays,
          booked: bobsRow.bookedDays,
          off: bobsRow.daysOff,
          free: bobsRow.freeDays,
        })
      );
      check(
        'an undecided request is not a day off yet, so it stays free',
        (bobsRow?.free ?? []).includes(NEXT_FRI),
        JSON.stringify(bobsRow?.free)
      );
      check(
        'and the longest clear stretch is offered, not the first and last free day',
        bobsRow?.freeRun?.start === '2029-09-11' && bobsRow?.freeRun?.days === 4,
        JSON.stringify(bobsRow?.freeRun)
      );

      /*
       * The decision this whole feature rests on: availability counts every booking, and only
       * the *name* is scoped. A scheduler that called somebody free because the reader cannot
       * see the job they are on would be worse than no scheduler.
       */
      const stranger3 = await makeUser('staffer', 'user');
      const asStranger = await call(stranger3, 'GET', `/schedule/availability?from=${MON}&to=${FRI}`);
      const seenByStranger = (asStranger.body?.candidates ?? []).find(
        (row) => row.id === bob.user._id.toString()
      );
      check(
        'somebody off the engagement still sees the days as taken',
        seenByStranger?.bookedDays === 5 && seenByStranger?.freeDays === 0,
        JSON.stringify(seenByStranger && { booked: seenByStranger.bookedDays, free: seenByStranger.freeDays })
      );
      check(
        'but not whose engagement it is',
        seenByStranger?.bookings?.[0]?.label === 'another engagement' &&
          seenByStranger?.bookings?.[0]?.visible === false,
        JSON.stringify(seenByStranger?.bookings)
      );
      const seenByMember = (free.body?.candidates ?? []).find(
        (row) => row.id === bob.user._id.toString()
      );
      check(
        'while somebody on it sees the reference',
        seenByMember?.bookings?.[0]?.label === 'ZZ-TEST' &&
          seenByMember?.bookings?.[0]?.visible === true,
        JSON.stringify(seenByMember?.bookings)
      );

      /* ------------------------------------------------ ability, not just availability */
      await call(alice, 'PUT', `/users/${alice.user._id}/profile`, {
        skills: [{ name: 'zz Kubernetes', level: 'expert' }],
      });
      await call(bob, 'PUT', `/users/${bob.user._id}/profile`, {
        skills: [{ name: 'zz Kubernetes', level: 'learning' }],
      });

      const skilled = await call(
        alice,
        'GET',
        `/schedule/availability?from=${MON}&to=${FRI}&skill=zz%20Kubernetes`
      );
      check(
        'asking by skill returns only people who have recorded it',
        (skilled.body?.candidates ?? []).length === 2,
        JSON.stringify((skilled.body?.candidates ?? []).map((row) => row.fullname))
      );
      check(
        'ranked by whether they could do it before how free they are',
        skilled.body?.candidates?.[0]?.level === 'expert' &&
          skilled.body?.candidates?.[0]?.freeDays === 5,
        JSON.stringify(skilled.body?.candidates?.map((row) => ({ level: row.level, free: row.freeDays })))
      );
      check(
        'even though the expert is not the freest — ability comes first',
        skilled.body?.candidates?.[1]?.level === 'learning',
        JSON.stringify(skilled.body?.candidates?.map((row) => row.level))
      );

      const deepOnly = await call(
        alice,
        'GET',
        `/schedule/availability?from=${MON}&to=${FRI}&skill=zz%20Kubernetes&level=strong`
      );
      check(
        'and a minimum level leaves out somebody still learning it',
        (deepOnly.body?.candidates ?? []).length === 1 &&
          deepOnly.body.candidates[0].deep === true,
        JSON.stringify((deepOnly.body?.candidates ?? []).map((row) => row.level))
      );

      /* ------------------------------------------------ the forecast */
      const forecast = await call(alice, 'GET', `/schedule/capacity?from=${MON}&to=${NEXT_FRI}`);
      check('the forecast comes back by week', (forecast.body?.weeks ?? []).length === 2, JSON.stringify((forecast.body?.weeks ?? []).length));
      const week1 = forecast.body?.weeks?.[0];
      check(
        'a week reports what the team had, what is booked, and what is left',
        week1?.booked === 5 && week1.available >= 5 && week1.free === week1.available - week1.booked,
        JSON.stringify(week1)
      );
      check(
        'load is a share of the days they had, not of the calendar',
        week1?.load === Math.round((week1.booked / week1.available) * 100),
        JSON.stringify({ load: week1?.load, booked: week1?.booked, available: week1?.available })
      );
      const week2 = forecast.body?.weeks?.[1];
      check(
        'and a day off comes out of the second week rather than being booked over',
        week2?.daysOff >= 1 && week2.available < week1.available,
        JSON.stringify({ week1: week1?.available, week2: week2?.available, off: week2?.daysOff })
      );
      const bobsWeeks = (forecast.body?.people ?? []).find(
        (row) => row.id === bob.user._id.toString()
      );
      check(
        'each person carries their own weeks, so a row is readable on its own',
        bobsWeeks?.weeks?.length === 2 && bobsWeeks.weeks[0].freeDays === 0,
        JSON.stringify(bobsWeeks?.weeks)
      );
      check(
        'and their strongest skills, so a row is a person rather than a name',
        (bobsWeeks?.skills ?? []).length === 0 &&
          ((forecast.body?.people ?? []).find((row) => row.id === alice.user._id.toString())?.skills ?? [])
            .includes('zz Kubernetes'),
        JSON.stringify((forecast.body?.people ?? []).map((row) => row.skills))
      );

      // A window nobody asked for is bounded rather than scanning a decade.
      const huge = await call(alice, 'GET', '/schedule/capacity?from=2029-01-01&to=2039-01-01');
      check(
        'an absurd range is capped instead of read',
        huge.body?.window?.to < '2030-01-05',
        JSON.stringify(huge.body?.window)
      );

      await Leaves2.deleteMany(ours2);
      await Books4.deleteMany({ audit: auditId });
    }

    /* -------------------------------- a note written up as a finding ----------- */
    log.info('Notes become findings');
    {
      const note = await call(alice, 'POST', `/audits/${auditId}/notes`, {
        title: 'Odd behaviour on the password reset',
        content:
          '<p>The token is reused across requests.</p><p><img src="/api/media/bbbbbbbbbbbbbbbbbbbbbbbb"></p>',
      });
      check('a note to write up', note.status === 201, JSON.stringify(note.body?.error));

      const promoted = await call(
        alice,
        'POST',
        `/audits/${auditId}/notes/${note.body._id}/promote`,
        {}
      );
      check('a note can be written up as a finding', promoted.status === 201, JSON.stringify(promoted.body?.error));
      check(
        'carrying its title and its text, screenshots and all',
        promoted.body?.finding?.title === 'Odd behaviour on the password reset' &&
          promoted.body?.finding?.description?.includes('token is reused') &&
          promoted.body?.finding?.description?.includes('bbbbbbbbbbbbbbbbbbbbbbbb'),
        JSON.stringify({
          title: promoted.body?.finding?.title,
          description: promoted.body?.finding?.description?.slice(0, 60),
        })
      );
      check(
        'with a report identifier of its own',
        typeof promoted.body?.finding?.identifier === 'number',
        JSON.stringify(promoted.body?.finding?.identifier)
      );

      // The note is the record of what was tried; capturing is only safe if it costs nothing.
      const notes = await call(alice, 'GET', `/audits/${auditId}/notes`);
      const kept = (notes.body ?? []).find((row) => row._id === note.body._id);
      check(
        'the note stays, and remembers what it became',
        Boolean(kept) && String(kept.promotedTo) === String(promoted.body.finding._id),
        JSON.stringify({ kept: Boolean(kept), promotedTo: kept?.promotedTo })
      );

      const twice = await call(
        alice,
        'POST',
        `/audits/${auditId}/notes/${note.body._id}/promote`,
        {}
      );
      check(
        'and will not be written up twice while that finding still exists',
        twice.status === 400 && /already been written up/i.test(twice.body?.error ?? ''),
        `${twice.status} ${twice.body?.error}`
      );

      // A stale link is not a reason to refuse: the finding is gone, the lead is not.
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${promoted.body.finding._id}`);
      await call(
        alice,
        'DELETE',
        `/audits/${auditId}/findings/deleted/${promoted.body.finding._id}`
      );
      const again = await call(
        alice,
        'POST',
        `/audits/${auditId}/notes/${note.body._id}/promote`,
        { title: 'Password reset token reuse' }
      );
      check(
        'once the finding is gone, the lead can be written up again',
        again.status === 201 && again.body?.finding?.title === 'Password reset token reuse',
        `${again.status} ${JSON.stringify(again.body?.error)}`
      );

      const promoteLog = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'and the engagement’s log says where the finding came from',
        (promoteLog.body?.entries ?? []).some((entry) => entry.action === 'note.promoted'),
        JSON.stringify((promoteLog.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      const outsider3 = await makeUser('promoter', 'user');
      const notTheirs = await call(
        outsider3,
        'POST',
        `/audits/${auditId}/notes/${note.body._id}/promote`,
        {}
      );
      check(
        'somebody off the engagement cannot write up its notes',
        notTheirs.status === 403 || notTheirs.status === 404,
        `got ${notTheirs.status}`
      );

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${again.body.finding._id}`);
      await call(
        alice,
        'DELETE',
        `/audits/${auditId}/findings/deleted/${again.body.finding._id}`
      );
      await call(alice, 'DELETE', `/audits/${auditId}/notes/${note.body._id}`);
    }

    /* -------------------------------------- when the work actually happened ---- */
    log.info('Activity calendar');
    {
      const calendar = await call(alice, 'GET', `/audits/${auditId}/activity/calendar?days=30`);
      check('the log can be read as a calendar', calendar.status === 200, JSON.stringify(calendar.body?.error));
      check(
        'with a cell for every day in the range, including the empty ones',
        (calendar.body?.days ?? []).length === 30,
        `${(calendar.body?.days ?? []).length} cells`
      );
      check(
        'the counts add up to the total',
        (calendar.body?.days ?? []).reduce((sum, row) => sum + row.count, 0) === calendar.body?.total,
        JSON.stringify({ total: calendar.body?.total })
      );
      check(
        'today has something in it, since this suite has been writing all along',
        (calendar.body?.days ?? []).at(-1)?.count > 0,
        JSON.stringify((calendar.body?.days ?? []).at(-1))
      );
      check(
        'the average is over active days, not over the calendar',
        calendar.body?.perActiveDay >= calendar.body?.total / 30,
        JSON.stringify({ perActiveDay: calendar.body?.perActiveDay, total: calendar.body?.total })
      );
      check(
        'and it says who was working',
        (calendar.body?.people ?? []).some((person) => person.fullname.includes('Collab')),
        JSON.stringify((calendar.body?.people ?? []).map((p) => p.fullname))
      );
      check(
        'and what the work consisted of',
        (calendar.body?.actions ?? []).length > 0 && Boolean(calendar.body.actions[0].action),
        JSON.stringify(calendar.body?.actions?.slice(0, 3))
      );
      /*
       * A run of quiet days is only a gap between the first and last day something happened: an
       * engagement was not idle before it existed.
       */
      check(
        'a range with one active day has no gap to report',
        calendar.body?.quietest === null,
        JSON.stringify(calendar.body?.quietest)
      );

      const outsider5 = await makeUser('calendar', 'user');
      const notTheirs3 = await call(outsider5, 'GET', `/audits/${auditId}/activity/calendar`);
      check(
        'somebody off the engagement cannot read its rhythm',
        notTheirs3.status === 403 || notTheirs3.status === 404,
        `got ${notTheirs3.status}`
      );

      const team = await call(alice, 'GET', '/insights/activity?days=30');
      check('an admin can read the whole team’s', team.status === 200, JSON.stringify(team.body?.error));
      check(
        'and it counts at least as much as one engagement did',
        team.body?.total >= calendar.body?.total,
        JSON.stringify({ team: team.body?.total, one: calendar.body?.total })
      );
      const teamAsUser = await call(bob, 'GET', '/insights/activity?days=30');
      check(
        'a non-admin cannot — their own rhythm is on the engagement',
        teamAsUser.status === 403,
        `got ${teamAsUser.status}`
      );
    }

    /* ------------------------------- invitations and resets -------------------- */
    log.info('Invitations and password resets');
    {
      const { AccountToken } = await import('../models/account-token.model.js');
      const { User: Accounts } = await import('../models/user.model.js');

      /*
       * An account created without a password.
       *
       * The old shape required one, which meant the first password an account ever had was one
       * an admin picked and had to convey over chat.
       */
      const invited = await call(alice, 'POST', '/users', {
        username: 'zz-collab-invited',
        email: 'zz-collab-invited@example.invalid',
        firstname: 'Invited',
        lastname: 'Person',
        role: 'user',
      });
      check('an account can be created without a password', invited.status === 201, JSON.stringify(invited.body?.error));
      check(
        'and comes back with a one-time link instead',
        Boolean(invited.body?.invitation?.token) &&
          String(invited.body?.invitation?.path).startsWith('/set-password/'),
        JSON.stringify(invited.body?.invitation?.path)
      );

      const inviteToken = invited.body.invitation.token;
      check(
        'only a hash of it is stored',
        (await AccountToken.countDocuments({ tokenHash: inviteToken })) === 0 &&
          (await AccountToken.countDocuments({ user: invited.body.id })) === 1,
        'the raw token appears to be stored'
      );

      // The public side: no session, and it says who it is for without saying anything else.
      const peek = await fetch(`${base}/auth/set-password/${inviteToken}`);
      const peekBody = await peek.json();
      check('the link can be read without signing in', peek.status === 200, JSON.stringify(peekBody));
      check(
        'and names the account it is for, and its purpose',
        peekBody.username === 'zz-collab-invited' && peekBody.purpose === 'invite',
        JSON.stringify(peekBody)
      );
      check(
        'while saying nothing else about the account',
        !('email' in peekBody) && !('role' in peekBody),
        JSON.stringify(Object.keys(peekBody))
      );

      const nonsense = await fetch(`${base}/auth/set-password/not-a-real-token`);
      check('a token nobody issued is refused', nonsense.status === 400, `got ${nonsense.status}`);

      const tooShort = await fetch(`${base}/auth/set-password/${inviteToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'short' }),
      });
      check('a weak password is refused', tooShort.status === 422, `got ${tooShort.status}`);

      const set = await fetch(`${base}/auth/set-password/${inviteToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'chosen-by-its-owner' }),
      });
      const setBody = await set.json();
      check('the invited person can set their own password', set.status === 200, JSON.stringify(setBody));
      check(
        'and is not signed in by the act of doing it',
        !('accessToken' in setBody) && !('user' in setBody),
        JSON.stringify(Object.keys(setBody))
      );

      const again = await fetch(`${base}/auth/set-password/${inviteToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'a-second-attempt' }),
      });
      check('the link works once', again.status === 400, `got ${again.status}`);

      const invitedAccount = await Accounts.findOne({ username: 'zz-collab-invited' });
      check(
        'an invited account still has to pair an authenticator on first sign-in',
        invitedAccount?.totpEnrolmentRequired === true,
        JSON.stringify(invitedAccount?.totpEnrolmentRequired)
      );

      /* ------------------------------------------------ a reset for somebody locked out */
      /*
       * Its own throwaway account. Resetting a password the rest of this suite signs in with
       * would break every later block — which is exactly what it did the first time.
       */
      const locked = await makeUser('lockedout', 'user');
      const beforeVersion = (await Accounts.findById(locked.user._id)).tokenVersion ?? 0;
      const link = await call(alice, 'POST', `/users/${locked.user._id}/reset-link`, {});
      check('an admin can issue a reset link', link.status === 200, JSON.stringify(link.body?.error));
      check(
        'and it is a reset rather than an invitation',
        String(link.body?.path).startsWith('/set-password/'),
        JSON.stringify(link.body?.path)
      );

      const second = await call(alice, 'POST', `/users/${locked.user._id}/reset-link`, {});
      const firstDead = await fetch(`${base}/auth/set-password/${link.body.token}`);
      check(
        'issuing another kills the first — "I sent it again" means the first is dead',
        firstDead.status === 400,
        `got ${firstDead.status}`
      );

      await fetch(`${base}/auth/set-password/${second.body.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'they-chose-this-one' }),
      });
      const afterReset = await Accounts.findById(locked.user._id);
      check(
        'a reset ends every session that was open — one that does not is not a reset',
        (afterReset.tokenVersion ?? 0) > beforeVersion,
        JSON.stringify({ before: beforeVersion, after: afterReset.tokenVersion })
      );

      const notAdmin = await call(bob, 'POST', `/users/${locked.user._id}/reset-link`, {});
      check('a non-admin cannot issue one', notAdmin.status === 403, `got ${notAdmin.status}`);

      await Accounts.deleteOne({ username: 'zz-collab-invited' });
      await AccountToken.deleteMany({});
    }

    /* ------------------------------- severity, overridden --------------------- */
    log.info('Severity override');
    {
      const { findingSeverity } = await import('../services/cvss.js');

      const critical = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz Overridable finding',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      });
      const id = critical.body?._id;
      check('a critical to work with', critical.body?.identifier > 0, JSON.stringify(critical.body?.error));

      const noReason = await call(alice, 'PUT', `/audits/${auditId}/findings/${id}`, {
        severityOverride: 'Medium',
      });
      check(
        'an override without a reason is refused — an unexplained one is what a client disputes',
        noReason.status === 400 && /say why/i.test(noReason.body?.error ?? ''),
        `${noReason.status} ${noReason.body?.error}`
      );

      const sameValue = await call(alice, 'PUT', `/audits/${auditId}/findings/${id}`, {
        severityOverride: 'Critical',
      });
      check(
        'and calling a Critical "Critical" needs no justification',
        sameValue.status === 200,
        JSON.stringify(sameValue.body?.error)
      );

      const moved = await call(alice, 'PUT', `/audits/${auditId}/findings/${id}`, {
        severityOverride: 'Medium',
        severityOverrideReason: 'Reachable only from the management VLAN',
      });
      check('with a reason it is accepted', moved.status === 200, JSON.stringify(moved.body?.error));
      check(
        'and records who decided it',
        Boolean(moved.body?.severityOverrideBy) && Boolean(moved.body?.severityOverrideAt),
        JSON.stringify({ by: moved.body?.severityOverrideBy, at: moved.body?.severityOverrideAt })
      );

      const rated = findingSeverity({
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        severityOverride: 'Medium',
        severityOverrideReason: 'x',
      });
      check(
        'the helper reports both the rating and the score it departed from',
        rated.severity === 'Medium' && rated.cvssSeverity === 'Critical' && rated.score === 9.8,
        JSON.stringify(rated)
      );
      check(
        'and sorts it among its new peers rather than at its old score',
        rated.sortScore === 5.5,
        JSON.stringify(rated.sortScore)
      );

      /*
       * The whole reason this is one helper: the report, the counts, the list and the search have
       * to agree. A downgraded finding showing as Critical in one place and Medium in another is
       * worse than not having the feature.
       */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const inReport = (data.body?.findings ?? []).find((row) => row.title === 'zz Overridable finding');
      check(
        'the report prints the rating the team stands behind',
        inReport?.severity === 'Medium' && inReport?.severityOverridden === true,
        JSON.stringify({ severity: inReport?.severity, overridden: inReport?.severityOverridden })
      );
      check(
        'beside the score it departed from, and the reason',
        inReport?.cvssSeverity === 'Critical' &&
          inReport?.cvssScore === 9.8 &&
          /management VLAN/.test(inReport?.severityReason ?? ''),
        JSON.stringify({
          cvss: inReport?.cvssSeverity,
          score: inReport?.cvssScore,
          reason: inReport?.severityReason,
        })
      );

      const list = await call(alice, 'GET', '/audits');
      const row = (list.body ?? []).find((entry) => entry._id === auditId);
      const critCount = row?.severityCounts?.critical ?? 0;
      check(
        'and the engagement list counts it where the report puts it',
        row?.severityCounts?.medium >= 1,
        JSON.stringify(row?.severityCounts)
      );
      void critCount;

      const cross = await call(alice, 'GET', '/findings?severity=Medium');
      check(
        'so does the cross-engagement findings page',
        (cross.body?.findings ?? []).some((entry) => entry.title === 'zz Overridable finding'),
        JSON.stringify((cross.body?.findings ?? []).map((f) => f.title).slice(0, 5))
      );

      // Clearing it goes back to the vector with no reason needed.
      const cleared = await call(alice, 'PUT', `/audits/${auditId}/findings/${id}`, {
        severityOverride: '',
      });
      check(
        'clearing the override needs no reason and restores the score',
        cleared.status === 200 && findingSeverity(cleared.body).severity === 'Critical',
        JSON.stringify(cleared.body?.severityOverride)
      );

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${id}`);
      await call(alice, 'DELETE', `/audits/${auditId}/findings/deleted/${id}`);
    }

    /* ------------------------------- what was actually reached ----------------- */
    log.info('Scope coverage');
    {
      const scoped = await call(alice, 'PUT', `/audits/${auditId}`, {
        scope: [
          {
            name: 'zz External',
            hosts: [
              { hostname: 'a.example', status: 'tested' },
              { hostname: 'b.example', status: 'tested' },
              { hostname: 'c.example', status: 'excluded', statusNote: 'client asked us not to' },
              { hostname: 'd.example' },
            ],
          },
        ],
      });
      check('assets can say whether they were reached', scoped.status === 200, JSON.stringify(scoped.body?.error));

      const data2 = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const coverage = data2.body?.scopeCoverage;
      check(
        'the report can say 2 of 4',
        coverage?.hosts === 4 && coverage?.tested === 2 && coverage?.percent === 50,
        JSON.stringify(coverage)
      );
      check(
        '"we agreed not to" and "we did not get to it" stay different answers',
        coverage?.excluded === 1 && coverage?.pending === 1,
        JSON.stringify(coverage)
      );
      check(
        'and it is not complete',
        coverage?.complete === false && coverage?.recorded === true,
        JSON.stringify({ complete: coverage?.complete, recorded: coverage?.recorded })
      );
      check(
        'each asset carries a printable label and a condition',
        (data2.body?.scope?.[0]?.hosts ?? []).some(
          (host) => host.statusLabel === 'Tested' && host.isTested === true
        ),
        JSON.stringify((data2.body?.scope?.[0]?.hosts ?? []).map((h) => h.statusLabel))
      );
      check(
        'and the group carries its own coverage',
        data2.body?.scope?.[0]?.testedCount === 2 && data2.body?.scope?.[0]?.coverage === 50,
        JSON.stringify({
          tested: data2.body?.scope?.[0]?.testedCount,
          coverage: data2.body?.scope?.[0]?.coverage,
        })
      );

      // An engagement nobody has ticked must not read as 0% tested.
      await call(alice, 'PUT', `/audits/${auditId}`, {
        scope: [{ name: 'zz External', hosts: [{ hostname: 'a.example' }] }],
      });
      const untouched = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'a scope nobody has marked says so rather than claiming nothing was tested',
        untouched.body?.scopeCoverage?.recorded === false,
        JSON.stringify(untouched.body?.scopeCoverage)
      );

      await call(alice, 'PUT', `/audits/${auditId}`, { scope: [] });
    }

    /* ------------------------------------------- reusable text ----------------- */
    log.info('Snippets');
    {
      const { Snippet } = await import('../models/snippet.model.js');
      await Snippet.deleteMany({ owner: { $in: [alice.user._id, bob.user._id] } });

      const mine = await call(alice, 'POST', '/snippets', {
        title: 'zz Authorisation paragraph',
        body: '<p>Testing was authorised in writing by the client on the dates below.</p>',
      });
      check('a snippet can be saved', mine.status === 201, JSON.stringify(mine.body?.error));

      const bobsList = await call(bob, 'GET', '/snippets');
      check(
        'and is private until it is shared',
        !(bobsList.body ?? []).some((row) => row._id === mine.body._id),
        JSON.stringify((bobsList.body ?? []).map((r) => r.title))
      );

      await call(alice, 'PUT', `/snippets/${mine.body._id}`, { shared: true });
      const shared = await call(bob, 'GET', '/snippets');
      const seen = (shared.body ?? []).find((row) => row._id === mine.body._id);
      check('sharing it puts it in everybody’s list', Boolean(seen), 'not visible after sharing');
      check(
        'marked as somebody else’s, so nobody edits the house wording by accident',
        seen?.mine === false,
        JSON.stringify({ mine: seen?.mine })
      );

      const meddling = await call(bob, 'PUT', `/snippets/${mine.body._id}`, { title: 'zz Mine now' });
      check('and only its owner or an admin can change it', meddling.status === 403, `got ${meddling.status}`);

      await call(bob, 'POST', `/snippets/${mine.body._id}/used`, {});
      const counted = await call(bob, 'GET', '/snippets');
      check(
        'using one is counted, so what you paste rises to the top on its own',
        (counted.body ?? []).find((row) => row._id === mine.body._id)?.uses === 1,
        JSON.stringify((counted.body ?? []).map((r) => r.uses))
      );

      const bobsOwn = await call(bob, 'POST', '/snippets', { title: 'zz Bob’s shorthand', body: '<p>x</p>' });
      const stranger = await call(alice, 'POST', `/snippets/${bobsOwn.body._id}/used`, {});
      check(
        'a private snippet of somebody else’s cannot even be counted against',
        stranger.status === 400,
        `got ${stranger.status}`
      );

      await Snippet.deleteMany({ owner: { $in: [alice.user._id, bob.user._id] } });
    }

    /* ------------------------------------------ search that ranks ------------- */
    log.info('Search ranking');
    {
      /*
       * Three things carrying the same word in different places, written in the wrong order on
       * purpose: the note is newest, so the old sort — `updatedAt` alone — put it first and the
       * finding actually *called* the search term last.
       */
      const term = 'Kerberoasting';
      const decoyAudit = await call(alice, 'POST', '/audits', {
        name: 'zz-rank Carrier engagement',
        reference: 'ZZ-RANK',
        collaborators: [bob.user._id.toString()],
      });
      const rankId = decoyAudit.body?._id;

      const titled = await call(alice, 'POST', `/audits/${rankId}/findings`, {
        title: `${term} against the service accounts`,
        description: '<p>Nothing else of note.</p>',
      });
      const mentioned = await call(alice, 'POST', `/audits/${rankId}/findings`, {
        title: 'Weak service account passwords',
        description: `<p>Recovered by ${term} and cracked offline within the hour.</p>`,
      });
      // Newest of the three, and the least relevant.
      await call(alice, 'POST', `/audits/${rankId}/notes`, {
        title: 'Scratch',
        content: `<p>try ${term} again on the second domain</p>`,
      });

      const ranked = await call(alice, 'GET', `/search?q=${term}`);
      check('the search runs', ranked.status === 200, JSON.stringify(ranked.body?.error));
      const order = (ranked.body?.results ?? []).map((row) => `${row.type}:${row.matched}`);
      check(
        'a title match outranks a body match',
        order[0] === 'finding:title',
        JSON.stringify(order.slice(0, 4))
      );
      check(
        'and the note nobody was looking for is not first, however recent it is',
        order[0] !== 'note:content',
        JSON.stringify(order.slice(0, 4))
      );
      check(
        'every result says which field it matched in',
        (ranked.body?.results ?? []).every((row) => Boolean(row.matched)),
        JSON.stringify(order)
      );
      check(
        'and carries a relevance the client can sort by',
        (ranked.body?.results ?? []).every((row) => typeof row.relevance === 'number'),
        JSON.stringify((ranked.body?.results ?? []).map((row) => row.relevance))
      );
      const relevances = (ranked.body?.results ?? []).map((row) => row.relevance);
      check(
        'sorted best first',
        relevances.every((value, index) => index === 0 || relevances[index - 1] >= value),
        JSON.stringify(relevances)
      );

      /*
       * A whole word beats a fragment. Both findings contain "admin"; only one of them is about
       * an admin, and the other says "administrative" in a sentence.
       */
      await call(alice, 'POST', `/audits/${rankId}/findings`, {
        title: 'zz Admin console exposed',
        description: '<p>Reachable without authentication.</p>',
      });
      await call(alice, 'POST', `/audits/${rankId}/findings`, {
        title: 'zz Session fixation',
        description: '<p>An administrative interface reuses the session identifier.</p>',
      });
      const words = await call(alice, 'GET', '/search?q=admin');
      const first = (words.body?.results ?? [])[0];
      check(
        'a whole-word match outranks a match inside a longer word',
        first?.title?.includes('Admin console'),
        JSON.stringify((words.body?.results ?? []).slice(0, 3).map((row) => row.title))
      );

      // A finding's CVSS score still travels under its own name, for the severity badge.
      check(
        'the CVSS score is still reported beside the relevance',
        (ranked.body?.results ?? [])
          .filter((row) => row.type === 'finding')
          .every((row) => typeof row.cvssScore === 'number'),
        JSON.stringify((ranked.body?.results ?? []).map((row) => row.cvssScore))
      );

      const { Audit: RankAudits } = await import('../models/audit.model.js');
      await Activity.deleteMany({ audit: rankId });
      await RankAudits.deleteMany({ name: /^zz-rank/ });
      void titled;
      void mentioned;
    }

    /* -------------------------------------------- how far setup has got ------- */
    log.info('Setup counts');
    {
      const setup = await call(bob, 'GET', '/setup');
      check('the instance can say how far it is set up', setup.status === 200, JSON.stringify(setup.body));
      check(
        'as counts rather than as lists',
        ['companies', 'templates', 'engagements', 'library', 'users'].every(
          (key) => typeof setup.body?.[key] === 'number'
        ),
        JSON.stringify(setup.body)
      );
      check(
        'and this instance has at least the engagement this suite made',
        setup.body?.engagements >= 1 && setup.body?.users >= 2,
        JSON.stringify({ engagements: setup.body?.engagements, users: setup.body?.users })
      );
      const anonymous2 = await fetch(`${base}/setup`);
      check(
        'an anonymous caller cannot read it',
        anonymous2.status === 401,
        `got ${anonymous2.status}`
      );
    }

    /* ----------------------------------------------- which build this is ------- */
    log.info('Build info');
    {
      const version = await call(alice, 'GET', '/version');
      check('the build is reported', version.status === 200, JSON.stringify(version.body));
      check(
        'with a version, the Node it runs on, and when it started',
        Boolean(version.body?.version) &&
          Boolean(version.body?.node) &&
          Boolean(version.body?.startedAt),
        JSON.stringify(version.body)
      );
      check(
        'and the commit, when there is a checkout to read it from',
        version.body?.commit === null || /^[0-9a-f]{7}$/.test(String(version.body?.commit)),
        JSON.stringify(version.body?.commit)
      );

      /*
       * Behind the token, deliberately. An unauthenticated endpoint that names its own build is a
       * gift to anybody deciding which exploits to try, and this instance holds other people's
       * vulnerabilities.
       */
      const anonymous = await fetch(`${base}/version`);
      check('an anonymous caller cannot read it', anonymous.status === 401, `got ${anonymous.status}`);

      const health = await fetch(`${base}/health`);
      const healthBody = await health.json();
      check(
        'while health stays public, for an uptime monitor',
        health.status === 200 && healthBody.ok === true,
        JSON.stringify(healthBody)
      );
      check(
        'and says nothing about the build',
        !('version' in healthBody) && !('commit' in healthBody),
        JSON.stringify(Object.keys(healthBody))
      );
    }

    /* ------------------------------------------ the order sections read in ----- */
    log.info('Section order');
    {
      // Three sections with distinguishable text, so a reorder that loses content is visible
      // rather than merely suspected.
      await call(alice, 'PUT', `/audits/${auditId}`, { sections: [] });
      const names = ['zz First', 'zz Second', 'zz Third'];
      const made2 = [];
      for (const [index, name] of names.entries()) {
        const created = await call(alice, 'POST', `/audits/${auditId}/sections`, {
          field: `zz_order_${index}`,
          name,
          text: `<p>${name} body</p>`,
        });
        made2.push(created.body);
      }
      check('three sections to order', made2.every((row) => row?._id), JSON.stringify(made2.map((r) => r?.name)));

      const ids = made2.map((row) => row._id);
      const reordered = await call(alice, 'PUT', `/audits/${auditId}/sections-order`, {
        order: [ids[2], ids[0], ids[1]],
      });
      check('sections can be put in an order', reordered.status === 200, JSON.stringify(reordered.body?.error));

      const after = await call(alice, 'GET', `/audits/${auditId}`);
      const order = (after.body?.sections ?? [])
        .filter((row) => row.field.startsWith('zz_order_'))
        .map((row) => row.name);
      check(
        'and the engagement reads them in it',
        order.join(',') === 'zz Third,zz First,zz Second',
        order.join(',')
      );
      check(
        'ids survive, so a template’s placeholders still point at the same sections',
        (after.body?.sections ?? []).filter((row) => ids.includes(row._id)).length === 3,
        JSON.stringify((after.body?.sections ?? []).map((row) => row._id))
      );
      check(
        'and so does what was written in them',
        (after.body?.sections ?? []).find((row) => row.name === 'zz Third')?.text ===
          '<p>zz Third body</p>',
        JSON.stringify((after.body?.sections ?? []).map((row) => row.text))
      );

      /*
       * The order is what the report loops in. Nothing else in the app decides it — sections
       * carry no sort field — so this is the assertion that makes the feature worth having.
       */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const inReport = (data.body?.sections ? Object.keys(data.body.sections) : []).filter((key) =>
        key.startsWith('zz_order_')
      );
      const looped = (data.body?.sectionList ?? [])
        .filter((row) => String(row.field ?? '').startsWith('zz_order_'))
        .map((row) => row.name);
      check(
        'the report data carries them in the same order',
        looped.join(',') === 'zz Third,zz First,zz Second',
        JSON.stringify(looped)
      );
      check('and still addressable by field name', inReport.length === 3, JSON.stringify(inReport));

      /*
       * A stale order — one taken before somebody added a section — must not lose the section it
       * has never heard of. Losing written prose to a reordering is not a trade worth making.
       */
      const late = await call(alice, 'POST', `/audits/${auditId}/sections`, {
        field: 'zz_order_late',
        name: 'zz Late arrival',
        text: '<p>added after the order was read</p>',
      });
      const stale = await call(alice, 'PUT', `/audits/${auditId}/sections-order`, {
        order: [ids[0], ids[1], ids[2]],
      });
      check('a stale order is accepted', stale.status === 200, JSON.stringify(stale.body?.error));
      const kept = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'and the section it did not mention is kept, at the end',
        (kept.body?.sections ?? []).at(-1)?.name === 'zz Late arrival',
        JSON.stringify((kept.body?.sections ?? []).map((row) => row.name))
      );

      const outsider4 = await makeUser('orderer', 'user');
      const notTheirs2 = await call(outsider4, 'PUT', `/audits/${auditId}/sections-order`, {
        order: ids,
      });
      check(
        'somebody off the engagement cannot reorder it',
        notTheirs2.status === 403 || notTheirs2.status === 404,
        `got ${notTheirs2.status}`
      );

      const orderLog = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'reordering is in the engagement’s log',
        (orderLog.body?.entries ?? []).some((entry) => entry.action === 'sections.reordered'),
        JSON.stringify((orderLog.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      // Leave the engagement as the blocks below expect it.
      await call(alice, 'PUT', `/audits/${auditId}`, { sections: [] });
    }

    /* ------------------------------------------- a sign-in from a new device --- */
    log.info('Unfamiliar device notice');
    {
      const { Session } = await import('../models/session.model.js');
      const { Notification: Notify } = await import('../models/notification.model.js');
      const { describeDevice } = await import('../utils/device-key.js');

      const CHROME =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
      const CHROME_NEWER =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';
      const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

      const person = await makeUser('device', 'user');
      // The account needs a known password to sign in through the real route.
      const { User: Users3 } = await import('../models/user.model.js');
      const account = await Users3.findById(person.user._id);
      account.password = 'device-test-password';
      await account.save();

      const signIn = async (agent) => {
        const response = await fetch(`${base}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': agent },
          body: JSON.stringify({ username: account.username, password: 'device-test-password' }),
        });
        return response.status;
      };

      await Session.deleteMany({ user: person.user._id });
      await Notify.deleteMany({ user: person.user._id, type: 'new-sign-in' });

      check('the first sign-in works', (await signIn(CHROME)) === 200, 'sign-in failed');
      check(
        'and says nothing — everybody’s first device is new',
        (await Notify.countDocuments({ user: person.user._id, type: 'new-sign-in' })) === 0,
        'a first sign-in raised a notice'
      );

      await signIn(CHROME_NEWER);
      check(
        'a version bump is the same device, so still nothing',
        (await Notify.countDocuments({ user: person.user._id, type: 'new-sign-in' })) === 0,
        'a Chrome update looked like a new device'
      );

      await signIn(FIREFOX);
      const notices = await Notify.find({ user: person.user._id, type: 'new-sign-in' });
      check(
        'a genuinely different browser is reported',
        notices.length === 1,
        `${notices.length} notice(s)`
      );
      check(
        'and the notice names the device',
        notices[0]?.message?.includes('Firefox on Linux'),
        JSON.stringify(notices[0]?.message)
      );

      await signIn(FIREFOX);
      check(
        'signing in from it again is not news',
        (await Notify.countDocuments({ user: person.user._id, type: 'new-sign-in' })) === 1,
        'the second sign-in from a known device raised another notice'
      );

      const stored = await Session.find({ user: person.user._id }).select('deviceKey');
      check(
        'each session records which device it came from',
        stored.every((row) => row.deviceKey) &&
          new Set(stored.map((row) => row.deviceKey)).size === 2,
        JSON.stringify(stored.map((row) => row.deviceKey))
      );
      check(
        'and the sessions list says it in words',
        describeDevice(FIREFOX).label === 'Firefox on Linux',
        describeDevice(FIREFOX).label
      );

      await Session.deleteMany({ user: person.user._id });
      await Notify.deleteMany({ user: person.user._id });
    }

    /* --------------------------------------------------- whose check is it ----- */
    log.info('Assigning a check');
    {
      const { Notification: Notify } = await import('../models/notification.model.js');

      const made = await call(alice, 'POST', `/audits/${auditId}/test-checks`, {
        title: 'zz-assign verify session rotation',
        category: 'Authentication',
      });
      check('a check to hand over', made.status === 201, JSON.stringify(made.body?.error));

      await Notify.deleteMany({ user: bob.user._id, type: 'check-assigned' });
      const given = await call(alice, 'PUT', `/audits/${auditId}/test-checks/${made.body._id}`, {
        assignedTo: String(bob.user._id),
      });
      check(
        'a check can be given to somebody on the engagement',
        given.status === 200 &&
          String(given.body?.assignedTo?._id ?? given.body?.assignedTo) === String(bob.user._id),
        JSON.stringify(given.body?.assignedTo)
      );
      check(
        'and they are told',
        (await Notify.countDocuments({ user: bob.user._id, type: 'check-assigned' })) === 1,
        'expected one notification'
      );

      // Telling somebody what they just did is noise, and noise is how a bell gets ignored.
      await Notify.deleteMany({ user: alice.user._id, type: 'check-assigned' });
      await call(alice, 'PUT', `/audits/${auditId}/test-checks/${made.body._id}`, {
        assignedTo: String(alice.user._id),
      });
      check(
        'taking one yourself notifies nobody',
        (await Notify.countDocuments({ user: alice.user._id, type: 'check-assigned' })) === 0,
        'a self-assignment sent a notification'
      );

      const stranger = await makeUser('assignee', 'user');
      const offTeam = await call(alice, 'PUT', `/audits/${auditId}/test-checks/${made.body._id}`, {
        assignedTo: String(stranger.user._id),
      });
      check(
        'somebody off the engagement cannot be given one',
        offTeam.status === 400 && /not on this engagement/i.test(offTeam.body?.error ?? ''),
        `${offTeam.status} ${offTeam.body?.error}`
      );

      /* ------------------------------------------------------ in the inbox */
      await call(alice, 'PUT', `/audits/${auditId}/test-checks/${made.body._id}`, {
        assignedTo: String(bob.user._id),
      });
      const inbox = await call(bob, 'GET', '/inbox');
      check(
        'it shows up as theirs to do',
        (inbox.body?.assigned ?? []).some((row) => row.title === 'zz-assign verify session rotation'),
        JSON.stringify(inbox.body?.assigned?.map((row) => row.title))
      );
      check(
        'and is counted as something waiting on them',
        (inbox.body?.counts?.assigned ?? 0) >= 1,
        JSON.stringify(inbox.body?.counts)
      );
      check(
        'it is not also listed as a check they asked for — one obligation, one place',
        !(inbox.body?.checks ?? []).some((row) => row.title === 'zz-assign verify session rotation'),
        JSON.stringify(inbox.body?.checks?.map((row) => row.title))
      );

      // Ticking it takes it out of the inbox without forgetting whose it was.
      await call(bob, 'PUT', `/audits/${auditId}/test-checks/${made.body._id}`, { done: true });
      const afterDone = await call(bob, 'GET', '/inbox');
      check(
        'a ticked check stops waiting on anybody',
        !(afterDone.body?.assigned ?? []).some(
          (row) => row.title === 'zz-assign verify session rotation'
        ),
        JSON.stringify(afterDone.body?.assigned?.map((row) => row.title))
      );
      const list = await call(alice, 'GET', `/audits/${auditId}/test-checks`);
      const done = (list.body ?? []).find((row) => row.title === 'zz-assign verify session rotation');
      check(
        'and it still says whose it was, beside who did it',
        String(done?.assignedTo?._id ?? done?.assignedTo) === String(bob.user._id) &&
          String(done?.doneBy?._id ?? done?.doneBy) === String(bob.user._id),
        JSON.stringify({ assigned: done?.assignedTo?.username, done: done?.doneBy?.username })
      );

      const cleared = await call(alice, 'PUT', `/audits/${auditId}/test-checks/${made.body._id}`, {
        assignedTo: null,
      });
      check(
        'it can be given back to nobody in particular',
        cleared.status === 200 && !cleared.body?.assignedTo,
        JSON.stringify(cleared.body?.assignedTo)
      );

      // A client report must not learn who internally was told to do what.
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'assignment stays internal — it is not in the report data',
        (data.body?.testChecks ?? []).every((row) => row.assignedTo === undefined),
        JSON.stringify(Object.keys((data.body?.testChecks ?? [])[0] ?? {}))
      );

      const log6 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'and the engagement records who handed it over',
        (log6.body?.entries ?? []).some((entry) => entry.action === 'check.assigned'),
        JSON.stringify((log6.body?.entries ?? []).slice(0, 4).map((e) => e.action))
      );

      await call(alice, 'DELETE', `/audits/${auditId}/test-checks/${made.body._id}`);
      await Notify.deleteMany({ type: 'check-assigned' });
    }

    /* --------------------------------------------- who changed a setting ------- */
    log.info('Settings change log');
    {
      const { SettingsChange } = await import('../models/settings-change.model.js');
      const { Settings: Config } = await import('../models/settings.model.js');
      await SettingsChange.deleteMany({});

      /*
       * The whole document, kept so it can be put back.
       *
       * This block exercises the reset endpoint, which by design throws the instance's settings
       * away — and the suite runs against a real database with real branding and a real finding
       * prefix in it. Restoring a couple of fields by hand is not enough: a test that resets an
       * instance has to restore the instance.
       */
      const snapshot = (await Config.getSettings()).toObject();
      delete snapshot._id;
      delete snapshot.__v;

      const before = await Config.getSettings();
      const wasMinimum = before.reviews?.public?.minReviewers ?? 1;
      const wasDays = before.danger?.public?.nbdaydelete ?? 15;

      const changed = await call(alice, 'PUT', '/settings', {
        reviews: { public: { minReviewers: wasMinimum + 1 } },
        // Sent unchanged, exactly as the form posts every field it holds.
        danger: { public: { nbdaydelete: wasDays } },
      });
      check('a setting can be changed', changed.status === 200, JSON.stringify(changed.body?.error));

      const history = await call(alice, 'GET', '/settings/history');
      check('the change is recorded', history.status === 200 && (history.body?.changes ?? []).length === 1, JSON.stringify(history.body));

      const entry = (history.body?.changes ?? [])[0];
      check(
        'with who did it',
        entry?.actor?.username === alice.user.username,
        JSON.stringify(entry?.actor)
      );
      check(
        'and only what actually changed',
        (entry?.changes ?? []).length === 1 &&
          entry.changes[0].path === 'reviews.public.minReviewers',
        JSON.stringify(entry?.changes)
      );
      check(
        'with the value it had before',
        entry?.changes?.[0]?.from === String(wasMinimum) &&
          entry.changes[0].to === String(wasMinimum + 1),
        JSON.stringify(entry?.changes?.[0])
      );

      // Pressing Save with nothing edited must not fill the log with empty entries.
      const noop = await call(alice, 'PUT', '/settings', {
        danger: { public: { nbdaydelete: wasDays } },
      });
      check(
        'a save that changed nothing records nothing',
        noop.status === 200 && (await SettingsChange.countDocuments({})) === 1,
        `${await SettingsChange.countDocuments({})} entries`
      );

      // A boolean reads as on/off rather than true/false, which is what the page shows.
      await call(alice, 'PUT', '/settings', { reviews: { enabled: true } });
      const withBoolean = await call(alice, 'GET', '/settings/history');
      const booleanChange = (withBoolean.body?.changes ?? [])[0]?.changes?.[0];
      check(
        'a switch is recorded in the words the page uses',
        booleanChange?.path === 'reviews.enabled' && booleanChange?.to === 'on',
        JSON.stringify(booleanChange)
      );

      /*
       * A logo is a 300 kB data URI. Recording it twice per change would make the log larger
       * than everything it describes, so it is summarised.
       */
      const logo = `data:image/png;base64,${'A'.repeat(20_000)}`;
      await call(alice, 'PUT', '/settings', { branding: { logo } });
      const withLogo = await call(alice, 'GET', '/settings/history');
      const logoChange = (withLogo.body?.changes ?? [])[0]?.changes?.[0];
      check(
        'a bulky value is described rather than stored',
        logoChange?.path === 'branding.logo' &&
          /^\[image, about \d+ kB\]$/.test(logoChange?.to ?? '') &&
          !(logoChange?.to ?? '').includes('AAAA'),
        JSON.stringify(logoChange?.to?.slice(0, 60))
      );
      const stored = await SettingsChange.findOne({ 'changes.path': 'branding.logo' });
      check(
        'and the base64 is nowhere in the collection',
        !JSON.stringify(stored).includes('AAAAAAAA'),
        'the log stored the image itself'
      );

      const asBob = await call(bob, 'GET', '/settings/history');
      check('only an admin can read it', asBob.status === 403, `got ${asBob.status}`);

      const newest = await call(alice, 'GET', '/settings/history');
      const times = (newest.body?.changes ?? []).map((row) => new Date(row.at).getTime());
      check(
        'newest first',
        times.every((value, index) => index === 0 || times[index - 1] >= value),
        JSON.stringify(times)
      );

      // Put the instance back, and check the reset is recorded as one thing rather than forty.
      await call(alice, 'PUT', '/settings', {
        branding: { logo: '' },
        reviews: { enabled: before.reviews?.enabled ?? false, public: { minReviewers: wasMinimum } },
      });
      const wiped = await call(alice, 'POST', '/settings/reset');
      check('the instance can be reset', wiped.status === 200, JSON.stringify(wiped.body?.error));
      const afterReset = await call(alice, 'GET', '/settings/history');
      check(
        'and a reset is one entry saying what it was, not a diff of everything',
        (afterReset.body?.changes ?? [])[0]?.action === 'reset' &&
          ((afterReset.body?.changes ?? [])[0]?.changes ?? []).length === 0,
        JSON.stringify((afterReset.body?.changes ?? [])[0])
      );

      // Put the instance back exactly as it was found.
      await Config.replaceOne({ singleton: 'settings' }, snapshot, { upsert: true });
      const restored = await Config.getSettings();
      check(
        'and the suite leaves the instance settings as it found them',
        restored.report?.public?.findingIdPrefix === snapshot.report?.public?.findingIdPrefix &&
          restored.branding?.appName === snapshot.branding?.appName &&
          restored.danger?.public?.nbdaydelete === snapshot.danger?.public?.nbdaydelete,
        JSON.stringify({
          prefix: restored.report?.public?.findingIdPrefix,
          expected: snapshot.report?.public?.findingIdPrefix,
        })
      );

      await SettingsChange.deleteMany({});
    }

    /* ------------------------------------------- access with an end date ------- */
    log.info('Time-boxed membership');
    {
      const day = (offset) =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

      // Bob is a collaborator on the engagement throughout this block.
      const stillOn = await call(bob, 'GET', `/audits/${auditId}`);
      check('a member can open the engagement', stillOn.status === 200, `got ${stillOn.status}`);

      const limited = await call(alice, 'PUT', `/audits/${auditId}`, {
        collaborators: (stillOn.body?.collaborators ?? []).map((entry) => String(entry._id)),
        reviewers: (stillOn.body?.reviewers ?? []).map((entry) => String(entry._id)),
        memberUntil: [{ user: String(bob.user._id), until: day(7) }],
      });
      check(
        'their access can be given an end date',
        limited.status === 200 &&
          (limited.body?.memberUntil ?? []).some(
            (entry) => String(entry.user) === String(bob.user._id)
          ),
        JSON.stringify(limited.body?.memberUntil)
      );
      const notYet = await call(bob, 'GET', `/audits/${auditId}`);
      check('and a date in the future changes nothing', notYet.status === 200, `got ${notYet.status}`);

      // Backdate it: the same shape a subcontractor's access has the day after it ends.
      const { Audit: Audits } = await import('../models/audit.model.js');
      await Audits.updateOne(
        { _id: auditId },
        { $set: { memberUntil: [{ user: bob.user._id, until: day(-1) }] } }
      );

      const expired = await call(bob, 'GET', `/audits/${auditId}`);
      check(
        'once it has passed the engagement is closed to them',
        expired.status === 403,
        `got ${expired.status}`
      );
      const findingsToo = await call(bob, 'GET', `/audits/${auditId}/findings/deleted`);
      check(
        'and so is everything under it',
        findingsToo.status === 403,
        `got ${findingsToo.status}`
      );
      const list = await call(bob, 'GET', '/audits');
      check(
        'it also leaves their list, rather than sitting there unopenable',
        !(list.body ?? []).some((entry) => String(entry._id) === String(auditId)),
        JSON.stringify((list.body ?? []).map((e) => e.name))
      );
      const portfolio = await call(bob, 'GET', '/findings');
      check(
        'and its findings leave the cross-engagement view too',
        !(portfolio.body?.findings ?? []).some(
          (row) => String(row.engagement?.id) === String(auditId)
        ),
        JSON.stringify(portfolio.body?.findings?.length)
      );

      // Their work stays attributed: the name is still on the team.
      const asAlice = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'their name stays on the team, so their work stays attributed',
        (asAlice.body?.collaborators ?? []).some(
          (entry) => String(entry._id) === String(bob.user._id)
        ),
        JSON.stringify(asAlice.body?.collaborators?.map((c) => c.username))
      );

      // An admin is never locked out, and neither is the creator.
      const adminView = await call(alice, 'GET', `/audits/${auditId}`);
      check('an admin is not affected', adminView.status === 200, `got ${adminView.status}`);

      // Removing somebody from the team removes their limit with them.
      await call(alice, 'PUT', `/audits/${auditId}`, {
        collaborators: [String(alice.user._id)],
        reviewers: [],
      });
      const pruned = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'a limit cannot outlive the membership it describes',
        (pruned.body?.memberUntil ?? []).length === 0,
        JSON.stringify(pruned.body?.memberUntil)
      );

      // Put bob back for the rest of the suite.
      await call(alice, 'PUT', `/audits/${auditId}`, {
        collaborators: [String(alice.user._id), String(bob.user._id)],
        reviewers: [String(bob.user._id)],
        memberUntil: [],
      });
      const restored = await call(bob, 'GET', `/audits/${auditId}`);
      check('and clearing it restores access', restored.status === 200, `got ${restored.status}`);
    }

    /* --------------------------------------------- a client's own severity words --- */
    log.info('Client severity labels');
    {
      const { Company } = await import('../models/company.model.js');
      const company = await Company.create({ name: 'zz-sev their own scale' });
      await call(alice, 'PUT', `/audits/${auditId}`, { company: String(company._id) });

      const standard = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'by default a report says what everybody says',
        standard.body?.stats?.bySeverity?.some((row) => row.label === 'Informational'),
        JSON.stringify(standard.body?.stats?.bySeverity?.map((r) => r.label))
      );

      await Company.findByIdAndUpdate(company._id, {
        $set: {
          'report.severityLabels.critical': 'P1',
          'report.severityLabels.high': 'P2',
          'report.severityLabels.none': 'FYI',
        },
      });

      const theirs = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const labels = (theirs.body?.stats?.bySeverity ?? []).map((row) => row.label);
      check(
        'a client with their own scale gets their own words',
        labels.includes('P1') && labels.includes('P2') && labels.includes('FYI'),
        JSON.stringify(labels)
      );
      check(
        'and the ones they did not rename keep the standard word',
        labels.includes('Medium') && labels.includes('Low'),
        JSON.stringify(labels)
      );
      check(
        'each finding carries the wording too',
        (theirs.body?.findings ?? []).every((finding) => Boolean(finding.severityLabel)),
        JSON.stringify(theirs.body?.findings?.map((f) => [f.severity, f.severityLabel]))
      );
      check(
        'while the raw severity is untouched, so conditions still work',
        (theirs.body?.findings ?? []).every((finding) =>
          ['Critical', 'High', 'Medium', 'Low', 'None'].includes(finding.severity)
        ),
        JSON.stringify(theirs.body?.findings?.map((f) => f.severity))
      );

      await call(alice, 'PUT', `/audits/${auditId}`, { company: null });
      await Company.deleteOne({ _id: company._id });
    }

    /* ---------------------------------------------------- what was agreed ------ */
    log.info('Scope changes');
    {
      const { ScopeChange } = await import('../models/scope-change.model.js');
      await ScopeChange.deleteMany({ audit: auditId });

      const empty = await call(bob, 'GET', `/audits/${auditId}/scope-changes`);
      check(
        'an engagement starts with nothing agreed',
        empty.status === 200 && (empty.body?.scopeChanges ?? []).length === 0,
        JSON.stringify(empty.body)
      );

      const added = await call(bob, 'POST', `/audits/${auditId}/scope-changes`, {
        kind: 'added',
        agreedOn: '2026-08-14',
        summary: 'The staging API host was brought into scope.',
        targets: ['api-staging.acme.example', '10.0.5.0/24'],
        agreedBy: { name: 'Dana Whitfield' },
        channel: 'Email',
      });
      check('anyone on the engagement can record one', added.status === 201, JSON.stringify(added.body?.error));

      const undated = await call(bob, 'POST', `/audits/${auditId}/scope-changes`, {
        summary: 'no date given',
      });
      check('a change with no date is refused', undated.status === 422, `got ${undated.status}`);
      const wordless = await call(bob, 'POST', `/audits/${auditId}/scope-changes`, {
        agreedOn: '2026-08-14',
      });
      check('and so is one that does not say what changed', wordless.status === 422, `got ${wordless.status}`);

      await call(alice, 'POST', `/audits/${auditId}/scope-changes`, {
        kind: 'removed',
        agreedOn: '2026-08-10',
        summary: 'Payment flows excluded — the sandbox was unavailable.',
        agreedBy: { name: 'Dana Whitfield' },
      });

      const listed = await call(bob, 'GET', `/audits/${auditId}/scope-changes`);
      check(
        'they are listed in the order they were agreed, not recorded',
        (listed.body?.scopeChanges ?? []).map((row) => row.agreedOn).join(',') ===
          '2026-08-10,2026-08-14',
        JSON.stringify((listed.body?.scopeChanges ?? []).map((row) => row.agreedOn))
      );

      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'a template can print the table',
        data.body?.hasScopeChanges === true && (data.body?.scopeChanges ?? []).length === 2,
        JSON.stringify(data.body?.scopeChanges?.map((row) => row.kind))
      );
      check(
        'with the kind in words and the hosts on one line',
        data.body?.scopeChanges?.[1]?.kindLabel === 'Added to scope' &&
          data.body.scopeChanges[1].targetList === 'api-staging.acme.example, 10.0.5.0/24',
        JSON.stringify(data.body?.scopeChanges?.[1])
      );
      {
        const { formatDate: format } = await import('../services/template-parser.js');
        const { Settings: Config } = await import('../models/settings.model.js');
        const pattern = (await Config.getSettings()).report?.public?.dateFormat;
        check(
          'the date is formatted with the same pattern as every other date in the report',
          data.body?.scopeChanges?.[0]?.date === format('2026-08-10', pattern),
          JSON.stringify({ got: data.body?.scopeChanges?.[0]?.date, pattern })
        );
      }
      check(
        'and counts for a sentence about them',
        data.body?.scopeChangeCounts?.added === 1 &&
          data.body?.scopeChangeCounts?.removed === 1 &&
          data.body?.scopeChangeCounts?.total === 2,
        JSON.stringify(data.body?.scopeChangeCounts)
      );

      const edited = await call(bob, 'PUT', `/audits/${auditId}/scope-changes/${added.body._id}`, {
        summary: 'The staging API host was brought into scope for the rest of the window.',
      });
      check(
        'a record can be corrected',
        edited.status === 200 && edited.body?.summary.includes('rest of the window'),
        JSON.stringify(edited.body?.summary)
      );

      const log5 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'and the engagement records that it was agreed',
        (log5.body?.entries ?? []).some((entry) => entry.action === 'scope.change-recorded'),
        JSON.stringify((log5.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      const outsider = await makeUser('scopechange', 'user');
      const peek = await call(outsider, 'GET', `/audits/${auditId}/scope-changes`);
      check('somebody off the engagement cannot read them', peek.status === 403, `got ${peek.status}`);

      const gone = await call(bob, 'DELETE', `/audits/${auditId}/scope-changes/${added.body._id}`);
      check('and a record entered by mistake can go', gone.status === 200, JSON.stringify(gone.body));

      await ScopeChange.deleteMany({ audit: auditId });
    }

    /* --------------------------------------------------- a phishing campaign ---- */
    log.info('Phishing campaigns');
    {
      const { PhishingTarget } = await import('../models/phishing-target.model.js');
      const { readRow, rowsFrom, truthy, campaignSummary } = await import(
        '../services/phishing.service.js'
      );

      /* ------------------------------------------- reading somebody else's file */
      check(
        'yes and no arrive in every spelling a tool might use',
        truthy('Yes') === true &&
          truthy('N') === false &&
          truthy(1) === true &&
          truthy(0) === false &&
          truthy('clicked') === true,
        JSON.stringify([truthy('Yes'), truthy('N'), truthy(1), truthy(0)])
      );
      check(
        // A column that is absent is not a column that said no: turning one into the other would
        // mark everybody as not having reported it, on a file that never mentioned reporting.
        'and a missing column stays unknown rather than becoming a no',
        truthy(undefined) === undefined && truthy('') === undefined,
        JSON.stringify([truthy(undefined), truthy('')])
      );
      check(
        'the rows are found whichever key they are wrapped in',
        (rowsFrom([{ email: 'a@b.test' }]) ?? []).length === 1 &&
          (rowsFrom({ results: [{ email: 'a@b.test' }] }) ?? []).length === 1 &&
          (rowsFrom({ recipients: [{ email: 'a@b.test' }] }) ?? []).length === 1 &&
          rowsFrom({ nothing: true }) === null,
        'a shape was not recognised'
      );
      check(
        'a name split across two columns is put back together',
        readRow({ Email: 'a@b.test', FirstName: 'Dana', LastName: 'Whitfield' }).patch.name ===
          'Dana Whitfield',
        JSON.stringify(readRow({ Email: 'a@b.test', FirstName: 'Dana', LastName: 'Whitfield' }))
      );
      check(
        'a row with no address is refused with a reason rather than guessed at',
        readRow({ name: 'Nobody' }).error === 'no email address' &&
          /not an email address/.test(readRow({ email: 'not-an-address' }).error ?? ''),
        JSON.stringify([readRow({ name: 'Nobody' }), readRow({ email: 'not-an-address' })])
      );
      check(
        // Somebody who submitted credentials clicked the link, whatever the export recorded.
        'being phished implies the steps before it',
        (() => {
          const { patch } = readRow({ email: 'a@b.test', submitted: 'yes' });
          return patch.phished === true && patch.clicked === true && patch.sent === true;
        })(),
        JSON.stringify(readRow({ email: 'a@b.test', submitted: 'yes' }).patch)
      );
      check(
        'but a column that spoke is never contradicted',
        readRow({ email: 'a@b.test', clicked: 'yes', reported: 'no' }).patch.reported === false,
        JSON.stringify(readRow({ email: 'a@b.test', clicked: 'yes', reported: 'no' }).patch)
      );
      check(
        'a timestamp on its own is taken as the record of the event',
        readRow({ email: 'a@b.test', clickedAt: '2029-05-04T09:12:00Z' }).patch.clicked === true,
        JSON.stringify(readRow({ email: 'a@b.test', clickedAt: '2029-05-04T09:12:00Z' }).patch)
      );

      /* --------------------------------------------------- a campaign, end to end */
      /* --------------------------- the type carries the shape of work --------- */
      const { AuditType: Types15 } = await import('../models/taxonomy.model.js');
      await Types15.deleteMany({ name: /^zz-phish/ });
      await Types15.create({ name: 'zz-phish Campaign', kind: 'phishing' });

      const byType = await call(alice, 'POST', '/audits', {
        name: 'zz-phish from the type list',
        auditType: 'zz-phish Campaign',
      });
      check(
        // Choosing "Phishing Campaign" from the type list is all anybody should have to do.
        'choosing a phishing engagement type makes the engagement one',
        byType.status === 201 && byType.body?.kind === 'phishing',
        JSON.stringify([byType.status, byType.body?.kind])
      );

      const overridden = await call(alice, 'POST', '/audits', {
        name: 'zz-phish but standard on purpose',
        auditType: 'zz-phish Campaign',
        kind: 'standard',
      });
      check(
        // The blueprint fills blanks; it does not override a choice. Same rule as the rest of it.
        'but saying otherwise explicitly still wins',
        overridden.body?.kind === 'standard',
        JSON.stringify(overridden.body?.kind)
      );

      const made = await call(alice, 'POST', '/audits', {
        name: 'zz-phish quarterly awareness campaign',
        kind: 'phishing',
        collaborators: [bob.user._id.toString()],
      });
      check(
        'an engagement can be a phishing campaign',
        made.status === 201 && made.body?.kind === 'phishing',
        JSON.stringify(made.body?.kind)
      );
      const pid = made.body._id;

      const added = await call(alice, 'POST', `/audits/${pid}/phishing`, {
        targets: [
          { email: 'Dana@ZZ-Phish.test', name: 'Dana Whitfield', department: 'Finance' },
          { email: 'marcus@zz-phish.test', name: 'Marcus Ellery', department: 'IT' },
          { email: 'priya@zz-phish.test', name: 'Priya Raman', department: 'Finance' },
        ],
      });
      check(
        'people can be added to the sending list',
        added.status === 201 && added.body?.added === 3,
        JSON.stringify(added.body?.added)
      );
      check(
        'and an address is stored lower-cased, so a re-import matches it',
        (added.body?.targets ?? []).some((row) => row.email === 'dana@zz-phish.test'),
        JSON.stringify((added.body?.targets ?? []).map((t) => t.email))
      );

      const again = await call(alice, 'POST', `/audits/${pid}/phishing`, {
        targets: [
          { email: 'dana@zz-phish.test', department: 'Group Finance' },
          { email: 'new@zz-phish.test', name: 'Newly Added' },
        ],
      });
      check(
        // Re-pasting a list with one new person on it should add one person.
        'adding the same list again updates rather than duplicates',
        again.body?.added === 1 && again.body?.updated === 1,
        JSON.stringify([again.body?.added, again.body?.updated])
      );

      /* ---------------------------------------------------- importing results -- */
      const results = JSON.stringify({
        results: [
          {
            Email: 'dana@zz-phish.test',
            Sent: 'Yes',
            Opened: 'Yes',
            Clicked: 'Yes',
            'Credentials Submitted': 'Yes',
            sent_at: '2029-05-04T09:00:00Z',
            clicked_at: '2029-05-04T09:04:00Z',
            submitted_at: '2029-05-04T09:06:00Z',
          },
          {
            email: 'marcus@zz-phish.test',
            sent: true,
            opened: true,
            clicked: false,
            reported: 'yes',
            sentAt: '2029-05-04T09:00:00Z',
            reportedAt: '2029-05-04T09:03:00Z',
          },
          { email: 'priya@zz-phish.test', sent: true },
          { email: 'not-a-real-address', sent: true },
          { nothing: 'useful' },
        ],
      });

      const imported = await call(alice, 'POST', `/audits/${pid}/phishing/import`, {
        json: results,
      });
      check(
        'a results file is read',
        imported.status === 200 && imported.body?.rows === 5,
        JSON.stringify(imported.body)
      );
      check(
        'matching the people already on the list rather than duplicating them',
        imported.body?.updated === 3 && imported.body?.added === 0,
        JSON.stringify([imported.body?.updated, imported.body?.added])
      );
      check(
        'and it says what it could not use, rather than failing on the whole file',
        imported.body?.skipped === 2 && (imported.body?.problems ?? []).length === 2,
        JSON.stringify(imported.body?.problems)
      );

      const dana = (imported.body?.targets ?? []).find((row) => row.email === 'dana@zz-phish.test');
      check(
        '"Credentials Submitted" is understood as being phished',
        dana?.phished === true && dana?.outcome === 'phished',
        JSON.stringify(dana)
      );
      const marcus = (imported.body?.targets ?? []).find(
        (row) => row.email === 'marcus@zz-phish.test'
      );
      check(
        'and somebody who reported it is recorded as having done the right thing',
        marcus?.reported === true && marcus?.outcome === 'reported',
        JSON.stringify(marcus)
      );

      /* ---------------------------------------------------------- the summary -- */
      const summary = imported.body?.summary;
      check(
        'rates are of the people the mail reached, not of the whole list',
        summary?.total === 4 && summary?.sent === 3 && summary?.reached === 3,
        JSON.stringify([summary?.total, summary?.sent, summary?.reached])
      );
      check(
        'so one person in three being phished reads as 33%',
        summary?.phished === 1 && summary?.phishedPercent === 33,
        JSON.stringify([summary?.phished, summary?.phishedPercent])
      );
      check(
        // The single most useful thing a campaign can tell a client about its people.
        'and it answers whether anybody raised the alarm before the first person fell for it',
        summary?.reportedBeforeFirstPhish === true &&
          summary?.firstReportMinutes === 3 &&
          summary?.firstPhishMinutes === 6,
        JSON.stringify([
          summary?.reportedBeforeFirstPhish,
          summary?.firstReportMinutes,
          summary?.firstPhishMinutes,
        ])
      );
      const finance = (summary?.departments ?? []).find((row) => row.department === 'Group Finance');
      check(
        'the breakdown is by department, worst first',
        Boolean(finance) && summary.departments[0].phishedPercent >= finance.phishedPercent,
        JSON.stringify(summary?.departments)
      );

      check(
        'an empty campaign summarises to honest zeros rather than dividing by nothing',
        campaignSummary([]).phishedPercent === 0 && campaignSummary([]).total === 0,
        JSON.stringify(campaignSummary([]))
      );

      /* ------------------------------------------------------- in the report -- */
      const data = await call(alice, 'GET', `/audits/${pid}/report-data`);
      check(
        'the report carries the campaign and its numbers',
        data.body?.hasPhishing === true &&
          data.body?.phishingSummary?.phished === 1 &&
          (data.body?.phishing ?? []).length === 4,
        JSON.stringify([data.body?.hasPhishing, data.body?.phishingSummary?.phished])
      );
      check(
        'and the people who fell for it separately, since naming them is not always permitted',
        (data.body?.phishedTargets ?? []).length === 1,
        JSON.stringify((data.body?.phishedTargets ?? []).map((t) => t.email))
      );

      /* ------------------------------------------- the tab cannot be hidden -- */
      const read = await call(bob, 'GET', `/audits/${pid}`);
      check(
        'the engagement reports how many recipients it holds, so its tab survives a kind change',
        read.body?.phishingCount === 4,
        JSON.stringify(read.body?.phishingCount)
      );

      /* --------------------------------------------------------------- scope -- */
      const outsider = await makeUser('phisher', 'user');
      const peek = await call(outsider, 'GET', `/audits/${pid}/phishing`);
      check('somebody off the engagement cannot read the list', peek.status === 403, `got ${peek.status}`);

      const cleared = await call(alice, 'DELETE', `/audits/${pid}/phishing`);
      check(
        'and the whole list can be cleared when a campaign was scoped wrongly',
        cleared.body?.removed === 4,
        JSON.stringify(cleared.body)
      );

      await PhishingTarget.deleteMany({ audit: pid });
      const { Audit: Audits14 } = await import('../models/audit.model.js');
      await Audits14.deleteMany({ name: /^zz-phish/ });
      await Types15.deleteMany({ name: /^zz-phish/ });
    }

    /* ------------------------------------------------------------------ kit ----- */
    log.info('Kit');
    {
      const { KitItem } = await import('../models/kit-item.model.js');
      await KitItem.deleteMany({ audit: auditId });

      const day = (offset) =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

      const added = await call(alice, 'POST', `/audits/${auditId}/kit`, {
        items: [
          { label: 'zz-kit drop box', kind: 'hardware', assetTag: 'ZZ-DB-02' },
          { label: 'zz-kit loaner laptop', kind: 'hardware' },
          { label: 'zz-kit cables', kind: 'consumable', quantity: 4 },
        ],
      });
      check(
        'several items can go on in one go',
        added.status === 201 && added.body?.added === 3,
        JSON.stringify(added.body?.added ?? added.body?.error)
      );
      check(
        'and they start as needed rather than as anything more definite',
        (added.body?.items ?? []).every((item) => item.status === 'needed'),
        JSON.stringify((added.body?.items ?? []).map((i) => i.status))
      );

      const listed = await call(bob, 'GET', `/audits/${auditId}/kit`);
      check(
        'anybody on the engagement sees the list and what is outstanding',
        listed.status === 200 && listed.body?.summary?.outstanding === 3,
        JSON.stringify(listed.body?.summary)
      );

      /* ------------------------------------------------- out, and back again --- */
      const box = (listed.body?.items ?? []).find((item) => /drop box/.test(item.label));
      const out = await call(bob, 'PUT', `/audits/${auditId}/kit/${box._id}`, {
        status: 'out',
        heldBy: String(bob.user._id),
        dueBack: day(-2),
      });
      check(
        'an item can go out with somebody',
        out.status === 200 && out.body?.status === 'out' && Boolean(out.body?.heldBy),
        JSON.stringify([out.body?.status, out.body?.heldBy])
      );

      const late = await call(alice, 'GET', `/audits/${auditId}/kit`);
      check(
        'and one past its due-back day is counted as overdue',
        late.body?.summary?.overdue === 1,
        JSON.stringify(late.body?.summary)
      );

      const lost = await call(alice, 'PUT', `/audits/${auditId}/kit/${box._id}`, {
        status: 'missing',
      });
      check('it can be recorded as not come back', lost.body?.status === 'missing', JSON.stringify(lost.body?.status));
      check(
        // The line somebody reads when a client asks where their badge went.
        'and that goes in the engagement log',
        ((await call(alice, 'GET', `/audits/${auditId}/activity`)).body?.entries ?? []).some(
          (entry) => entry.action === 'kit.missing'
        ),
        'no kit.missing entry'
      );

      /* -------------------------------------- kit that is lost needs attention - */
      const dash = await call(alice, 'GET', '/dashboard');
      const row = (dash.body?.attention ?? []).find(
        (entry) => String(entry.audit._id) === String(auditId)
      );
      check(
        'a thing loose in the world outranks a half-written finding',
        row?.reasons?.[0]?.code === 'kit-missing' && row.reasons[0].level === 'blocker',
        JSON.stringify(row?.reasons?.map((r) => r.code))
      );

      await call(alice, 'PUT', `/audits/${auditId}/kit/${box._id}`, { status: 'returned' });
      const back = await call(alice, 'GET', `/audits/${auditId}/kit`);
      check(
        'and once it is back it stops being either',
        back.body?.summary?.missing === 0 && back.body?.summary?.overdue === 0,
        JSON.stringify(back.body?.summary)
      );

      /* ------------------------------------------ the same box, twice at once -- */
      const other = await call(alice, 'POST', '/audits', {
        name: 'zz-kit another engagement',
        collaborators: [bob.user._id.toString()],
      });
      await call(alice, 'POST', `/audits/${other.body._id}/kit`, {
        items: [{ label: 'zz-kit drop box', assetTag: 'ZZ-DB-02', status: 'out' }],
      });

      const clash = await call(alice, 'GET', `/audits/${auditId}/kit`);
      check(
        // Only findable because a tag names a specific object rather than a kind of thing.
        'a tagged item out on another engagement is flagged as a clash',
        (clash.body?.clashes ?? []).some(
          (entry) => entry.assetTag === 'ZZ-DB-02' && String(entry.audit._id) === String(other.body._id)
        ),
        JSON.stringify(clash.body?.clashes)
      );

      const where = await call(alice, 'GET', `/audits/${auditId}/kit-where/ZZ-DB-02`);
      check(
        'and "where is it" answers across engagements',
        (where.body?.seen ?? []).length === 2,
        JSON.stringify((where.body?.seen ?? []).map((r) => r.audit.name))
      );

      const outsider = await makeUser('kitter', 'user');
      const theirs = await call(outsider, 'GET', `/audits/${auditId}/kit`);
      check('somebody off the engagement cannot read the list', theirs.status === 403, `got ${theirs.status}`);

      /* ---------------------------------------------------------- tidying up --- */
      const gone = await call(alice, 'DELETE', `/audits/${auditId}/kit/${box._id}`);
      check('an item can come off the list', gone.status === 200, JSON.stringify(gone.body?.error));

      const { Audit: Audits16 } = await import('../models/audit.model.js');
      await KitItem.deleteMany({ audit: { $in: [auditId, other.body._id] } });
      await Audits16.deleteMany({ name: /^zz-kit/ });
    }

    /* --------------------------------------------- finished, and put away ------ */
    log.info('Archiving');
    {
      // Bob is on it, so the list checks below can be made from somebody else's perspective.
      const own = await call(alice, 'POST', '/audits', {
        name: 'zz-archive engagement',
        collaborators: [bob.user._id.toString()],
      });
      const aid = own.body._id;

      const before = await call(bob, 'GET', '/audits');
      check(
        'a new engagement is in the working list',
        (before.body ?? []).some((row) => String(row._id) === String(aid)),
        'it was missing before archiving'
      );

      const archived = await call(alice, 'POST', `/audits/${aid}/archive`, {});
      check(
        'it can be archived',
        archived.status === 200 && Boolean(archived.body?.archivedAt),
        JSON.stringify(archived.body)
      );

      const after = await call(bob, 'GET', '/audits');
      check(
        'and leaves the working list',
        !(after.body ?? []).some((row) => String(row._id) === String(aid)),
        'an archived engagement was still in the list'
      );
      const inArchive = await call(bob, 'GET', '/audits?archived=1');
      check(
        'appearing in the archive instead',
        (inArchive.body ?? []).some((row) => String(row._id) === String(aid)),
        JSON.stringify((inArchive.body ?? []).map((r) => r.name))
      );
      check(
        'and the archive lists only archived engagements',
        (inArchive.body ?? []).every((row) => Boolean(row.archivedAt)),
        'the archive contained something that was not archived'
      );

      check(
        // Archiving is about which lists it appears in, not about permission.
        'it is still readable, and nothing about it is locked',
        (await call(bob, 'GET', `/audits/${aid}`)).status === 200 &&
          (await call(alice, 'POST', `/audits/${aid}/findings`, { title: 'zz-archive still editable' }))
            .status === 201,
        'an archived engagement could not be read or edited'
      );

      const twice = await call(alice, 'POST', `/audits/${aid}/archive`, {});
      check('archiving twice is refused rather than stacked', twice.status === 400, `got ${twice.status}`);

      const back = await call(alice, 'DELETE', `/audits/${aid}/archive`);
      check(
        'and it can come back out',
        back.status === 200 && back.body?.archivedAt === null,
        JSON.stringify(back.body)
      );
      const backAgain = await call(bob, 'GET', '/audits');
      check(
        'returning to the working list',
        (backAgain.body ?? []).some((row) => String(row._id) === String(aid)),
        'it did not come back'
      );

      const outsider = await makeUser('archiver', 'user');
      const poke = await call(outsider, 'POST', `/audits/${aid}/archive`, {});
      check('somebody off the engagement cannot archive it', poke.status === 403, `got ${poke.status}`);

      const { Audit: Audits13 } = await import('../models/audit.model.js');
      await Audits13.deleteMany({ name: /^zz-archive/ });
    }

    /* ----------------------------------------- what the client sent us --------- */
    log.info('Client documents');
    {
      const { EngagementDocument } = await import('../models/document.model.js');
      await EngagementDocument.deleteMany({ audit: auditId });

      const { safeFilename, serveableType } = await import('../services/documents.service.js');
      check(
        'a filename cannot steer a path',
        safeFilename('../../etc/passwd') === 'passwd',
        safeFilename('../../etc/passwd')
      );
      check(
        // The value ends up in a Content-Disposition header, where a quote ends the filename.
        'nor break out of the header it is written into',
        !safeFilename('a";b.pdf').includes('"') && !safeFilename("a';b.pdf").includes(';'),
        JSON.stringify([safeFilename('a";b.pdf'), safeFilename("a';b.pdf")])
      );
      check(
        'but an ordinary name keeps its spaces',
        safeFilename('Scope v2 signed.pdf') === 'Scope v2 signed.pdf',
        safeFilename('Scope v2 signed.pdf')
      );
      check(
        // A client file named scope.html, served back as HTML from this origin, is stored XSS.
        'a type a browser would render is never served as itself',
        serveableType('text/html') === 'application/octet-stream' &&
          serveableType('image/svg+xml') === 'application/octet-stream' &&
          serveableType('application/pdf') === 'application/pdf',
        JSON.stringify([serveableType('text/html'), serveableType('image/svg+xml')])
      );

      /* ------------------------------------------------------- uploading ----- */
      const BODY = 'zz-docs the signed authorisation, honest';
      const form = new FormData();
      form.append('file', new Blob([BODY], { type: 'application/pdf' }), 'Authorisation v2.pdf');
      form.append('kind', 'authorisation');
      form.append('note', 'Signed by their CISO');
      form.append('receivedFrom', 'Dana Whitfield');
      form.append('receivedOn', '2029-04-02');

      const stored = await call(alice, 'POST', `/audits/${auditId}/documents`, form);
      check('a document can be filed', stored.status === 201, JSON.stringify(stored.body?.error));
      check(
        'with what it is, who sent it and when',
        stored.body?.kind === 'authorisation' &&
          stored.body?.receivedFrom === 'Dana Whitfield' &&
          stored.body?.receivedOn === '2029-04-02',
        JSON.stringify(stored.body)
      );
      check(
        'and a digest, so "this file" means one file',
        /^[a-f0-9]{64}$/.test(stored.body?.sha256 ?? ''),
        JSON.stringify(stored.body?.sha256)
      );

      const listed = await call(bob, 'GET', `/audits/${auditId}/documents`);
      check(
        'anybody on the engagement can see it',
        (listed.body?.documents ?? []).length === 1,
        JSON.stringify(listed.body?.documents?.length)
      );

      /* ------------------------------------------------------ downloading ---- */
      const got = await call(
        bob,
        'GET',
        `/audits/${auditId}/documents/${stored.body._id}/download`
      );
      check(
        'the bytes come back',
        got.status === 200 && got.text === BODY,
        JSON.stringify([got.status, (got.text ?? '').slice(0, 30)])
      );
      check(
        'as an attachment, never rendered in place',
        /attachment/i.test(got.headers?.['content-disposition'] ?? ''),
        JSON.stringify(got.headers?.['content-disposition'])
      );
      check(
        'and the browser is told not to sniff a type of its own',
        got.headers?.['x-content-type-options'] === 'nosniff',
        JSON.stringify(got.headers?.['x-content-type-options'])
      );

      const afterRead = await call(alice, 'GET', `/audits/${auditId}/documents`);
      check(
        // Who fetched a client's contract is worth a trail, the same as revealing a credential.
        'and who fetched it is recorded',
        afterRead.body?.documents?.[0]?.downloads === 1 &&
          Boolean(afterRead.body?.documents?.[0]?.lastDownloadBy),
        JSON.stringify(afterRead.body?.documents?.[0]?.downloads)
      );

      /* ----------------------------------------------------------- scope ----- */
      const outsider = await makeUser('filer', 'user');
      const peek = await call(outsider, 'GET', `/audits/${auditId}/documents`);
      check('somebody off the engagement cannot list them', peek.status === 403, `got ${peek.status}`);
      const steal = await call(
        outsider,
        'GET',
        `/audits/${auditId}/documents/${stored.body._id}/download`
      );
      check('nor download one', steal.status === 403, `got ${steal.status}`);

      /* --------------------------------------------------------- removing --- */
      const gone = await call(alice, 'DELETE', `/audits/${auditId}/documents/${stored.body._id}`);
      check('it can be removed', gone.status === 200, JSON.stringify(gone.body?.error));
      const missing = await call(
        alice,
        'GET',
        `/audits/${auditId}/documents/${stored.body._id}/download`
      );
      check('and the download stops working', missing.status === 404, `got ${missing.status}`);

      await EngagementDocument.deleteMany({ audit: auditId });
    }

    /* ----------------------------------------------- a check nobody can do ------ */
    log.info('Blocked checks');
    {
      const made = await call(alice, 'POST', `/audits/${auditId}/test-checks`, {
        title: 'zz-blocked reach the payment sandbox',
        category: 'Payments',
      });
      const cid = made.body._id;

      const noReason = await call(alice, 'PUT', `/audits/${auditId}/test-checks/${cid}`, {
        blocked: true,
      });
      check(
        'blocking something without saying why is refused',
        noReason.status === 400 && /blocking/i.test(noReason.body?.error ?? ''),
        `${noReason.status} ${JSON.stringify(noReason.body?.error)}`
      );

      const blocked = await call(alice, 'PUT', `/audits/${auditId}/test-checks/${cid}`, {
        blocked: true,
        blockedReason: 'zz-blocked client has not opened the firewall',
      });
      check(
        'with a reason it is recorded',
        blocked.status === 200 && blocked.body?.blocked === true,
        JSON.stringify(blocked.body?.error ?? blocked.body?.blocked)
      );
      check(
        'and it is still not done — the two are different questions',
        blocked.body?.done === false,
        JSON.stringify(blocked.body?.done)
      );

      /* ------------------------------ it stops counting as an oversight ------- */
      const pre = await call(alice, 'GET', `/audits/${auditId}/preflight`);
      const outstanding = (pre.body?.issues ?? []).find((i) => i.code === 'checks-outstanding');
      const flagged = (pre.body?.issues ?? []).find((i) => i.code === 'checks-blocked');
      check(
        // Otherwise the only way to clear the warning is to lie about the check.
        'a blocked check is reported as blocked rather than as unticked',
        Boolean(flagged) && !/zz-blocked/.test(outstanding?.detail ?? ''),
        JSON.stringify([flagged?.message, outstanding?.detail])
      );

      const dash = await call(alice, 'GET', '/dashboard');
      const row = (dash.body?.attention ?? []).find(
        (entry) => String(entry.audit._id) === String(auditId)
      );
      check(
        'the dashboard counts it separately, so the outstanding number stops crying wolf',
        row?.health?.checksBlocked >= 1,
        JSON.stringify(row?.health)
      );

      /* ------------------------------------ the report says which it was ----- */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const printed = (data.body?.testChecks ?? []).find((c) => /zz-blocked/.test(c.title));
      check(
        'and the report says "Blocked" rather than "Not tested"',
        printed?.status === 'Blocked' && /firewall/.test(printed?.blockedReason ?? ''),
        JSON.stringify([printed?.status, printed?.blockedReason])
      );

      /* --------------------------------------------- ticking clears blocked -- */
      const done = await call(bob, 'PUT', `/audits/${auditId}/test-checks/${cid}`, { done: true });
      check(
        'ticking a blocked check clears the block — you did it, so it was not blocked',
        done.body?.done === true && done.body?.blocked === false,
        JSON.stringify([done.body?.done, done.body?.blocked])
      );
      const already = await call(alice, 'PUT', `/audits/${auditId}/test-checks/${cid}`, {
        blocked: true,
        blockedReason: 'too late',
      });
      check(
        'and something already done cannot be blocked',
        already.status === 400,
        `${already.status} ${JSON.stringify(already.body?.error)}`
      );

      await call(alice, 'DELETE', `/audits/${auditId}/test-checks/${cid}`);
    }

    /* ----------------------------------------------------------------- tags ---- */
    log.info('Engagement tags');
    {
      const tagged = await call(alice, 'PUT', `/audits/${auditId}`, {
        tags: ['ZZ-PCI', 'zz-pci', ' zz-retest '],
      });
      check(
        'tags are lower-cased and de-duplicated on the way in',
        tagged.status === 200 &&
          (tagged.body?.tags ?? []).length === 2 &&
          (tagged.body?.tags ?? []).includes('zz-pci') &&
          (tagged.body?.tags ?? []).includes('zz-retest'),
        JSON.stringify(tagged.body?.tags)
      );

      const all = await call(bob, 'GET', '/audits/tags');
      const pci = (all.body ?? []).find((row) => row.tag === 'zz-pci');
      check(
        'every tag in use is offered, with how many carry it',
        all.status === 200 && pci?.count >= 1,
        JSON.stringify((all.body ?? []).slice(0, 4))
      );

      const filtered = await call(bob, 'GET', '/audits?tags=zz-pci');
      check(
        'the list can be filtered by tag, in the query rather than the browser',
        (filtered.body ?? []).length >= 1 &&
          (filtered.body ?? []).every((row) => (row.tags ?? []).includes('zz-pci')),
        JSON.stringify((filtered.body ?? []).map((r) => r.tags))
      );

      const both = await call(bob, 'GET', '/audits?tags=zz-pci,zz-retest');
      check(
        'two tags means both, not either',
        (both.body ?? []).every(
          (row) => (row.tags ?? []).includes('zz-pci') && (row.tags ?? []).includes('zz-retest')
        ),
        JSON.stringify((both.body ?? []).map((r) => r.tags))
      );
      const neither = await call(bob, 'GET', '/audits?tags=zz-pci,zz-nothing-has-this');
      check(
        'and a tag nothing carries narrows it to nothing',
        (neither.body ?? []).length === 0,
        JSON.stringify((neither.body ?? []).length)
      );

      const outsider = await makeUser('tagger', 'user');
      const theirs = await call(outsider, 'GET', '/audits/tags');
      check(
        // The suggestion itself would say the tag exists, and therefore that the work does.
        'somebody who can see no engagements is offered no tags',
        (theirs.body ?? []).length === 0,
        JSON.stringify(theirs.body)
      );

      await call(alice, 'PUT', `/audits/${auditId}`, { tags: [] });
    }

    /* --------------------------------------------------- the front page -------- */
    log.info('Dashboard');
    {
      const { Booking: Books12 } = await import('../models/booking.model.js');
      const { TimeEntry: Time12 } = await import('../models/time-entry.model.js');
      await Books12.deleteMany({ audit: auditId });
      await Time12.deleteMany({ user: bob.user._id });

      const mine = await call(bob, 'GET', '/dashboard');
      check('the dashboard answers', mine.status === 200, JSON.stringify(mine.body?.error));
      check(
        'with totals of what this person can see, not of the instance',
        typeof mine.body?.totals?.engagements === 'number' &&
          typeof mine.body?.totals?.findings === 'number',
        JSON.stringify(mine.body?.totals)
      );

      const outsider = await makeUser('dash', 'user');
      const theirs = await call(outsider, 'GET', '/dashboard');
      check(
        'somebody on no engagements sees nothing rather than everybody else’s work',
        theirs.body?.totals?.engagements === 0 &&
          theirs.body?.mine?.clear === true &&
          (theirs.body?.attention ?? []).length === 0,
        JSON.stringify(theirs.body?.totals)
      );

      /* ------------------------------------------------ a check assigned to me */
      const check12 = await call(alice, 'POST', `/audits/${auditId}/test-checks`, {
        title: 'zz-dash a check that is bob’s',
        category: 'Authentication',
      });
      await call(alice, 'PUT', `/audits/${auditId}/test-checks/${check12.body._id}`, {
        assignedTo: String(bob.user._id),
      });

      const withCheck = await call(bob, 'GET', '/dashboard');
      check(
        'a check assigned to you turns up as yours',
        (withCheck.body?.mine?.checks ?? []).some((row) => /zz-dash a check/.test(row.title)),
        JSON.stringify((withCheck.body?.mine?.checks ?? []).map((c) => c.title))
      );
      const notAlices = await call(alice, 'GET', '/dashboard');
      check(
        'and not as somebody else’s',
        !(notAlices.body?.mine?.checks ?? []).some((row) => /zz-dash a check/.test(row.title)),
        JSON.stringify((notAlices.body?.mine?.checks ?? []).map((c) => c.title))
      );

      /* ------------------------------------ my finding with nothing to show for it */
      const bare = await call(bob, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-dash a finding with no screenshot',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      });
      const withFinding = await call(bob, 'GET', '/dashboard');
      const listed = (withFinding.body?.mine?.findings ?? []).find(
        (row) => String(row._id) === String(bare.body._id)
      );
      check(
        'a finding of yours with no evidence is listed, worst first',
        Boolean(listed) && listed.severity === 'Critical',
        JSON.stringify((withFinding.body?.mine?.findings ?? []).map((f) => [f.title, f.severity]))
      );
      check(
        // Somebody else's half-finished write-up is not your work to do.
        'but only yours',
        !(notAlices.body?.mine?.findings ?? []).some(
          (row) => String(row._id) === String(bare.body._id)
        ),
        'a finding belonging to somebody else was listed as mine'
      );

      /* ------------------------------------- booked, and days never written down */
      const day = (offset) =>
        new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      await Books12.create({
        audit: auditId,
        user: bob.user._id,
        start: day(-6),
        end: day(3),
        createdBy: alice.user._id,
      });

      const booked = await call(bob, 'GET', '/dashboard');
      check(
        'a booking you are on right now says so',
        (booked.body?.mine?.bookings ?? []).some((row) => row.current === true),
        JSON.stringify(booked.body?.mine?.bookings)
      );
      check(
        'and the days you were booked but never logged are named',
        (booked.body?.mine?.unloggedDays ?? []).length > 0 &&
          (booked.body?.mine?.unloggedDays ?? []).every((d) => d < day(0)),
        JSON.stringify(booked.body?.mine?.unloggedDays)
      );
      check(
        // A day you are still working is not a day you failed to log.
        'today is never one of them',
        !(booked.body?.mine?.unloggedDays ?? []).includes(day(0)),
        JSON.stringify(booked.body?.mine?.unloggedDays)
      );

      const missing = booked.body.mine.unloggedDays[0];
      await call(bob, 'POST', '/time', { audit: String(auditId), day: missing, hours: 7 });
      const afterLogging = await call(bob, 'GET', '/dashboard');
      check(
        'logging a day takes it off the list',
        !(afterLogging.body?.mine?.unloggedDays ?? []).includes(missing),
        JSON.stringify(afterLogging.body?.mine?.unloggedDays)
      );

      /* ------------------------------------------------ what needs a look, and why */
      const attention = (afterLogging.body?.attention ?? []).find(
        (row) => String(row.audit._id) === String(auditId)
      );
      check(
        'the engagement is flagged, with a reason that says what and where',
        Boolean(attention) &&
          attention.reasons.some((reason) => reason.code === 'no-evidence' && reason.tab === 'findings'),
        JSON.stringify(attention?.reasons)
      );

      await call(alice, 'POST', `/audits/${auditId}/hold`, { reason: 'zz-dash stood down' });
      const held = await call(bob, 'GET', '/dashboard');
      const heldRow = (held.body?.attention ?? []).find(
        (row) => String(row.audit._id) === String(auditId)
      );
      check(
        'stopping work is a blocker, and outranks everything else on the row',
        heldRow?.reasons?.[0]?.code === 'on-hold' && heldRow.reasons[0].level === 'blocker',
        JSON.stringify(heldRow?.reasons)
      );
      check(
        'and the reason travels with it rather than being looked up',
        /stood down/.test(heldRow?.reasons?.[0]?.label ?? ''),
        JSON.stringify(heldRow?.reasons?.[0]?.label)
      );
      await call(alice, 'DELETE', `/audits/${auditId}/hold`, {});
      /*
       * And taken back out. A later block counts the holds on this engagement, and a test that
       * leaves state behind only passes when it runs first.
       */
      const { Audit: Audits12 } = await import('../models/audit.model.js');
      await Audits12.updateOne({ _id: auditId }, { $set: { holds: [], onHold: false } });

      /* --------------------------------- an approved engagement is not a to-do list */
      const before = (await call(bob, 'GET', '/dashboard')).body;
      const wasClear = (before.mine.checks ?? []).length;
      await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'APPROVED' });
      const approved = await call(bob, 'GET', '/dashboard');
      check(
        'once an engagement is signed off its loose ends stop being work',
        (approved.body?.mine?.checks ?? []).length < wasClear ||
          wasClear === 0 ||
          !(approved.body?.mine?.checks ?? []).some((row) => /zz-dash a check/.test(row.title)),
        JSON.stringify((approved.body?.mine?.checks ?? []).map((c) => c.title))
      );
      check(
        'and it drops out of what needs a look',
        !(approved.body?.attention ?? []).some(
          (row) => String(row.audit._id) === String(auditId)
        ),
        'an approved engagement was still listed as needing attention'
      );
      await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'EDIT' });

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${bare.body._id}`);
      await call(alice, 'DELETE', `/audits/${auditId}/test-checks/${check12.body._id}`);
      await Books12.deleteMany({ audit: auditId });
      await Time12.deleteMany({ user: bob.user._id });
    }

    /* ------------------------------------------- how sensitive is this one ----- */
    log.info('Restricted engagements');
    {
      const { Audit: Audits10 } = await import('../models/audit.model.js');
      const { User: Users10 } = await import('../models/user.model.js');

      // Its own engagement: marking the shared one restricted would lock every later block out.
      const own = await call(alice, 'POST', '/audits', { name: 'zz-restricted engagement' });
      check('an engagement to restrict', own.status === 201, JSON.stringify(own.body?.error));
      const rid = own.body._id;

      const marked = await call(alice, 'PUT', `/audits/${rid}/classification`, {
        classification: 'restricted',
        note: 'zz NDA covers the findings as well as the data',
      });
      check(
        'anybody who can edit may mark one restricted',
        marked.status === 200 && marked.body?.classification === 'restricted',
        JSON.stringify(marked.body)
      );

      /* --------------------------------------- two-factor to open it --------- */
      const locked = await call(alice, 'GET', `/audits/${rid}`);
      check(
        'and without a second factor it cannot be opened — by anybody, including its author',
        locked.status === 403 && /two-factor/i.test(locked.body?.error ?? ''),
        `${locked.status} ${JSON.stringify(locked.body?.error)}`
      );

      // Alice is an admin in this suite, so this also proves the check sits above the admin
      // short-circuit rather than after it.
      const whoAmI = await call(alice, 'GET', '/auth/me');
      check(
        'which matters most for an admin, who can otherwise read everything',
        whoAmI.body?.user?.role === 'admin',
        JSON.stringify(whoAmI.body?.user?.role)
      );

      await Users10.findByIdAndUpdate(alice.user._id, { $set: { totpEnabled: true } });
      const opened = await call(alice, 'GET', `/audits/${rid}`);
      check(
        'with two-factor enrolled it opens normally',
        opened.status === 200 && opened.body?.classification === 'restricted',
        `${opened.status}`
      );

      /* ------------------------------------- credentials have to expire ------ */
      // The vault needs a key, and this block runs before the one that sets a real one.
      const cryptoMod = await import('node:crypto');
      const keyBefore10 = process.env.VAULT_KEY;
      process.env.VAULT_KEY = cryptoMod.default.randomBytes(32).toString('hex');

      const forever = await call(alice, 'POST', `/audits/${rid}/credentials`, {
        label: 'zz-restricted vpn',
        secret: 'not-a-real-secret',
      });
      check(
        'a credential that would outlive the job is refused',
        forever.status === 400 && /expire/i.test(forever.body?.error ?? ''),
        `${forever.status} ${JSON.stringify(forever.body?.error)}`
      );

      const tooLong = await call(alice, 'POST', `/audits/${rid}/credentials`, {
        label: 'zz-restricted vpn',
        secret: 'not-a-real-secret',
        expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      });
      check('and one asking for a year is accepted', tooLong.status === 201, JSON.stringify(tooLong.body?.error));
      check(
        'but shortened to the cap rather than argued about',
        new Date(tooLong.body?.expiresAt).getTime() <= Date.now() + 31 * 86_400_000,
        JSON.stringify(tooLong.body?.expiresAt)
      );

      /* -------------------------------- nothing goes into the library -------- */
      const finding = await call(alice, 'POST', `/audits/${rid}/findings`, {
        title: 'zz-restricted a finding that must not be shared',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        description: '<p>Something specific to this client.</p>',
      });
      const promoted = await call(alice, 'POST', `/audits/${rid}/findings/${finding.body._id}/promote`, {});
      check(
        'its write-ups cannot be promoted into the library everybody can read',
        promoted.status === 403 && /library/i.test(promoted.body?.error ?? ''),
        `${promoted.status} ${JSON.stringify(promoted.body?.error)}`
      );

      /* ------------------------------------------ a copy stays restricted ---- */
      const copy = await call(alice, 'POST', `/audits/${rid}/duplicate`, {
        name: 'zz-restricted copy',
      });
      check('it can be duplicated', copy.status === 201, JSON.stringify(copy.body?.error));
      // The route answers with `{ audit, copied, imagesRemoved }`, not the engagement itself.
      const copied = await Audits10.findById(copy.body?.audit?._id).select('classification');
      check(
        // Otherwise "duplicate, then work in the copy" is the simplest possible laundering.
        'and the copy is restricted too',
        copied?.classification === 'restricted',
        JSON.stringify(copied?.classification)
      );

      /* ------------------------------------ only an admin may take it off ---- */
      const bobTries = await call(bob, 'PUT', `/audits/${rid}/classification`, {
        classification: 'standard',
      });
      check(
        'somebody who is not an admin cannot remove the marking',
        bobTries.status === 403,
        `${bobTries.status} ${JSON.stringify(bobTries.body?.error)}`
      );
      const cleared = await call(alice, 'PUT', `/audits/${rid}/classification`, {
        classification: 'standard',
      });
      check(
        'an admin can',
        cleared.status === 200 && cleared.body?.classification === 'standard',
        JSON.stringify(cleared.body)
      );

      /* ------------------------------------------- a shorter trash window ---- */
      const { retentionDaysFor } = await import('../services/classification.service.js');
      const ordinary = await retentionDaysFor('standard');
      const strict = await retentionDaysFor('restricted');
      check(
        'restricted work leaves the trash sooner, never later',
        strict <= ordinary,
        JSON.stringify([ordinary, strict])
      );

      if (keyBefore10 === undefined) delete process.env.VAULT_KEY;
      else process.env.VAULT_KEY = keyBefore10;
      await Users10.findByIdAndUpdate(alice.user._id, { $set: { totpEnabled: false } });
      await Audits10.deleteMany({ name: /^zz-restricted/ });
    }

    /* -------------------------------------------- before we start ------------- */
    log.info('Pre-engagement questionnaire');
    {
      const { Intake } = await import('../models/intake.model.js');
      const { Company: Companies11 } = await import('../models/company.model.js');
      await Intake.deleteMany({});

      const company = await Companies11.findOne({});
      check('there is a client to ask', Boolean(company), 'no company in the instance');

      const made = await call(alice, 'POST', '/intake', {
        company: String(company._id),
        label: 'zz-intake annual external test',
      });
      check('a questionnaire link is issued', made.status === 201, JSON.stringify(made.body?.error));
      const token = String(made.body?.path ?? '').split('/').pop();
      check('and the link comes back once', token.length > 20, JSON.stringify(made.body?.path));

      const stored = await Intake.findById(made.body._id);
      check(
        // The same rule the password links follow: a dump of this collection must not be a set
        // of live links into somebody's client data.
        'only a hash of it is kept',
        Boolean(stored?.tokenHash) && stored.tokenHash !== token,
        'the raw token was stored'
      );

      /* ------------------------------------------------- the public half ----- */
      const anon = { token: null, refresh: null };
      const seen = await call(anon, 'GET', `/intake/public/${token}`);
      check(
        'somebody with no account can open it',
        seen.status === 200 && seen.body?.open === true,
        `${seen.status} ${JSON.stringify(seen.body?.error)}`
      );
      check(
        'and it tells them whose it is, so they know the form is theirs',
        seen.body?.company === company.name,
        JSON.stringify(seen.body?.company)
      );
      check(
        'and nothing else about this instance',
        seen.body?.requestedBy === undefined && seen.body?.tokenHash === undefined,
        JSON.stringify(Object.keys(seen.body ?? {}))
      );

      const wrong = await call(anon, 'GET', '/intake/public/not-a-real-token');
      check('a token that never existed is a 404', wrong.status === 404, `got ${wrong.status}`);

      const sent = await call(anon, 'POST', `/intake/public/${token}`, {
        contactName: 'Dana Whitfield',
        contactEmail: 'dana@zz-intake.invalid',
        engagementName: 'zz-intake Northwind external test',
        kind: 'External infrastructure',
        windowStart: '2029-03-05',
        windowEnd: '2029-03-16',
        assets: 'www.zz-intake.invalid\n203.0.113.10\napi.zz-intake.invalid',
        constraints: 'No denial of service. Do not touch the payment sandbox.',
        escalationName: 'Marcus Ellery',
        escalationPhone: '+40 700 000 000',
      });
      check('they can send it back', sent.status === 200, JSON.stringify(sent.body?.error));
      check(
        'and it stays editable until somebody builds the engagement',
        sent.body?.open === true && sent.body?.status === 'submitted',
        JSON.stringify([sent.body?.open, sent.body?.status])
      );

      /* ------------------------------------------- turning it into a job ----- */
      const built = await call(alice, 'POST', `/intake/${made.body._id}/engagement`, {});
      check('an engagement is built from the answers', built.status === 201, JSON.stringify(built.body?.error));

      const audit = await call(alice, 'GET', `/audits/${built.body.audit._id}`);
      check(
        'named and dated as they asked',
        audit.body?.name === 'zz-intake Northwind external test' &&
          audit.body?.date_start === '2029-03-05',
        JSON.stringify([audit.body?.name, audit.body?.date_start])
      );
      check(
        'with what they listed as the scope, one asset per line and addresses in the right column',
        (audit.body?.scope?.[0]?.hosts ?? []).length === 3 &&
          (audit.body?.scope?.[0]?.hosts ?? []).some((host) => host.ip === '203.0.113.10') &&
          (audit.body?.scope?.[0]?.hosts ?? []).some(
            (host) => host.hostname === 'api.zz-intake.invalid'
          ),
        JSON.stringify(audit.body?.scope?.[0]?.hosts)
      );
      check(
        'and what they said we must not do, kept where somebody will read it',
        (audit.body?.notes ?? []).some((note) => /payment sandbox/.test(note.content ?? '')),
        JSON.stringify((audit.body?.notes ?? []).map((n) => n.title))
      );

      const usedAgain = await call(alice, 'POST', `/intake/${made.body._id}/engagement`, {});
      check(
        'a questionnaire only builds one engagement',
        usedAgain.status === 400,
        `${usedAgain.status} ${JSON.stringify(usedAgain.body?.error)}`
      );
      const closed = await call(anon, 'GET', `/intake/public/${token}`);
      check(
        'and the link closes once it has been used',
        closed.body?.open === false,
        JSON.stringify(closed.body?.reason)
      );

      const { Audit: Audits11 } = await import('../models/audit.model.js');
      await Audits11.deleteMany({ name: /^zz-intake/ });
      await Intake.deleteMany({});
    }

    /* --------------------------------------------------- the client rang ------- */
    log.info('Stopping work');
    {
      const { Notification: Notify9 } = await import('../models/notification.model.js');
      const { Booking: Books9 } = await import('../models/booking.model.js');
      await Notify9.deleteMany({ type: 'engagement-held' });
      await Books9.deleteMany({ audit: auditId });

      // Somebody booked onto it from tomorrow: exactly the person who otherwise turns up and
      // carries on testing something they were told to stop.
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const nextWeek = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
      await Books9.create({
        audit: auditId,
        user: bob.user._id,
        start: tomorrow,
        end: nextWeek,
        createdBy: alice.user._id,
      });

      const noReason = await call(alice, 'POST', `/audits/${auditId}/hold`, { reason: '  ' });
      check(
        'stopping without saying why is refused',
        noReason.status === 422 || noReason.status === 400,
        `got ${noReason.status}`
      );

      // Whatever stage it happens to be at when the client rings.
      const stateBefore = (await call(alice, 'GET', `/audits/${auditId}`)).body?.state;

      const stopped = await call(alice, 'POST', `/audits/${auditId}/hold`, {
        reason: 'zz-hold client reported an unrelated outage',
      });
      check(
        'work can be stopped, with a reason',
        stopped.status === 200 && stopped.body?.onHold === true,
        JSON.stringify(stopped.body?.error ?? stopped.body?.onHold)
      );
      check(
        'and whoever is booked onto it is told',
        stopped.body?.notified >= 1,
        JSON.stringify(stopped.body?.notified)
      );
      const told = await Notify9.find({ type: 'engagement-held', user: bob.user._id });
      check(
        'the reason travels with the notification, since that is what it is for',
        told.length === 1 && /unrelated outage/.test(told[0].message),
        JSON.stringify(told.map((n) => n.message))
      );

      const seen = await call(bob, 'GET', `/audits/${auditId}`);
      check(
        'the engagement says it is stopped',
        seen.body?.onHold === true &&
          (seen.body?.holds ?? []).some((hold) => !hold.endedAt),
        JSON.stringify(seen.body?.onHold)
      );
      check(
        // A fourth state would have forced resuming to guess which stage to go back to, and
        // an engagement in review can be stopped just as easily as one nobody has started.
        'and its state is untouched, because being stopped is a different axis',
        seen.body?.state === stateBefore,
        JSON.stringify([stateBefore, seen.body?.state])
      );

      check(
        'nothing is locked — writing up what was already done still works',
        (await call(bob, 'POST', `/audits/${auditId}/notes`, { title: 'zz-hold write-up' }))
          .status === 201,
        'a note could not be added while stopped'
      );

      const twice = await call(alice, 'POST', `/audits/${auditId}/hold`, { reason: 'again' });
      check(
        'stopping something already stopped is refused rather than stacked',
        twice.status === 400,
        `got ${twice.status}`
      );

      const listed = await call(bob, 'GET', '/audits');
      const row = (listed.body ?? []).find((entry) => String(entry._id) === String(auditId));
      check(
        'the list carries it, or a stopped engagement looks like every other one',
        row?.onHold === true,
        JSON.stringify(row?.onHold)
      );

      /* ------------------------------------------------------------- resuming */
      await Notify9.deleteMany({ type: 'engagement-held' });
      const resumed = await call(bob, 'DELETE', `/audits/${auditId}/hold`, {
        resumeNote: 'zz-hold client confirmed it was unrelated',
      });
      check(
        'and it can be started again',
        resumed.status === 200 && resumed.body?.onHold === false,
        JSON.stringify(resumed.body?.error ?? resumed.body?.onHold)
      );
      const back = await call(alice, 'GET', `/audits/${auditId}`);
      const hold = (back.body?.holds ?? [])[0];
      check(
        'the stop is kept rather than deleted, with both ends and both people',
        Boolean(hold?.startedAt && hold?.endedAt && hold?.startedBy && hold?.endedBy),
        JSON.stringify(hold)
      );
      check(
        'including why it started again',
        /client confirmed/.test(hold?.resumeNote ?? ''),
        JSON.stringify(hold?.resumeNote)
      );
      check(
        'and the derived flag agrees with the record it summarises',
        back.body?.onHold === false,
        JSON.stringify(back.body?.onHold)
      );

      const again = await call(alice, 'DELETE', `/audits/${auditId}/hold`, {});
      check(
        'resuming something that is running is refused',
        again.status === 400,
        `got ${again.status}`
      );

      // Stopped twice is two facts, not an edit to the first.
      await call(alice, 'POST', `/audits/${auditId}/hold`, { reason: 'zz-hold second time' });
      const twiceStopped = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'a second stop is a second record',
        (twiceStopped.body?.holds ?? []).length === 2 && twiceStopped.body?.onHold === true,
        JSON.stringify((twiceStopped.body?.holds ?? []).length)
      );
      await call(alice, 'DELETE', `/audits/${auditId}/hold`, {});

      /* --------------------------------------------------------------- scope */
      const outsider = await makeUser('holder', 'user');
      const poke = await call(outsider, 'POST', `/audits/${auditId}/hold`, { reason: 'not mine' });
      check('somebody off the engagement cannot stop it', poke.status === 403, `got ${poke.status}`);

      await Books9.deleteMany({ audit: auditId });
      await Notify9.deleteMany({ type: 'engagement-held' });
      const notes = (await call(alice, 'GET', `/audits/${auditId}`)).body?.notes ?? [];
      const written = notes.find((note) => note.title === 'zz-hold write-up');
      if (written) await call(alice, 'DELETE', `/audits/${auditId}/notes/${written._id}`);
    }

    /* ------------------------------------------------ who else could review ---- */
    log.info('Reviewer suggestions');
    {
      // Alice creates, bob reviews; carol is the outsider with the matching skill.
      const carol = await makeUser('suggest', 'user');
      const { User: Users7 } = await import('../models/user.model.js');
      await Users7.findByIdAndUpdate(carol.user._id, {
        $set: {
          'profile.skills': [
            { name: 'Active Directory', level: 'expert' },
            { name: 'Testing', level: 'expert' },
          ],
        },
      });

      await call(alice, 'PUT', `/audits/${auditId}`, { auditType: 'Active Directory review' });

      const suggested = await call(alice, 'GET', `/audits/${auditId}/reviewer-suggestions`);
      check(
        'the engagement describes its own subject matter',
        suggested.status === 200 &&
          (suggested.body?.topics ?? []).some((topic) => /active directory/i.test(topic)),
        JSON.stringify(suggested.body?.topics)
      );
      check(
        'somebody with a matching skill is suggested, and it says so',
        suggested.body?.bySkill === true &&
          (suggested.body?.suggestions ?? []).some(
            (person) =>
              String(person._id) === String(carol.user._id) &&
              person.matchedSkills.some((skill) => skill.name === 'Active Directory')
          ),
        JSON.stringify((suggested.body?.suggestions ?? []).map((p) => [p.username, p.matchedSkills]))
      );
      check(
        // "Testing" and "security" appear in half of everything; matching on them would
        // suggest the entire company and the feature would be ignored within a week.
        'a skill that says nothing about the subject is not treated as a match',
        (suggested.body?.suggestions ?? [])
          .flatMap((person) => person.matchedSkills)
          .every((skill) => skill.name !== 'Testing'),
        JSON.stringify((suggested.body?.suggestions ?? []).flatMap((p) => p.matchedSkills))
      );
      check(
        'nobody already on the engagement is suggested',
        (suggested.body?.suggestions ?? []).every(
          (person) =>
            String(person._id) !== String(alice.user._id) &&
            String(person._id) !== String(bob.user._id)
        ),
        JSON.stringify((suggested.body?.suggestions ?? []).map((p) => p.username))
      );

      // Away for the whole window, so not suggestible however good the match.
      const { Leave: Leaves7 } = await import('../models/leave.model.js');
      await Leaves7.deleteMany({ user: carol.user._id });
      await Leaves7.create({
        user: carol.user._id,
        start: '2029-11-05',
        end: '2029-11-16',
        type: 'holiday',
        status: 'approved',
        createdBy: carol.user._id,
      });
      const whileAway = await call(
        alice,
        'GET',
        `/audits/${auditId}/reviewer-suggestions?from=2029-11-05`
      );
      check(
        'and somebody away for the whole window is not suggested at all',
        (whileAway.body?.suggestions ?? []).every(
          (person) => String(person._id) !== String(carol.user._id)
        ),
        JSON.stringify((whileAway.body?.suggestions ?? []).map((p) => p.username))
      );
      await Leaves7.deleteMany({ user: carol.user._id });
      await call(alice, 'PUT', `/audits/${auditId}`, { auditType: '' });
      /*
       * Skills are counted across the whole instance by the Skills page, so a throwaway account
       * left holding two expert skills quietly changes what a later block asserts about depth.
       * A test that only passes when it runs first is not a test.
       */
      await Users7.findByIdAndUpdate(carol.user._id, { $set: { 'profile.skills': [] } });
    }

    /* -------------------------------------------- what happened to a finding --- */
    log.info('Finding timeline');
    {
      const made = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-timeline a finding with a life',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      });
      const fid = made.body._id;

      const fresh = await call(alice, 'GET', `/audits/${auditId}/findings/${fid}/timeline`);
      check(
        'a new finding has one event: it was written up',
        fresh.status === 200 &&
          fresh.body?.events?.length === 1 &&
          fresh.body.events[0].kind === 'created',
        JSON.stringify((fresh.body?.events ?? []).map((e) => e.kind))
      );
      check(
        'and it has not been in anything sent to the client',
        (fresh.body?.versions ?? []).length === 0 && fresh.body?.reopened === false,
        JSON.stringify(fresh.body?.versions)
      );

      // Fixed, then open again — the case nobody could previously prove.
      let current = (await call(alice, 'GET', `/audits/${auditId}/findings/${fid}`)).body;
      await call(alice, 'PUT', `/audits/${auditId}/findings/${fid}`, {
        remediationStatus: 'fixed',
        expectedUpdatedAt: current.updatedAt,
      });
      current = (await call(alice, 'GET', `/audits/${auditId}/findings/${fid}`)).body;
      const reopen = await call(bob, 'PUT', `/audits/${auditId}/findings/${fid}`, {
        remediationStatus: 'open',
        expectedUpdatedAt: current.updatedAt,
      });
      check('the status can be moved back', reopen.status === 200, JSON.stringify(reopen.body?.error));

      const lived = await call(bob, 'GET', `/audits/${auditId}/findings/${fid}/timeline`);
      const statuses = (lived.body?.events ?? []).filter((event) => event.kind === 'status');
      check(
        'every status move is kept, with who moved it',
        statuses.length === 2 &&
          statuses[0].status === 'fixed' &&
          statuses[1].status === 'open' &&
          Boolean(statuses[1].by),
        JSON.stringify(statuses.map((e) => [e.status, Boolean(e.by)]))
      );
      check(
        'and a finding marked fixed that came back says so',
        lived.body?.reopened === true,
        JSON.stringify(lived.body?.reopened)
      );

      // A delivery sent after it was written is inferred to have contained it.
      const { Delivery: Deliveries7 } = await import('../models/delivery.model.js');
      await Deliveries7.deleteMany({ audit: auditId });
      await call(alice, 'POST', `/audits/${auditId}/deliveries`, {
        version: '2.1',
        sentAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const delivered = await call(alice, 'GET', `/audits/${auditId}/findings/${fid}/timeline`);
      const sent = (delivered.body?.events ?? []).filter((event) => event.kind === 'delivered');
      check(
        'a delivery after the finding was written counts as having carried it',
        sent.length === 1 && sent[0].version === '2.1',
        JSON.stringify(sent.map((e) => e.version))
      );
      check(
        // Worked out from dates rather than recorded per finding, and a history that presents
        // an inference as a record is worse than one that admits it.
        'and it is labelled as inferred rather than passed off as a record',
        sent[0]?.inferred === true && (delivered.body?.versions ?? []).includes('2.1'),
        JSON.stringify([sent[0]?.inferred, delivered.body?.versions])
      );
      await Deliveries7.deleteMany({ audit: auditId });
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${fid}`);
    }

    /* ------------------------------------------ work that comes round again ---- */
    log.info('Recurring engagements');
    {
      const { Notification: Notify8 } = await import('../models/notification.model.js');
      const { remindRecurringEngagements, advanceDue } = await import(
        '../services/recurrence-reminders.service.js'
      );

      check(
        'a month interval lands on the same day of the month',
        advanceDue('2029-01-15', 12) === '2030-01-15',
        advanceDue('2029-01-15', 12)
      );
      check(
        // The 31st plus a month overflows into the month after, which would quietly move an
        // annual retest by three days every year.
        'and the end of a month is clamped rather than overflowing',
        advanceDue('2029-01-31', 1) === '2029-02-28',
        advanceDue('2029-01-31', 1)
      );

      const set = await call(alice, 'PUT', `/audits/${auditId}/repeat`, {
        months: 12,
        nextDue: '2029-12-01',
      });
      check(
        'an engagement can be told it comes round again',
        set.status === 200 && set.body?.repeat?.months === 12,
        JSON.stringify(set.body?.repeat)
      );

      await Notify8.deleteMany({ type: 'engagement-due' });
      // Well outside the lead time: nothing should go out yet.
      const early = await remindRecurringEngagements({ now: new Date('2029-06-01T09:00:00Z') });
      check('nothing is said months ahead', early.sent === 0, JSON.stringify(early));

      const nudged = await remindRecurringEngagements({ now: new Date('2029-11-10T09:00:00Z') });
      check(
        'but somebody is told a month before it is due',
        nudged.sent >= 1,
        JSON.stringify(nudged)
      );
      const inbox = await Notify8.find({ type: 'engagement-due' });
      check(
        'the notification names the engagement and when',
        inbox.length >= 1 && /is due/.test(inbox[0].message),
        JSON.stringify(inbox.map((n) => n.message))
      );
      check(
        'and it goes to whoever would actually run it, not to reviewers',
        inbox.every((row) => String(row.user) !== String(bob.user._id)) ||
          inbox.some((row) => String(row.user) === String(alice.user._id)),
        JSON.stringify(inbox.map((n) => String(n.user)))
      );

      const again = await remindRecurringEngagements({ now: new Date('2029-11-11T09:00:00Z') });
      check(
        'saying it twice would be spam, so it is said once',
        again.sent === 0,
        JSON.stringify(again)
      );

      // Moving the date re-arms it, rather than inheriting "already told them".
      await call(alice, 'PUT', `/audits/${auditId}/repeat`, {
        months: 12,
        nextDue: '2029-11-20',
      });
      const rearmed = await remindRecurringEngagements({ now: new Date('2029-11-11T09:00:00Z') });
      check(
        'changing the due date arms the reminder again',
        rearmed.sent >= 1,
        JSON.stringify(rearmed)
      );

      const cleared = await call(alice, 'PUT', `/audits/${auditId}/repeat`, { months: null });
      check(
        'clearing it takes the due date with it, so nothing fires a year later',
        cleared.body?.repeat?.months === null && !cleared.body?.repeat?.nextDue,
        JSON.stringify(cleared.body?.repeat)
      );

      const outsider = await makeUser('repeat', 'user');
      const poke = await call(outsider, 'PUT', `/audits/${auditId}/repeat`, { months: 12 });
      check('somebody off the engagement cannot schedule it', poke.status === 403, `got ${poke.status}`);

      await Notify8.deleteMany({ type: 'engagement-due' });
    }

    /* ---------------------------------------------- the engagement by host ----- */
    log.info('Working view — the engagement host by host');
    {
      const { DetectionEvent: Detect6 } = await import('../models/detection-event.model.js');
      await Detect6.deleteMany({ audit: auditId });

      // A scope with two assets whose addresses are deliberately awkward: one is a prefix of
      // the other's hostname, and one address is a prefix of the other's.
      const scoped = await call(alice, 'PUT', `/audits/${auditId}`, {
        scope: [
          {
            name: 'zz-hosts perimeter',
            hosts: [
              { hostname: 'zz.example', ip: '10.9.0.1', os: 'Linux' },
              { hostname: 'api.zz.example', ip: '10.9.0.10' },
              { hostname: 'idle.zz.example', ip: '10.9.0.44' },
            ],
          },
        ],
      });
      check('a scope is saved', scoped.status === 200, JSON.stringify(scoped.body?.error));

      const board = await call(bob, 'GET', `/audits/${auditId}/hosts`);
      check(
        'the board lists every asset in the scope',
        board.status === 200 && board.body?.hosts?.length === 3,
        JSON.stringify((board.body?.hosts ?? []).map((h) => h.label))
      );
      check(
        'and starts with nothing finished',
        board.body?.counts?.total === 3 && board.body?.counts?.pending === 3,
        JSON.stringify(board.body?.counts)
      );

      /* ------------------------------------------- matching, and its boundaries */
      const onApi = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-hosts token accepted on the API',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        scope: 'api.zz.example (10.9.0.10)',
      });
      check('a finding naming one host is added', onApi.status === 201, JSON.stringify(onApi.body?.error));

      const api = await call(alice, 'GET', `/audits/${auditId}/hosts/api.zz.example`);
      check(
        'a host can be opened by its hostname',
        api.status === 200 && api.body?.hostname === 'api.zz.example',
        JSON.stringify(api.body?.hostname)
      );
      check(
        'and the finding that names it is listed, with where it was named',
        api.body?.findings?.length === 1 &&
          api.body.findings[0].matchedIn.includes('affected assets'),
        JSON.stringify(api.body?.findings?.[0])
      );

      // The whole trick: a plain substring test would put this finding on `zz.example` too,
      // because its name is the tail of `api.zz.example`.
      const parent = await call(alice, 'GET', `/audits/${auditId}/hosts/zz.example`);
      check(
        'a shorter hostname does not collect the findings of everything under it',
        parent.body?.findings?.length === 0,
        JSON.stringify((parent.body?.findings ?? []).map((f) => f.title))
      );

      // And the same for addresses: 10.9.0.1 is a prefix of 10.9.0.10.
      const byIp = await call(alice, 'GET', `/audits/${auditId}/hosts/10.9.0.1`);
      check(
        'nor does a shorter address collect the findings of a longer one',
        byIp.body?.findings?.length === 0 && byIp.body?.hostname === 'zz.example',
        JSON.stringify([byIp.body?.hostname, byIp.body?.findings?.length])
      );

      /* --------------------------------------- the other things that can match */
      await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Fuzzed the token endpoint',
        target: 'api.zz.example',
        occurredAt: '2028-06-01T09:00:00.000Z',
        outcome: 'not-detected',
        noise: 'loud',
      });
      const withEvent = await call(alice, 'GET', `/audits/${auditId}/hosts/api.zz.example`);
      check(
        'a logged action aimed at the host shows up against it',
        withEvent.body?.detections?.length === 1,
        JSON.stringify(withEvent.body?.detections)
      );

      /* ------------------------------------------------ a targeted host update */
      const marked = await call(bob, 'PUT', `/audits/${auditId}/hosts/idle.zz.example`, {
        status: 'tested',
        notes: 'Nothing on it. 22 and 443 only, both patched.',
      });
      check(
        'one asset can be marked off without saving the whole scope',
        marked.status === 200 && marked.body?.status === 'tested',
        JSON.stringify(marked.body?.status)
      );
      check(
        'and the working notes come back with it',
        (marked.body?.notes ?? '').startsWith('Nothing on it'),
        JSON.stringify(marked.body?.notes)
      );

      const afterMark = await call(bob, 'GET', `/audits/${auditId}/hosts`);
      check(
        'the board counts it as done',
        afterMark.body?.counts?.tested === 1 && afterMark.body?.counts?.pending === 2,
        JSON.stringify(afterMark.body?.counts)
      );
      check(
        'and knows which unfinished asset already has findings on it',
        afterMark.body?.counts?.unfinishedWithFindings === 1,
        JSON.stringify(afterMark.body?.counts?.unfinishedWithFindings)
      );
      check(
        'the list view says a note exists without shipping the text to it',
        // Keyed by address, and the address is the IP where there is one — which is what
        // dedupes two entries for the same asset.
        (afterMark.body?.hosts ?? []).some((h) => h.key === '10.9.0.44' && h.hasNotes) &&
          (afterMark.body?.hosts ?? []).every((h) => h.notes === undefined),
        JSON.stringify((afterMark.body?.hosts ?? []).map((h) => [h.key, h.hasNotes]))
      );

      /* -------------------------------- working notes never reach a report ---- */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const reportHosts = (data.body?.scope ?? []).flatMap((group) => group.hosts ?? []);
      check(
        'the report carries the scope',
        reportHosts.length === 3,
        JSON.stringify(reportHosts.length)
      );
      check(
        // `...raw` used to spread the whole host into the template scope, which handed the
        // operator's scratch pad to {{ .notes }} inside a hosts loop.
        'but not one word of anybody’s working notes',
        reportHosts.every((host) => host.notes === undefined),
        JSON.stringify(reportHosts.map((h) => h.notes))
      );
      check(
        'and the client-facing status note is still there, since that is what it is for',
        reportHosts.some((host) => host.statusLabel === 'Tested'),
        JSON.stringify(reportHosts.map((h) => h.statusLabel))
      );

      /* --------------------------- a scope save must not wipe the notes ------- */
      const current = await call(alice, 'GET', `/audits/${auditId}`);
      const keptScope = (current.body?.scope ?? []).map((group) => ({
        name: group.name,
        hosts: (group.hosts ?? []).map((host) => ({
          hostname: host.hostname,
          ip: host.ip,
          os: host.os,
          services: host.services ?? [],
          status: host.status,
          statusNote: host.statusNote,
          notes: host.notes,
        })),
      }));
      await call(alice, 'PUT', `/audits/${auditId}`, { scope: keptScope });
      const survived = await call(alice, 'GET', `/audits/${auditId}/hosts/idle.zz.example`);
      check(
        'notes survive a save that carries them, so the editor must keep the field',
        (survived.body?.notes ?? '').startsWith('Nothing on it'),
        JSON.stringify(survived.body?.notes)
      );

      /* --------------------------------------------------------------- scope -- */
      const missing = await call(alice, 'GET', `/audits/${auditId}/hosts/not.in.scope`);
      check('an address nothing matches is a 404', missing.status === 404, `got ${missing.status}`);

      const outsider = await makeUser('hostview', 'user');
      const peek = await call(outsider, 'GET', `/audits/${auditId}/hosts`);
      check('somebody off the engagement cannot read it', peek.status === 403, `got ${peek.status}`);
      const poke = await call(outsider, 'PUT', `/audits/${auditId}/hosts/idle.zz.example`, {
        status: 'tested',
      });
      check('nor mark anything off', poke.status === 403, `got ${poke.status}`);

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${onApi.body._id}`);
      await Detect6.deleteMany({ audit: auditId });
      await call(alice, 'PUT', `/audits/${auditId}`, { scope: [] });
    }

    /* ------------------------------------------- is anybody there to review ---- */
    log.info('Review readiness');
    {
      const { Leave: Leaves5 } = await import('../models/leave.model.js');
      const { Booking: Books5 } = await import('../models/booking.model.js');
      const { Notification: Notify5 } = await import('../models/notification.model.js');

      /*
       * Scoped to the throwaway accounts, never blanket: public holidays have no owner, so a
       * `deleteMany({})` here would wipe a live instance's calendar.
       */
      const ours5 = {
        $or: [
          { user: { $in: [alice.user._id, bob.user._id] } },
          { createdBy: { $in: [alice.user._id, bob.user._id] } },
        ],
      };
      await Leaves5.deleteMany(ours5);
      await Books5.deleteMany({ audit: auditId });

      // A Monday well clear of anything real, pinned so the answer does not depend on the
      // day the suite happens to run.
      const MON = '2029-10-01';
      const TUE = '2029-10-02';
      const FRI = '2029-10-05';

      const at = (from) => `/audits/${auditId}/review-readiness?from=${from}`;

      // Bob is the only reviewer to start with, and he is around.
      await call(alice, 'PUT', `/audits/${auditId}`, {
        reviewers: [bob.user._id.toString()],
      });

      const clear = await call(alice, 'GET', at(MON));
      check(
        'the window is a working week, weekends left out of it',
        clear.status === 200 && clear.body?.from === MON && clear.body?.to === FRI &&
          clear.body?.workingDays === 5,
        JSON.stringify([clear.body?.from, clear.body?.to, clear.body?.workingDays])
      );
      check(
        'a reviewer with nothing booked against them is simply available',
        clear.body?.counts?.available === 1 && clear.body?.stalled === false,
        JSON.stringify(clear.body?.counts)
      );
      check(
        'and there is nothing worth interrupting anybody about',
        clear.body?.worthSaying === false && clear.body?.summary === null,
        JSON.stringify([clear.body?.worthSaying, clear.body?.summary])
      );

      // Asking on a Saturday has to answer with the week that follows, not one that is
      // already two days spent.
      const weekend = await call(alice, 'GET', at('2029-09-29'));
      check(
        'asking at the weekend answers with the next working week',
        weekend.body?.from === MON && weekend.body?.to === FRI,
        JSON.stringify([weekend.body?.from, weekend.body?.to])
      );

      /* ------------------------------------------------ a day off, not a crisis */
      const oneDay = await Leaves5.create({
        user: bob.user._id,
        start: TUE,
        end: TUE,
        type: 'holiday',
        status: 'approved',
        createdBy: bob.user._id,
      });
      const partly = await call(alice, 'GET', at(MON));
      check(
        'one day off leaves them around, with fewer days',
        partly.body?.reviewers?.[0]?.partly === true &&
          partly.body?.reviewers?.[0]?.availableDays === 4 &&
          partly.body?.reviewers?.[0]?.away === false,
        JSON.stringify(partly.body?.reviewers?.[0])
      );
      check(
        'and a single day off is not worth a dialog',
        partly.body?.worthSaying === false,
        JSON.stringify([partly.body?.worthSaying, partly.body?.summary])
      );

      /* --------------------------------------------------- away for all of it */
      await Leaves5.deleteOne({ _id: oneDay._id });
      await Leaves5.create({
        user: bob.user._id,
        start: MON,
        end: '2029-10-12',
        type: 'holiday',
        status: 'approved',
        createdBy: bob.user._id,
      });
      const away = await call(alice, 'GET', at(MON));
      check(
        'a reviewer away for the whole window has no days at all',
        away.body?.reviewers?.[0]?.away === true &&
          away.body?.reviewers?.[0]?.availableDays === 0,
        JSON.stringify(away.body?.reviewers?.[0])
      );
      check(
        'the only reviewer being away is a stall, and says so',
        away.body?.stalled === true && away.body?.worthSaying === true,
        JSON.stringify([away.body?.stalled, away.body?.summary])
      );
      check(
        'and it answers when they are back, looked for past the window',
        away.body?.reviewers?.[0]?.backOn === '2029-10-15',
        JSON.stringify(away.body?.reviewers?.[0]?.backOn)
      );

      /* ----------------------------- requested leave is said, never counted --- */
      await Leaves5.deleteMany(ours5);
      await Leaves5.create({
        user: bob.user._id,
        start: MON,
        end: FRI,
        type: 'holiday',
        status: 'requested',
        createdBy: bob.user._id,
      });
      const asked = await call(alice, 'GET', at(MON));
      check(
        'leave that is only requested does not take anybody days away',
        asked.body?.reviewers?.[0]?.availableDays === 5 &&
          asked.body?.reviewers?.[0]?.away === false,
        JSON.stringify(asked.body?.reviewers?.[0]?.availableDays)
      );
      check(
        'but it is said out loud, marked as not yet approved',
        /requested, not yet approved/.test(asked.body?.reviewers?.[0]?.clash ?? ''),
        JSON.stringify(asked.body?.reviewers?.[0]?.clash)
      );

      /* --------------------------------- booked elsewhere is context, not a no */
      await Leaves5.deleteMany(ours5);
      await Books5.create({
        audit: auditId,
        user: bob.user._id,
        start: MON,
        end: FRI,
        createdBy: alice.user._id,
      });
      const busy = await call(alice, 'GET', at(MON));
      check(
        'being booked all week does not make somebody unavailable to read a report',
        busy.body?.reviewers?.[0]?.away === false &&
          busy.body?.reviewers?.[0]?.bookedDays === 5 &&
          busy.body?.worthSaying === false,
        JSON.stringify(busy.body?.reviewers?.[0])
      );
      await Books5.deleteMany({ audit: auditId });

      /* ------------------------------------------------- access that has gone */
      const gone = await call(alice, 'PUT', `/audits/${auditId}`, {
        memberUntil: [{ user: bob.user._id.toString(), until: '2020-01-01' }],
      });
      check('an access expiry can be set', gone.status === 200, JSON.stringify(gone.body?.error));

      const expired = await call(alice, 'GET', at(MON));
      check(
        'a reviewer whose access has run out counts as blocked, not as available',
        expired.body?.reviewers?.[0]?.accessExpired === true &&
          expired.body?.counts?.expired === 1 &&
          expired.body?.stalled === true,
        JSON.stringify(expired.body?.reviewers?.[0])
      );

      // And the notification that would have linked them to a 403 is not sent.
      await Notify5.deleteMany({ user: bob.user._id, type: 'review-requested' });
      await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'EDIT' });
      const requested = await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'REVIEW' });
      check(
        'moving to review answers with who could actually look at it',
        requested.status === 200 && requested.body?.review?.stalled === true,
        JSON.stringify(requested.body?.review?.summary)
      );
      check(
        'nobody is asked to review something they can no longer open',
        requested.body?.review?.notified === 0,
        JSON.stringify(requested.body?.review?.notified)
      );
      const inbox = await Notify5.countDocuments({
        user: bob.user._id,
        type: 'review-requested',
      });
      check('so no notification was written either', inbox === 0, `got ${inbox}`);

      /* ------------------------------------------- and once access is restored */
      await call(alice, 'PUT', `/audits/${auditId}`, { memberUntil: [] });
      await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'EDIT' });
      const again = await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'REVIEW' });
      check(
        'a reviewer who is around is asked, and nothing is worth saying about it',
        again.body?.review?.notified === 1 && again.body?.review?.worthSaying === false,
        JSON.stringify(again.body?.review)
      );

      /* -------------------------------------------------------- no reviewers */
      await call(alice, 'PUT', `/audits/${auditId}`, { reviewers: [] });
      const nobody = await call(alice, 'GET', at(MON));
      check(
        'an engagement with no reviewers says that rather than reporting nobody away',
        nobody.body?.noReviewers === true && nobody.body?.stalled === false,
        JSON.stringify(nobody.body?.summary)
      );

      const outsider = await makeUser('reviewready', 'user');
      const peek = await call(outsider, 'GET', at(MON));
      check('somebody off the engagement cannot ask', peek.status === 403, `got ${peek.status}`);

      // Left as the suite found it.
      await call(alice, 'PUT', `/audits/${auditId}`, {
        reviewers: [bob.user._id.toString()],
      });
      await call(alice, 'PUT', `/audits/${auditId}/state`, { state: 'EDIT' });
      await Leaves5.deleteMany(ours5);
      await Books5.deleteMany({ audit: auditId });
      await Notify5.deleteMany({ user: bob.user._id, type: 'review-requested' });
    }

    /* ------------------------------------------------------- were we seen ------ */
    log.info('Detection');
    {
      const { DetectionEvent } = await import('../models/detection-event.model.js');
      await DetectionEvent.deleteMany({ audit: auditId });

      const empty = await call(bob, 'GET', `/audits/${auditId}/detections`);
      check(
        'an engagement starts with nothing logged',
        empty.status === 200 && (empty.body?.detections ?? []).length === 0,
        JSON.stringify(empty.body)
      );
      check(
        'and its figures are zeroes rather than absent, so a page has something to render',
        empty.body?.summary?.total === 0 && empty.body?.summary?.respondedPercent === 0,
        JSON.stringify(empty.body?.summary)
      );
      check(
        'the vocabularies come from the schema, so the form is not a copy of it',
        (empty.body?.outcomes ?? []).length === 6 && (empty.body?.noiseLevels ?? []).length === 3,
        JSON.stringify([empty.body?.outcomes?.length, empty.body?.noiseLevels?.length])
      );

      // A loud action nobody answered — the headline case.
      const loudMiss = await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Password spray against the VPN portal',
        target: 'vpn.zz.example',
        technique: 'T1110.003',
        occurredAt: '2028-04-03T09:12:00.000Z',
        outcome: 'not-detected',
        noise: 'loud',
      });
      check('a logged action comes back', loudMiss.status === 201, JSON.stringify(loudMiss.body));

      // One they saw in four minutes and acted on twenty-six minutes later.
      const caught = await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Dumped LSASS on a workstation',
        target: 'ZZ-WS-014',
        technique: 'T1003.001',
        occurredAt: '2028-04-04T14:05:00.000Z',
        outcome: 'blocked',
        noise: 'loud',
        detectedAt: '2028-04-04T14:09:00.000Z',
        respondedAt: '2028-04-04T14:31:00.000Z',
      });
      check('and so does one they caught', caught.status === 201, JSON.stringify(caught.body));
      check(
        'the latency is computed rather than left to the page to subtract two dates',
        caught.body?.detectionLatencyMinutes === 4 &&
          caught.body?.detectionLatency === '4 min' &&
          caught.body?.responseLatencyMinutes === 26,
        JSON.stringify([caught.body?.detectionLatency, caught.body?.responseLatency])
      );

      // Logged and ignored: the middle of the ladder, and the reason it is a ladder.
      await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Kerberoast three service accounts',
        technique: 'T1558.003',
        occurredAt: '2028-04-05T11:40:00.000Z',
        outcome: 'logged',
        noise: 'standard',
        detectedAt: '2028-04-05T11:44:00.000Z',
      });
      // And one nobody has asked about yet.
      await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Exfiltrated 40 MB over HTTPS',
        technique: 'T1048',
        occurredAt: '2028-04-06T16:20:00.000Z',
        outcome: 'unknown',
        noise: 'quiet',
      });

      const listed = await call(bob, 'GET', `/audits/${auditId}/detections`);
      const sum = listed.body?.summary;
      check(
        'four actions are logged',
        (listed.body?.detections ?? []).length === 4,
        JSON.stringify((listed.body?.detections ?? []).length)
      );
      check(
        'an unconfirmed outcome is held out of the rates, not counted as a miss',
        sum?.total === 4 && sum?.confirmed === 3 && sum?.unconfirmed === 1,
        JSON.stringify([sum?.total, sum?.confirmed, sum?.unconfirmed])
      );
      check(
        'so the response rate is one in three, not one in four',
        sum?.responded === 1 && sum?.respondedPercent === 33,
        JSON.stringify([sum?.responded, sum?.respondedPercent])
      );
      check(
        '"logged and ignored" counts as noticed but not as answered',
        sum?.noticed === 2 && sum?.loggedOnly === 1 && sum?.noticedPercent === 67,
        JSON.stringify([sum?.noticed, sum?.loggedOnly, sum?.noticedPercent])
      );
      check(
        'and it counts as a loud miss only when the action was meant to be seen',
        sum?.loudTotal === 2 && sum?.loudMisses === 1,
        JSON.stringify([sum?.loudTotal, sum?.loudMisses])
      );
      check(
        'the median time to notice is the middle value, in words',
        sum?.medianDetectMinutes === 4 && sum?.medianDetect === '4 min',
        JSON.stringify([sum?.medianDetectMinutes, sum?.medianDetect])
      );
      check(
        'techniques are grouped, busiest first, each with its own coverage',
        (sum?.techniques ?? []).length === 4 &&
          sum.techniques.every((group) => group.total === 1),
        JSON.stringify((sum?.techniques ?? []).map((g) => g.technique))
      );

      /* ---------------------------------------------- times that cannot be ----- */
      const backwards = await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Noticed before it happened',
        occurredAt: '2028-04-07T10:00:00.000Z',
        outcome: 'alerted',
        detectedAt: '2028-04-07T09:00:00.000Z',
      });
      check(
        'nobody can be detected before they act',
        backwards.status === 400 && /before it happened/i.test(backwards.body?.error ?? ''),
        `${backwards.status} ${JSON.stringify(backwards.body?.error)}`
      );

      const earlyResponse = await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Answered before it was seen',
        occurredAt: '2028-04-07T10:00:00.000Z',
        outcome: 'alerted',
        detectedAt: '2028-04-07T11:00:00.000Z',
        respondedAt: '2028-04-07T10:30:00.000Z',
      });
      check(
        'and a response cannot precede the detection it answers',
        earlyResponse.status === 400,
        `${earlyResponse.status} ${JSON.stringify(earlyResponse.body?.error)}`
      );

      const contradiction = await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Not detected, at a specific time',
        occurredAt: '2028-04-07T10:00:00.000Z',
        outcome: 'not-detected',
        detectedAt: '2028-04-07T10:05:00.000Z',
      });
      check(
        'a row cannot say both "nobody noticed" and when they noticed',
        contradiction.status === 400,
        `${contradiction.status} ${JSON.stringify(contradiction.body?.error)}`
      );

      /*
       * The edit path checks the merged record, not the patch: moving only `detectedAt`
       * still has to hold against the `occurredAt` already stored.
       */
      const badEdit = await call(alice, 'PUT', `/audits/${auditId}/detections/${caught.body._id}`, {
        detectedAt: '2028-04-04T13:00:00.000Z',
      });
      check(
        'an edit is judged on the record it produces, not on the fields it sends',
        badEdit.status === 400,
        `${badEdit.status} ${JSON.stringify(badEdit.body?.error)}`
      );

      /* ---------------------------------------------------- a finding link ----- */
      const stray = await call(alice, 'POST', `/audits/${auditId}/detections`, {
        action: 'Linked to somebody else’s finding',
        occurredAt: '2028-04-07T10:00:00.000Z',
        finding: String(auditId),
      });
      check(
        'a gap cannot be written up as a finding from another engagement',
        stray.status === 400,
        `${stray.status} ${JSON.stringify(stray.body?.error)}`
      );

      /* --------------------------------------------------- who may touch it ---- */
      const outsider = await makeUser('detection', 'user');
      const peek = await call(outsider, 'GET', `/audits/${auditId}/detections`);
      check('somebody off the engagement cannot read the log', peek.status === 403, `got ${peek.status}`);
      const inject = await call(outsider, 'POST', `/audits/${auditId}/detections`, {
        action: 'Not mine to log',
        occurredAt: '2028-04-07T10:00:00.000Z',
      });
      check('nor add to it', inject.status === 403, `got ${inject.status}`);

      /* -------------------------------------------------- and in the report ---- */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'the report carries the timeline',
        (data.body?.detection ?? []).length === 4 && data.body?.hasDetection === true,
        JSON.stringify((data.body?.detection ?? []).length)
      );
      check(
        'oldest first, because it is a timeline rather than a feed',
        data.body?.detection?.[0]?.action === 'Password spray against the VPN portal',
        JSON.stringify(data.body?.detection?.[0]?.action)
      );
      check(
        // The instance pattern, whatever it is, with the clock appended: a detection log
        // reading its dates differently from the delivery table beside it would be a bug.
        'with a timestamp in this instance’s own date format, plus the clock',
        /^2028-04-03 \d{2}:\d{2}$/.test(data.body?.detection?.[0]?.at ?? ''),
        JSON.stringify(data.body?.detection?.[0]?.at)
      );
      check(
        'the loud misses are handed over as their own list, since that is the table clients read',
        (data.body?.detectionLoudMisses ?? []).length === 1 &&
          data.body.detectionLoudMisses[0].action === 'Password spray against the VPN portal',
        JSON.stringify((data.body?.detectionLoudMisses ?? []).map((row) => row.action))
      );
      check(
        'and the report’s figures are the same ones the tab shows',
        data.body?.detectionSummary?.respondedPercent === sum?.respondedPercent &&
          data.body?.detectionSummary?.loudMisses === sum?.loudMisses,
        JSON.stringify(data.body?.detectionSummary)
      );

      const removed = await call(bob, 'DELETE', `/audits/${auditId}/detections/${caught.body._id}`);
      check('an entry logged by mistake can go', removed.status === 200, JSON.stringify(removed.body));
      const afterRemoval = await call(bob, 'GET', `/audits/${auditId}/detections`);
      check(
        'and the figures are recalculated without it',
        afterRemoval.body?.summary?.total === 3 && afterRemoval.body?.summary?.responded === 0,
        JSON.stringify(afterRemoval.body?.summary)
      );

      await DetectionEvent.deleteMany({ audit: auditId });
    }

    /* ------------------------------------ identifiers survive the trash -------- */
    log.info('Finding identifiers and the trash');
    {
      /*
       * The number a report prints has to stay unique.
       *
       * Deleting the highest-numbered finding used to free its number for the next one, and
       * restoring it then brought the original back with the same identifier — two findings
       * called VULN-04 in one document.
       */
      const first = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-ident kept',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      });
      const highest = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-ident deleted then restored',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      });
      check(
        'two findings, numbered in sequence',
        highest.body?.identifier === first.body?.identifier + 1,
        JSON.stringify([first.body?.identifier, highest.body?.identifier])
      );

      const deleted = await call(alice, 'DELETE', `/audits/${auditId}/findings/${highest.body._id}`);
      check('the highest-numbered one goes to the trash', deleted.status === 200, JSON.stringify(deleted.body));

      const replacement = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-ident written after the deletion',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      });
      check(
        'a number still in the trash is not handed out again',
        replacement.body?.identifier !== highest.body?.identifier,
        `reused ${replacement.body?.identifier}, which is restorable`
      );

      const restored = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${highest.body._id}/restore`
      );
      check('and it can still be restored', restored.status === 200, JSON.stringify(restored.body?.error));

      const after = await call(alice, 'GET', `/audits/${auditId}`);
      const numbers = (after.body?.findings ?? [])
        .map((finding) => finding.identifier)
        .filter((value) => Number.isFinite(value));
      check(
        'no two findings share the number the report prints',
        new Set(numbers).size === numbers.length,
        JSON.stringify(numbers)
      );

      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      const ids = (data.body?.findings ?? []).map((finding) => finding.id);
      check(
        'and the report gives every finding its own id',
        new Set(ids).size === ids.length,
        JSON.stringify(ids)
      );

      for (const title of [
        'zz-ident kept',
        'zz-ident deleted then restored',
        'zz-ident written after the deletion',
      ]) {
        const row = (after.body?.findings ?? []).find((finding) => finding.title === title);
        if (row) await call(alice, 'DELETE', `/audits/${auditId}/findings/${row._id}`);
      }
      const { DeletedFinding: Bin } = await import('../models/deleted-finding.model.js');
      await Bin.deleteMany({ audit: auditId, title: /^zz-ident/ });
    }

    /* --------------------------------- moving a finding to another engagement --- */
    log.info('Moving and copying a finding between engagements');
    {
      const { Company } = await import('../models/company.model.js');
      const sameClient = await Company.create({ name: 'zz-transfer same client' });
      const otherClient = await Company.create({ name: 'zz-transfer other client' });

      // The source, on one client; two destinations, one of them the same client.
      await call(alice, 'PUT', `/audits/${auditId}`, { company: String(sameClient._id) });
      const near = await call(alice, 'POST', '/audits', {
        name: 'zz-transfer same-client engagement',
        company: String(sameClient._id),
      });
      const far = await call(alice, 'POST', '/audits', {
        name: 'zz-transfer other-client engagement',
        company: String(otherClient._id),
      });
      check(
        'two destinations exist',
        near.status === 201 && far.status === 201,
        JSON.stringify({ near: near.status, far: far.status })
      );

      const make = (title) =>
        call(alice, 'POST', `/audits/${auditId}/findings`, {
          title,
          cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
          description: '<p>the issue</p><p><img src="/api/media/6a70c9343bb8776321e44788"/></p>',
          poc: '<p>proof</p>',
          references: ['https://example.invalid/advisory'],
        });

      /* ------------------------------------------------------------- a move */
      const moving = await make('zz-transfer to be moved');
      await call(alice, 'POST', `/audits/${auditId}/findings/${moving.body._id}/comments`, {
        text: 'a review remark about the old report',
      });

      const moved = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${moving.body._id}/transfer`,
        { target: String(far.body._id), mode: 'move' }
      );
      check('a finding can be moved', moved.status === 201, JSON.stringify(moved.body?.error ?? moved.body));
      check(
        'it is renumbered on the engagement it lands on',
        moved.body?.identifier === 1,
        JSON.stringify(moved.body?.identifier)
      );

      const source = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'and it is gone from the one it came from',
        !(source.body?.findings ?? []).some((f) => f.title === 'zz-transfer to be moved'),
        'the finding is still on the source engagement'
      );
      const target = await call(alice, 'GET', `/audits/${far.body._id}`);
      const landed = (target.body?.findings ?? []).find((f) => f.title === 'zz-transfer to be moved');
      check(
        'a move takes its evidence with it, even to another client — it is the same work',
        landed?.description?.includes('<img') && landed?.evidenceCount === 1,
        JSON.stringify({ img: landed?.description?.includes('<img'), count: landed?.evidenceCount })
      );
      check(
        'review comments stay behind: they were about the other report',
        (landed?.comments ?? []).length === 0,
        JSON.stringify(landed?.comments?.length)
      );
      check(
        'authorship survives the move',
        String(landed?.createdBy?._id ?? landed?.createdBy) === String(alice.user._id),
        JSON.stringify(landed?.createdBy)
      );
      check(
        'and the references came across',
        (landed?.references ?? []).length === 1,
        JSON.stringify(landed?.references)
      );

      /* ------------------------------------- a copy, to the same client */
      const copying = await make('zz-transfer to be copied');
      const copiedNear = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${copying.body._id}/transfer`,
        { target: String(near.body._id), mode: 'copy' }
      );
      check(
        'a copy to the same client keeps the screenshots',
        copiedNear.status === 201 &&
          copiedNear.body?.sameClient === true &&
          copiedNear.body?.imagesRemoved === 0,
        JSON.stringify(copiedNear.body)
      );
      const stillHere = await call(alice, 'GET', `/audits/${auditId}`);
      check(
        'and leaves the original where it was',
        (stillHere.body?.findings ?? []).some((f) => f.title === 'zz-transfer to be copied'),
        'the original disappeared on a copy'
      );

      /* ------------------------------- a copy, to a different client */
      const copiedFar = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${copying.body._id}/transfer`,
        { target: String(far.body._id), mode: 'copy' }
      );
      check(
        'a copy to another client leaves the evidence behind, and says how much',
        copiedFar.body?.sameClient === false && copiedFar.body?.imagesRemoved === 1,
        JSON.stringify(copiedFar.body)
      );
      const farAudit = await call(alice, 'GET', `/audits/${far.body._id}`);
      const arrived = (farAudit.body?.findings ?? []).find(
        (f) => f.title === 'zz-transfer to be copied'
      );
      check(
        'so one client’s screenshot cannot appear in another’s report',
        !arrived?.description?.includes('<img') && arrived?.evidenceCount === 0,
        JSON.stringify({ description: arrived?.description, count: arrived?.evidenceCount })
      );
      check(
        'and the two findings on that engagement have different numbers',
        new Set((farAudit.body?.findings ?? []).map((f) => f.identifier)).size ===
          (farAudit.body?.findings ?? []).length,
        JSON.stringify((farAudit.body?.findings ?? []).map((f) => f.identifier))
      );

      /* ------------------------------------------------------------ refusals */
      const itself = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${copying.body._id}/transfer`,
        { target: String(auditId) }
      );
      check('an engagement cannot receive its own finding', itself.status === 400, `got ${itself.status}`);

      const nowhere = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${copying.body._id}/transfer`,
        { target: '0'.repeat(24) }
      );
      check('nor can a destination that does not exist', nowhere.status === 404, `got ${nowhere.status}`);

      // Bob is on the source but not on Alice's new engagements.
      const notMine = await call(
        bob,
        'POST',
        `/audits/${auditId}/findings/${copying.body._id}/transfer`,
        { target: String(far.body._id) }
      );
      check(
        'and not an engagement the caller is not on',
        notMine.status === 403,
        `got ${notMine.status} ${notMine.body?.error}`
      );

      // A signed-off engagement is frozen, at both ends.
      await call(alice, 'PUT', `/audits/${far.body._id}/state`, { state: 'APPROVED' });
      const frozen = await call(
        bob,
        'POST',
        `/audits/${auditId}/findings/${copying.body._id}/transfer`,
        { target: String(far.body._id) }
      );
      check(
        'an approved engagement does not silently accept new findings',
        frozen.status === 403,
        `got ${frozen.status}`
      );

      const log4 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'both engagements record the transfer',
        (log4.body?.entries ?? []).some((entry) => entry.action === 'finding.transferred'),
        JSON.stringify((log4.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${copying.body._id}`);
      await Audit.deleteMany({ name: /^zz-transfer/ });
      await Company.deleteMany({ name: /^zz-transfer/ });
      await call(alice, 'PUT', `/audits/${auditId}`, { company: null });
    }

    /* ------------------------------------------- engagement health signals ----- */
    log.info('Engagement health on the list');
    {
      const withEvidence = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-health with a screenshot',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
        poc: '<p><img src="/api/media/6a70c9343bb8776321e44777"/></p>',
      });
      const without = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-health with none',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      });
      check(
        'the evidence count is stored, not derived at read time',
        withEvidence.body?.evidenceCount === 1 && without.body?.evidenceCount === 0,
        JSON.stringify({ a: withEvidence.body?.evidenceCount, b: without.body?.evidenceCount })
      );

      // Editing the text has to move the count with it, or the list lies after one save.
      const emptied = await call(alice, 'PUT', `/audits/${auditId}/findings/${withEvidence.body._id}`, {
        poc: '<p>the screenshot was removed</p>',
      });
      check(
        'and it follows the text when a screenshot is taken out',
        emptied.body?.evidenceCount === 0,
        JSON.stringify(emptied.body?.evidenceCount)
      );

      const list = await call(alice, 'GET', '/audits');
      const row = (list.body ?? []).find((entry) => String(entry._id) === String(auditId));
      check(
        'the list reports what needs attention',
        row?.health && typeof row.health.staleDays === 'number' && row.health.noEvidence >= 2,
        JSON.stringify(row?.health)
      );
      check(
        'and no longer ships the findings themselves',
        row?.findings === undefined && row?.testChecks === undefined && row?.findingCount > 0,
        JSON.stringify({ findings: row?.findings, count: row?.findingCount })
      );

      // Overdue is a promise to a client that has passed, not merely an old engagement.
      await call(alice, 'PUT', `/audits/${auditId}`, { date_end: '2020-01-01' });
      const overdue = await call(alice, 'GET', '/audits');
      check(
        'an engagement past its end date and not signed off is overdue',
        (overdue.body ?? []).find((e) => String(e._id) === String(auditId))?.health?.overdue === true,
        'expected overdue'
      );
      await call(alice, 'PUT', `/audits/${auditId}`, { date_end: '' });
      const cleared = await call(alice, 'GET', '/audits');
      check(
        'and not overdue once there is no end date to miss',
        (cleared.body ?? []).find((e) => String(e._id) === String(auditId))?.health?.overdue === false,
        'expected not overdue'
      );

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${withEvidence.body._id}`);
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${without.body._id}`);
    }

    /* --------------------------------------- replacing a screenshot everywhere -- */
    log.info('Replacing a screenshot');
    {
      // Two 1x1 PNGs that differ, so the store cannot deduplicate them into one object.
      const RED = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64'
      );
      const BLUE = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7xJ2vwAAAABJRU5ErkJggg==',
        'base64'
      );

      const upload = async (who, bytes, name) => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'image/png' }), name);
        const response = await fetch(`${base}/media`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${who.token}` },
          body: form,
        });
        return { status: response.status, body: await response.json() };
      };

      const first = await upload(alice, RED, 'before.png');
      check('a screenshot can be stored', first.status === 201, JSON.stringify(first.body));
      const mediaId = first.body.id;

      // The same image in three places: two fields of one finding, and a section.
      const one = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-replace first finding',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
        description: `<p>see <img src="/api/media/${mediaId}" alt="shot"/></p>`,
        poc: `<figure><img src="/api/media/${mediaId}" data-caption="Figure of the flaw"/></figure>`,
      });
      await call(alice, 'PUT', `/audits/${auditId}`, {
        sections: [
          {
            field: 'appendix',
            name: 'Appendix',
            text: `<p><img src="/api/media/${mediaId}"/></p>`,
            customFields: [],
          },
        ],
      });

      const replace = async (who, bytes, name) => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'image/png' }), name);
        const response = await fetch(`${base}/audits/${auditId}/media/${mediaId}/replace`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${who.token}` },
          body: form,
        });
        return { status: response.status, body: await response.json() };
      };

      const swapped = await replace(alice, BLUE, 'after.png');
      check(
        'one upload repoints every reference in the engagement',
        swapped.status === 200 && swapped.body?.replaced === 3,
        JSON.stringify(swapped.body)
      );
      check(
        'and the new file is a different stored object',
        swapped.body?.id && swapped.body.id !== mediaId,
        JSON.stringify({ before: mediaId, after: swapped.body?.id })
      );

      const after = await call(alice, 'GET', `/audits/${auditId}`);
      const finding = (after.body?.findings ?? []).find((f) => f.title === 'zz-replace first finding');
      check(
        'the old id is gone from every field',
        !JSON.stringify(after.body).includes(mediaId),
        'the previous media id is still referenced somewhere'
      );
      check(
        'the caption and alt text survived — they belong to the reference, not the file',
        finding?.poc?.includes('Figure of the flaw') && finding?.description?.includes('alt="shot"'),
        JSON.stringify({ poc: finding?.poc, description: finding?.description })
      );
      check(
        'and the evidence count is unchanged',
        finding?.evidenceCount === 2,
        JSON.stringify(finding?.evidenceCount)
      );

      /*
       * Uploading the same bytes again dedupes to the same stored object, which is not a
       * replacement — asked of the id the document now references, which is what the editor
       * always passes.
       */
      const replaceCurrent = async (bytes, name) => {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'image/png' }));
        const response = await fetch(
          `${base}/audits/${auditId}/media/${swapped.body.id}/replace`,
          { method: 'POST', headers: { Authorization: `Bearer ${alice.token}` }, body: form }
        );
        return { status: response.status, body: await response.json() };
      };
      const same = await replaceCurrent(BLUE, 'after-again.png');
      check(
        'replacing an image with itself says so rather than reporting a change',
        same.body?.unchanged === true && same.body?.replaced === 0,
        JSON.stringify(same.body)
      );

      const outsider = await makeUser('replacer', 'user');
      const denied = await replace(outsider, RED, 'nope.png');
      check('somebody off the engagement cannot replace its evidence', denied.status === 403, `got ${denied.status}`);

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${one.body._id}`);
      await call(alice, 'PUT', `/audits/${auditId}`, { sections: [] });
    }

    /* ------------------------------------------- per-client report settings ----- */
    log.info('Per-client report settings');
    {
      const { Company } = await import('../models/company.model.js');
      /*
       * Its own client, created here.
       *
       * Reusing whatever company the engagement happened to have made the test depend on
       * another block not having deleted it — which is exactly what went wrong: the update
       * silently matched nothing and the assertions failed against a feature that worked.
       */
      const company = await Company.create({ name: 'zz-report-settings client' });
      await call(alice, 'PUT', `/audits/${auditId}`, {
        company: String(company._id),
        // A date to observe: a format cannot be checked against an empty field.
        date: '2026-08-06',
      });

      const before = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'without an override the instance format applies',
        before.body?.date === '2026-08-06',
        JSON.stringify(before.body?.date)
      );

      await Company.findByIdAndUpdate(company._id, {
        $set: { 'report.dateFormat': 'dd.MM.yyyy', 'report.findingIdPrefix': 'ZZ-' },
      });

      const after = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'a client’s own date format is used for their report',
        after.body?.date === '06.08.2026',
        JSON.stringify(after.body?.date)
      );
      check(
        'and their own finding prefix',
        (after.body?.findings ?? []).length > 0 &&
          (after.body?.findings ?? []).every((finding) => String(finding.id).startsWith('ZZ-')),
        JSON.stringify((after.body?.findings ?? []).map((f) => f.id).slice(0, 3))
      );

      // A delivery date has to read the same way as every other date in the same document.
      const { Delivery } = await import('../models/delivery.model.js');
      await Delivery.deleteMany({ audit: auditId });
      await call(alice, 'POST', `/audits/${auditId}/deliveries`, {
        version: '1.0',
        sentAt: '2026-08-06T10:00:00.000Z',
      });
      const withDelivery = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'the delivery table follows the same format, so two dates in one document agree',
        withDelivery.body?.lastDelivery?.date === '06.08.2026',
        JSON.stringify(withDelivery.body?.lastDelivery?.date)
      );
      await Delivery.deleteMany({ audit: auditId });

      // An empty override must fall back, not blank the value.
      await Company.findByIdAndUpdate(company._id, { $set: { 'report.dateFormat': '' } });
      const cleared = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'clearing an override falls back rather than emptying the value',
        cleared.body?.date === '2026-08-06',
        JSON.stringify(cleared.body?.date)
      );
      check(
        'while another override on the same client still applies',
        (cleared.body?.findings ?? []).every((finding) => String(finding.id).startsWith('ZZ-')),
        JSON.stringify((cleared.body?.findings ?? []).map((f) => f.id).slice(0, 3))
      );

      await call(alice, 'PUT', `/audits/${auditId}`, { date: '' });
      await Company.deleteOne({ _id: company._id });
    }

    /* ------------------------------------- promoting a finding to the library --- */
    log.info('Promoting a finding into the library');
    {
      const { Vulnerability } = await import('../models/vulnerability.model.js');
      await Vulnerability.deleteMany({ 'details.title': /^zz-promote/ });

      const made = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-promote Session fixation on the login form',
        vulnType: 'Web Application',
        category: 'Authentication',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N',
        priority: 3,
        remediationComplexity: 2,
        description: '<p>The session id survives authentication.</p><p><img src="/api/media/6a70c9343bb8776321e44700" alt="evidence"/></p>',
        observation: '<p>An attacker who fixes the cookie keeps the session.</p>',
        remediation: '<p>Rotate the session on privilege change.</p>',
        poc: '<p>curl -i https://target/login</p><p><img src="data:image/png;base64,AAAA" alt="pasted"/></p>',
        scope: '<p>login.acme.example</p>',
        references: ['https://owasp.org/www-community/attacks/Session_fixation'],
      });
      check('a finding to promote', made.status === 201, JSON.stringify(made.body?.error));

      const promoted = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${made.body._id}/promote`,
        {}
      );
      check(
        'a finding can be promoted into the library',
        promoted.status === 201 && Boolean(promoted.body?.vulnerability),
        JSON.stringify(promoted.body)
      );
      check(
        'and it says how much evidence stayed behind',
        promoted.body?.imagesRemoved === 1,
        JSON.stringify(promoted.body?.imagesRemoved)
      );

      const entry = await Vulnerability.findById(promoted.body.vulnerability);
      const detail = (entry?.details ?? [])[0];
      check(
        'the entry carries the score, priority and category',
        entry?.cvssv3 === 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N' &&
          entry?.priority === 3 &&
          entry?.category === 'Authentication',
        JSON.stringify({ cvss: entry?.cvssv3, priority: entry?.priority, category: entry?.category })
      );
      check(
        'and the reusable text, in the engagement’s own language',
        detail?.locale === 'en' &&
          detail?.title === 'zz-promote Session fixation on the login form' &&
          detail?.remediation.includes('Rotate the session') &&
          (detail?.references ?? []).length === 1,
        JSON.stringify({ locale: detail?.locale, refs: detail?.references })
      );
      check(
        'the screenshot did not travel with it',
        !detail?.description.includes('<img'),
        detail?.description
      );
      check(
        'nor did the proof of concept or the affected hosts — the library has no place for them',
        detail?.poc === undefined && detail?.scope === undefined,
        JSON.stringify(Object.keys(detail?.toObject?.() ?? detail ?? {}))
      );
      check(
        'custom field shapes come across without last client’s values',
        (detail?.customFields ?? []).every((field) => field.value === ''),
        JSON.stringify(detail?.customFields)
      );

      // The finding now points at what it produced, which is the same field the other
      // direction fills in.
      const linked = await call(alice, 'GET', `/audits/${auditId}`);
      const back = (linked.body?.findings ?? []).find((f) => f._id === made.body._id);
      check(
        'the finding records which library entry it produced',
        String(back?.vulnerability) === String(promoted.body.vulnerability),
        JSON.stringify(back?.vulnerability)
      );

      /* ------------------------------------------------- the duplicate guard */
      const again = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${made.body._id}/promote`,
        {}
      );
      check(
        'promoting the same title twice is refused, with the entry attached',
        again.status === 409 && String(again.body?.details?.existing?._id) === String(entry._id),
        JSON.stringify({ status: again.status, body: again.body })
      );

      const replaced = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${made.body._id}/promote`,
        { replace: String(entry._id) }
      );
      check(
        'and updating that entry instead is allowed',
        replaced.status === 200 && replaced.body?.replaced === true,
        JSON.stringify(replaced.body)
      );
      check(
        'without making a second entry',
        (await Vulnerability.countDocuments({ 'details.title': /^zz-promote/ })) === 1,
        'expected exactly one library entry'
      );

      // Another locale is a separate body on the same entry, not a new entry.
      const french = await call(
        alice,
        'POST',
        `/audits/${auditId}/findings/${made.body._id}/promote`,
        { replace: String(entry._id), locale: 'fr' }
      );
      const bilingual = await Vulnerability.findById(entry._id);
      check(
        'a second locale is added beside the first, not instead of it',
        french.status === 200 &&
          (bilingual.details ?? []).length === 2 &&
          (bilingual.details ?? []).some((row) => row.locale === 'en') &&
          (bilingual.details ?? []).some((row) => row.locale === 'fr'),
        JSON.stringify((bilingual.details ?? []).map((row) => row.locale))
      );

      const readonlyUser = await makeUser('promoteread', 'readonly');
      const refused = await call(
        readonlyUser,
        'POST',
        `/audits/${auditId}/findings/${made.body._id}/promote`,
        {}
      );
      check('a read-only account cannot promote', refused.status === 403, `got ${refused.status}`);

      await call(alice, 'DELETE', `/audits/${auditId}/findings/${made.body._id}`);
      await Vulnerability.deleteMany({ 'details.title': /^zz-promote/ });
    }

    /* ------------------------------------------------ duplicating an engagement --- */
    log.info('Duplicating an engagement');
    {
      // Something worth copying, and something that must not be.
      await call(alice, 'PUT', `/audits/${auditId}`, {
        customFields: [{ key: 'classification', label: 'Classification', value: 'CONFIDENTIAL' }],
        sections: [{ field: 'methodology', name: 'Methodology', text: '<p>OWASP WSTG</p>', customFields: [] }],
      });
      const check1 = await call(alice, 'POST', `/audits/${auditId}/checks`, {
        title: 'zz-dup verify session rotation',
        category: 'Authentication',
      });
      await call(alice, 'PUT', `/audits/${auditId}/checks/${check1.body._id}`, {
        done: true,
        result: 'no rotation observed',
      });
      const doomed = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-dup finding with evidence',
        description: '<p>text</p><p><img src="/api/media/6a70c9343bb8776321e44701"/></p>',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      });
      await call(alice, 'PUT', `/audits/${auditId}/findings/${doomed.body._id}`, {
        remediationStatus: 'fixed',
      });

      const copy = await call(alice, 'POST', `/audits/${auditId}/duplicate`, {
        name: 'zz-dup copy of the engagement',
        findings: true,
        notes: true,
      });
      check('an engagement can be duplicated', copy.status === 201, JSON.stringify(copy.body?.error));
      const made = copy.body?.audit;
      check(
        'the copy starts in progress with no dates and no reference',
        made?.state === 'EDIT' && !made?.date_start && !made?.date_end && !made?.reference,
        JSON.stringify({ state: made?.state, start: made?.date_start, ref: made?.reference })
      );
      check(
        'the client, type and template come across',
        String(made?.company?._id ?? made?.company ?? '') !== '' || made?.auditType !== undefined,
        JSON.stringify({ company: made?.company?._id, type: made?.auditType })
      );
      check(
        'whoever pressed the button owns the copy',
        String(made?.creator?._id ?? made?.creator) === String(alice.user._id),
        JSON.stringify(made?.creator?.username)
      );
      check(
        'the checklist comes across, and nothing arrives already ticked',
        (made?.testChecks ?? []).length > 0 &&
          (made?.testChecks ?? []).every((entry) => entry.done === false && !entry.result),
        JSON.stringify((made?.testChecks ?? []).map((entry) => [entry.title, entry.done]))
      );
      check(
        'sections and custom fields come across',
        (made?.sections ?? []).some((entry) => entry.text?.includes('OWASP WSTG')) &&
          (made?.customFields ?? []).some((entry) => entry.key === 'classification'),
        JSON.stringify({ sections: made?.sections?.length, fields: made?.customFields?.length })
      );

      const copiedFinding = (made?.findings ?? []).find((f) => f.title === 'zz-dup finding with evidence');
      const identifiers = (made?.findings ?? []).map((entry) => entry.identifier);
      check(
        'a copied finding is reopened, and the copy numbers its findings from one',
        copiedFinding?.remediationStatus === 'open' &&
          identifiers.join(',') === identifiers.map((_unused, index) => index + 1).join(','),
        JSON.stringify({ identifiers, status: copiedFinding?.remediationStatus })
      );
      check(
        'and arrives without the original’s evidence',
        !copiedFinding?.description?.includes('<img') && copy.body?.imagesRemoved >= 1,
        JSON.stringify({ removed: copy.body?.imagesRemoved })
      );

      // Records of the old job never travel.
      const { Delivery } = await import('../models/delivery.model.js');
      const { TimeEntry } = await import('../models/time-entry.model.js');
      check(
        'no sign-offs, deliveries or hours come with it',
        (made?.approvals ?? []).length === 0 &&
          (await Delivery.countDocuments({ audit: made._id })) === 0 &&
          (await TimeEntry.countDocuments({ audit: made._id })) === 0,
        JSON.stringify({ approvals: made?.approvals?.length })
      );

      const bare = await call(alice, 'POST', `/audits/${auditId}/duplicate`, {
        name: 'zz-dup bare copy',
        scope: false,
        sections: false,
        checks: false,
        customFields: false,
        team: false,
      });
      check(
        'and every part can be left out',
        bare.status === 201 &&
          (bare.body?.audit?.sections ?? []).length === 0 &&
          (bare.body?.audit?.testChecks ?? []).length === 0 &&
          (bare.body?.audit?.collaborators ?? []).length === 0 &&
          (bare.body?.audit?.findings ?? []).length === 0,
        JSON.stringify(bare.body?.copied)
      );

      const log3 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'the original records that it was used as a starting point',
        (log3.body?.entries ?? []).some((entry) => entry.action === 'audit.duplicated'),
        JSON.stringify((log3.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      const stranger2 = await makeUser('dupstranger', 'user');
      const nope = await call(stranger2, 'POST', `/audits/${auditId}/duplicate`, { name: 'zz-dup nope' });
      check('somebody off the engagement cannot copy it', nope.status === 403, `got ${nope.status}`);

      // Tidy up: two copies and the throwaway finding/check on the original.
      await Audit.deleteMany({ name: /^zz-dup/ });
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${doomed.body._id}`);
      await call(alice, 'DELETE', `/audits/${auditId}/checks/${check1.body._id}`);
    }

    /* ------------------------------------------------------ delivery record --- */
    log.info('Delivery record');
    {
      const { Delivery } = await import('../models/delivery.model.js');
      await Delivery.deleteMany({ audit: auditId });

      const HASH_A = 'a'.repeat(64);
      const HASH_B = 'b'.repeat(64);

      const empty = await call(bob, 'GET', `/audits/${auditId}/deliveries`);
      check(
        'an engagement starts with nothing sent',
        empty.status === 200 && (empty.body?.deliveries ?? []).length === 0,
        JSON.stringify(empty.body?.deliveries?.length)
      );
      check(
        'and the first version it suggests is 1.0',
        empty.body?.suggestedVersion === '1.0',
        JSON.stringify(empty.body?.suggestedVersion)
      );

      const first = await call(bob, 'POST', `/audits/${auditId}/deliveries`, {
        version: '1.0',
        sentAt: '2026-08-03T15:30:00.000Z',
        channel: 'email',
        recipients: [{ name: 'Dana Whitfield', email: 'DANA@example.com' }],
        filename: 'Acme v1.0.docx',
        fileHash: HASH_A.toUpperCase(),
        fileSize: 481_234,
        kind: 'docx',
        note: 'draft for technical review',
      });
      check(
        'anybody on the engagement can record a delivery',
        first.status === 201,
        JSON.stringify(first.body?.error ?? first.body)
      );
      check(
        'the hash is stored lower-case, and the address normalised',
        first.body?.fileHash === HASH_A && first.body?.recipients?.[0]?.email === 'dana@example.com',
        JSON.stringify({ hash: first.body?.fileHash, to: first.body?.recipients })
      );
      check(
        'and it records who wrote the record down',
        first.body?.sentBy?.username === bob.user.username,
        JSON.stringify(first.body?.sentBy)
      );

      const badHash = await call(bob, 'POST', `/audits/${auditId}/deliveries`, {
        sentAt: '2026-08-03T15:30:00.000Z',
        fileHash: 'nope',
      });
      check('a hash that is not a SHA-256 is refused', badHash.status === 422, `got ${badHash.status}`);

      const noDate = await call(bob, 'POST', `/audits/${auditId}/deliveries`, { version: '9' });
      check('and a delivery with no moment is refused', noDate.status === 422, `got ${noDate.status}`);

      const second = await call(alice, 'POST', `/audits/${auditId}/deliveries`, {
        version: '1.1',
        sentAt: '2026-08-05T08:00:00.000Z',
        channel: 'portal',
        recipients: [{ name: 'Dana Whitfield', email: 'dana@example.com' }, { email: 'security@example.com' }],
        filename: 'Acme v1.1.docx',
        fileHash: HASH_B,
      });
      check('a second version is a second record', second.status === 201, JSON.stringify(second.body?.error));

      const listed = await call(bob, 'GET', `/audits/${auditId}/deliveries`);
      check(
        'the list is newest first',
        (listed.body?.deliveries ?? []).map((row) => row.version).join(',') === '1.1,1.0',
        JSON.stringify((listed.body?.deliveries ?? []).map((row) => row.version))
      );
      check(
        'and the next suggested version follows the newest',
        listed.body?.suggestedVersion === '1.2',
        JSON.stringify(listed.body?.suggestedVersion)
      );

      /* --------------------------------------------------- in the activity log */
      const log2 = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'a delivery goes in the engagement’s log — unlike hours, it is an event',
        (log2.body?.entries ?? []).some((entry) => entry.action === 'report.delivered'),
        JSON.stringify((log2.body?.entries ?? []).slice(0, 3).map((e) => e.action))
      );

      /* ------------------------------------------------------ in a report data */
      const data = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'a template can print the document-control table',
        data.body?.hasDeliveries === true && (data.body?.deliveries ?? []).length === 2,
        JSON.stringify(data.body?.deliveries?.map((row) => row.version))
      );
      check(
        'oldest first there, because a revision history reads downwards',
        (data.body?.deliveries ?? []).map((row) => row.version).join(',') === '1.0,1.1',
        JSON.stringify(data.body?.deliveries?.map((row) => row.version))
      );
      check(
        'with the recipients on one line and the hash shortened for a table cell',
        data.body?.deliveries?.[1]?.recipientList === 'Dana Whitfield, security@example.com' &&
          data.body?.deliveries?.[1]?.fileHashShort === HASH_B.slice(0, 12),
        JSON.stringify(data.body?.deliveries?.[1])
      );
      check(
        'and the newest as lastDelivery, for a cover page',
        data.body?.lastDelivery?.version === '1.1',
        JSON.stringify(data.body?.lastDelivery?.version)
      );
      check(
        'the date is formatted with the instance pattern, not left raw',
        typeof data.body?.lastDelivery?.date === 'string' &&
          !data.body.lastDelivery.date.includes('T'),
        JSON.stringify(data.body?.lastDelivery?.date)
      );

      /* ------------------------------------------------ the digest on download */
      const download = await fetch(`${base}/audits/${auditId}/report`, {
        headers: { Authorization: `Bearer ${alice.token}` },
      });
      const body = Buffer.from(await download.arrayBuffer());
      const { createHash } = await import('node:crypto');
      check(
        'a generated report carries the digest of exactly the bytes it sent',
        download.headers.get('x-report-sha256') === createHash('sha256').update(body).digest('hex') &&
          Number(download.headers.get('x-report-size')) === body.length,
        JSON.stringify({
          header: download.headers.get('x-report-sha256'),
          size: download.headers.get('x-report-size'),
          actual: body.length,
        })
      );
      check(
        'and says so, so a browser reading it through fetch() can',
        /X-Report-Sha256/i.test(download.headers.get('access-control-expose-headers') ?? ''),
        download.headers.get('access-control-expose-headers')
      );

      /* --------------------------------------------------------- corrections */
      const fixed = await call(bob, 'PUT', `/audits/${auditId}/deliveries/${first.body._id}`, {
        version: '1.0 (draft)',
        note: 'corrected: it was a draft',
      });
      check(
        'a typo can be corrected without losing the record',
        fixed.status === 200 && fixed.body?.version === '1.0 (draft)' && fixed.body?.fileHash === HASH_A,
        JSON.stringify({ version: fixed.body?.version, hash: fixed.body?.fileHash })
      );
      check(
        'and a version nobody can parse is left exactly as written',
        (await call(bob, 'GET', `/audits/${auditId}/deliveries`)).body?.suggestedVersion === '1.2',
        'a lettered version should not stop the numeric suggestion'
      );

      /* -------------------------------------------------------------- removal */
      const bobRemoves = await call(bob, 'DELETE', `/audits/${auditId}/deliveries/${second.body._id}`);
      check(
        'a collaborator cannot delete the evidence that something was sent',
        bobRemoves.status === 403,
        `got ${bobRemoves.status}`
      );
      const aliceRemoves = await call(
        alice,
        'DELETE',
        `/audits/${auditId}/deliveries/${second.body._id}`
      );
      check('the creator can', aliceRemoves.status === 200, JSON.stringify(aliceRemoves.body));
      check(
        'and the removal is in the log too',
        ((await call(alice, 'GET', `/audits/${auditId}/activity`)).body?.entries ?? []).some(
          (entry) => entry.action === 'report.delivery-removed'
        ),
        'no report.delivery-removed entry'
      );

      /* ---------------------------------------------------------------- scope */
      const outsider = await makeUser('delivery', 'user');
      const peek = await call(outsider, 'GET', `/audits/${auditId}/deliveries`);
      check('somebody off the engagement cannot read it', peek.status === 403, `got ${peek.status}`);
      const inject = await call(outsider, 'POST', `/audits/${auditId}/deliveries`, {
        sentAt: '2026-08-05T08:00:00.000Z',
      });
      check('nor record one', inject.status === 403, `got ${inject.status}`);

      await Delivery.deleteMany({ audit: auditId });
    }

    /* ------------------------------------------------- the delivery register -- */
    log.info('Deliverables register');
    {
      const { Delivery: Deliveries2 } = await import('../models/delivery.model.js');
      await Deliveries2.deleteMany({ audit: auditId });

      const HASH_ONE = '1'.repeat(64);
      const HASH_TWO = '2'.repeat(64);

      const first = await call(alice, 'POST', `/audits/${auditId}/deliveries`, {
        version: '1.0',
        sentAt: '2026-05-04T09:00:00.000Z',
        channel: 'email',
        filename: 'zz-register-v1.docx',
        fileHash: HASH_ONE,
        fileSize: 40960,
        kind: 'docx',
        recipients: [{ name: 'Dana Whitfield', email: 'dana@zz-register.invalid' }],
      });
      check('a delivery is recorded', first.status === 201, JSON.stringify(first.body?.error));
      check(
        'and it keeps what the report said at the time, so "changed since" is answerable',
        typeof first.body?.contentFingerprint === 'string' &&
          first.body.contentFingerprint.length > 0,
        JSON.stringify(first.body?.contentFingerprint)
      );

      const register = await call(alice, 'GET', `/deliveries?audit=${auditId}`);
      check(
        'the register lists it with its engagement attached',
        register.status === 200 &&
          register.body?.deliveries?.length === 1 &&
          String(register.body.deliveries[0].audit._id) === String(auditId),
        JSON.stringify(register.body?.deliveries?.[0]?.audit)
      );
      check(
        'the newest delivery for an engagement is marked as the current one',
        register.body.deliveries[0].isLatest === true,
        JSON.stringify(register.body.deliveries[0].isLatest)
      );
      check(
        'and nothing has changed since it went out',
        register.body.deliveries[0].changedSince === false,
        JSON.stringify(register.body.deliveries[0].changedSince)
      );

      /* -------------------------------- editing the report makes it say so ---- */
      const touched = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-register a finding added after delivery',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
      });
      check('a finding is added', touched.status === 201, JSON.stringify(touched.body?.error));

      const afterEdit = await call(alice, 'GET', `/deliveries?audit=${auditId}`);
      check(
        'so the register says the report has changed since the client got it',
        afterEdit.body?.deliveries?.[0]?.changedSince === true &&
          afterEdit.body?.totals?.stale === 1,
        JSON.stringify([
          afterEdit.body?.deliveries?.[0]?.changedSince,
          afterEdit.body?.totals?.stale,
        ])
      );

      /* ----------------------- a row with no fingerprint cannot be judged ----- */
      const legacy = await Deliveries2.create({
        audit: auditId,
        version: '0.9',
        sentAt: new Date('2026-04-01T09:00:00.000Z'),
        filename: 'zz-register-old.docx',
        // No contentFingerprint: exactly how every row written before the field existed looks.
      });
      const withLegacy = await call(alice, 'GET', `/deliveries?audit=${auditId}`);
      const legacyRow = (withLegacy.body?.deliveries ?? []).find(
        (row) => String(row._id) === String(legacy._id)
      );
      check(
        'a delivery recorded without a fingerprint reports as unknown, never as unchanged',
        legacyRow?.changedSince === null && legacyRow?.fingerprintRecorded === false,
        JSON.stringify([legacyRow?.changedSince, legacyRow?.fingerprintRecorded])
      );
      check(
        'and it is counted separately from the ones that really did change',
        withLegacy.body?.totals?.unknown === 1 && withLegacy.body?.totals?.stale === 1,
        JSON.stringify(withLegacy.body?.totals)
      );

      /* ----------------------------------------------- identifying a file ----- */
      const byHash = await call(alice, 'GET', `/deliveries?hash=${HASH_ONE}`);
      check(
        'a digest finds the delivery it belongs to',
        byHash.body?.match?.valid === true &&
          byHash.body?.match?.found === 1 &&
          byHash.body?.deliveries?.[0]?.fileHash === HASH_ONE,
        JSON.stringify(byHash.body?.match)
      );

      const unknownHash = await call(alice, 'GET', `/deliveries?hash=${HASH_TWO}`);
      check(
        'a digest that matches nothing says so rather than looking like an empty filter',
        unknownHash.body?.match?.valid === true && unknownHash.body?.match?.found === 0,
        JSON.stringify(unknownHash.body?.match)
      );

      const notAHash = await call(alice, 'GET', '/deliveries?hash=deadbeef');
      check(
        'and something that is not a SHA-256 is refused rather than matched loosely',
        notAHash.body?.match?.valid === false &&
          (notAHash.body?.match?.reason ?? '').length > 0 &&
          notAHash.body?.deliveries?.length === 0,
        JSON.stringify(notAHash.body?.match)
      );

      // The same file legitimately goes out twice, and each is its own fact.
      await call(alice, 'POST', `/audits/${auditId}/deliveries`, {
        version: '1.0 resent',
        sentAt: '2026-05-06T09:00:00.000Z',
        filename: 'zz-register-v1.docx',
        fileHash: HASH_ONE,
      });
      const twice = await call(alice, 'GET', `/deliveries?hash=${HASH_ONE}`);
      check(
        'one digest can match several deliveries, because the same file can go twice',
        twice.body?.match?.found === 2,
        JSON.stringify(twice.body?.match?.found)
      );

      /* --------------------------------- "current version only" is a filter --- */
      const latest = await call(alice, 'GET', `/deliveries?audit=${auditId}&latestOnly=1`);
      check(
        'only-the-current-version returns one row per engagement',
        latest.body?.deliveries?.length === 1 && latest.body.deliveries[0].isLatest === true,
        JSON.stringify((latest.body?.deliveries ?? []).map((row) => row.version))
      );
      check(
        // Applied in the query, not after paging: as a post-filter the totals would still
        // describe every version, and a page of fifty could come back as one.
        'and the totals describe that selection rather than everything',
        latest.body?.totals?.deliveries === 1,
        JSON.stringify(latest.body?.totals)
      );

      /* ---------------------------------------------------- the other filters - */
      const unhashed = await call(alice, 'GET', `/deliveries?audit=${auditId}&unhashedOnly=1`);
      check(
        'the ones recorded without a digest can be listed on their own',
        (unhashed.body?.deliveries ?? []).length === 1 &&
          unhashed.body.deliveries[0].fileHash === '',
        JSON.stringify((unhashed.body?.deliveries ?? []).map((row) => row.version))
      );

      const searched = await call(alice, 'GET', `/deliveries?audit=${auditId}&q=Whitfield`);
      check(
        'and the search reaches a recipient, not just a version',
        (searched.body?.deliveries ?? []).length === 1 &&
          searched.body.deliveries[0].version === '1.0',
        JSON.stringify((searched.body?.deliveries ?? []).map((row) => row.version))
      );

      const dated = await call(
        alice,
        'GET',
        `/deliveries?audit=${auditId}&from=2026-05-01&to=2026-05-05`
      );
      check(
        'a date range takes the closing day inclusively',
        (dated.body?.deliveries ?? []).length === 1 &&
          dated.body.deliveries[0].version === '1.0',
        JSON.stringify((dated.body?.deliveries ?? []).map((row) => row.version))
      );

      /* ------------------------------------------------------------- paging --- */
      const firstPage = await call(alice, 'GET', `/deliveries?audit=${auditId}&limit=1`);
      check(
        'the register pages, and says there is more',
        firstPage.body?.deliveries?.length === 1 && firstPage.body?.hasMore === true,
        JSON.stringify([firstPage.body?.deliveries?.length, firstPage.body?.hasMore])
      );
      const secondPage = await call(
        alice,
        'GET',
        `/deliveries?audit=${auditId}&limit=1&before=${encodeURIComponent(firstPage.body.nextBefore)}`
      );
      check(
        'and the cursor moves on rather than repeating the same row',
        secondPage.body?.deliveries?.length === 1 &&
          String(secondPage.body.deliveries[0]._id) !==
            String(firstPage.body.deliveries[0]._id),
        JSON.stringify([
          firstPage.body.deliveries[0].version,
          secondPage.body?.deliveries?.[0]?.version,
        ])
      );

      /* -------------------------------------------------------------- scope --- */
      const outsider = await makeUser('register', 'user');
      const theirs = await call(outsider, 'GET', '/deliveries');
      check(
        'somebody on no engagements sees an empty register, not everybody else’s',
        theirs.status === 200 && (theirs.body?.deliveries ?? []).length === 0,
        JSON.stringify(theirs.body?.deliveries?.length)
      );
      const theirHash = await call(outsider, 'GET', `/deliveries?hash=${HASH_ONE}`);
      check(
        'and a digest they should not know about finds nothing for them',
        (theirHash.body?.deliveries ?? []).length === 0 &&
          theirHash.body?.match?.found === 0,
        JSON.stringify(theirHash.body?.match)
      );
      const theirFilters = await call(outsider, 'GET', '/deliveries/filters');
      check(
        'nor does the client filter name clients they cannot reach',
        (theirFilters.body?.clients ?? []).length === 0,
        JSON.stringify(theirFilters.body?.clients)
      );

      await Deliveries2.deleteMany({ audit: auditId });
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${touched.body._id}`);
    }

    /* ---------------------------------------- findings across engagements ---- */
    log.info('Findings across every engagement');
    {
      // Two findings with known vectors, one of them fixed, so every filter can be
      // asserted against something whose severity is not a guess about earlier blocks.
      const crit = await call(alice, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-portfolio critical still open',
        cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      });
      const low = await call(bob, 'POST', `/audits/${auditId}/findings`, {
        title: 'zz-portfolio low already fixed',
        cvssv3: 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N',
      });
      await call(alice, 'PUT', `/audits/${auditId}/findings/${low.body._id}`, {
        remediationStatus: 'fixed',
      });

      const titles = (body) => (body?.findings ?? []).map((row) => row.title);

      const outstanding = await call(alice, 'GET', '/findings');
      check('the list loads', outstanding.status === 200, JSON.stringify(outstanding.body?.error));
      check(
        'not fixed by default: the open one is listed, the fixed one is not',
        titles(outstanding.body).includes('zz-portfolio critical still open') &&
          !titles(outstanding.body).includes('zz-portfolio low already fixed'),
        JSON.stringify(titles(outstanding.body).slice(0, 6))
      );

      const row = (outstanding.body?.findings ?? []).find(
        (entry) => entry.title === 'zz-portfolio critical still open'
      );
      check(
        'a row carries its severity, score and age',
        row?.severity === 'Critical' && row?.score === 9.8 && row?.ageDays === 0,
        JSON.stringify({ severity: row?.severity, score: row?.score, age: row?.ageDays })
      );
      check(
        'and which engagement, client and author it belongs to',
        row?.engagement?.id === String(auditId) &&
          typeof row?.engagement?.company === 'string' &&
          row?.author?.name?.includes('Collab'),
        JSON.stringify({ engagement: row?.engagement?.reference, author: row?.author })
      );
      check(
        'with the label a report would print',
        /^\d+$/.test(String(row?.label).replace(/^\D*/, '')),
        JSON.stringify(row?.label)
      );

      /* --------------------------------------------------------- the filters */
      const fixedOnly = await call(alice, 'GET', '/findings?status=fixed');
      check(
        'the fixed view finds the fixed one',
        titles(fixedOnly.body).includes('zz-portfolio low already fixed') &&
          !titles(fixedOnly.body).includes('zz-portfolio critical still open'),
        JSON.stringify(titles(fixedOnly.body).slice(0, 6))
      );

      const criticals = await call(alice, 'GET', '/findings?severity=Critical');
      check(
        'a severity filter keeps only that severity',
        (criticals.body?.findings ?? []).length > 0 &&
          (criticals.body?.findings ?? []).every((entry) => entry.severity === 'Critical'),
        JSON.stringify((criticals.body?.findings ?? []).map((e) => e.severity))
      );

      const nonsense = await call(alice, 'GET', '/findings?severity=Terrifying');
      check(
        'an unknown severity is ignored rather than returning nothing',
        (nonsense.body?.findings ?? []).length === (outstanding.body?.findings ?? []).length,
        `${(nonsense.body?.findings ?? []).length} vs ${(outstanding.body?.findings ?? []).length}`
      );

      const searched = await call(alice, 'GET', '/findings?q=zz-portfolio%20critical');
      check(
        'search matches a title',
        titles(searched.body).length === 1 &&
          titles(searched.body)[0] === 'zz-portfolio critical still open',
        JSON.stringify(titles(searched.body))
      );

      // Authorship, not team membership: bob wrote the low one, alice the critical.
      const bobsOwn = await call(bob, 'GET', '/findings?mine=1&status=open,retesting,fixed');
      check(
        'mine means what you wrote up',
        titles(bobsOwn.body).includes('zz-portfolio low already fixed') &&
          !titles(bobsOwn.body).includes('zz-portfolio critical still open'),
        JSON.stringify(titles(bobsOwn.body).slice(0, 6))
      );

      /* ----------------------------------------------------------- the facets */
      check(
        'severity facets count everything visible, including the fixed',
        (outstanding.body?.facets?.severity?.Low ?? 0) >= 1 &&
          (outstanding.body?.facets?.severity?.Critical ?? 0) >= 1,
        JSON.stringify(outstanding.body?.facets?.severity)
      );
      check(
        'and an outstanding-only split, since a "not fixed" headline must exclude the fixed',
        (outstanding.body?.facets?.outstanding?.Low ?? 0) <
          (outstanding.body?.facets?.severity?.Low ?? 0) &&
          (outstanding.body?.facets?.outstanding?.Critical ?? 0) >= 1,
        JSON.stringify({
          all: outstanding.body?.facets?.severity,
          open: outstanding.body?.facets?.outstanding,
        })
      );
      check(
        'status facets say what each tab would find',
        (outstanding.body?.facets?.status?.fixed ?? 0) >= 1 &&
          (outstanding.body?.facets?.status?.open ?? 0) >= 1,
        JSON.stringify(outstanding.body?.facets?.status)
      );
      check(
        'and the client list comes back for the picker',
        Array.isArray(outstanding.body?.facets?.clients) &&
          outstanding.body.facets.clients.length >= 1,
        JSON.stringify(outstanding.body?.facets?.clients?.slice(0, 3))
      );

      /* ------------------------------------------------------------- sorting */
      const worstFirst = await call(alice, 'GET', '/findings?sort=severity&status=open,retesting,fixed');
      const order = (worstFirst.body?.findings ?? []).map((entry) => entry.severity);
      const RANK = ['Critical', 'High', 'Medium', 'Low', 'None'];
      check(
        'worst first is actually sorted by severity',
        order.every((entry, index) => index === 0 || RANK.indexOf(order[index - 1]) <= RANK.indexOf(entry)),
        JSON.stringify(order)
      );
      const oldestFirst = await call(alice, 'GET', '/findings?status=open,retesting,fixed');
      const ages = (oldestFirst.body?.findings ?? []).map((entry) => entry.ageDays);
      check(
        'and the default puts the oldest at the top',
        ages.every((age, index) => index === 0 || ages[index - 1] >= age),
        JSON.stringify(ages)
      );

      /* --------------------------------------------------------------- scope */
      const outsider = await makeUser('portfolio', 'user');
      const theirs = await call(outsider, 'GET', '/findings');
      check(
        'somebody on no engagement sees no findings at all',
        theirs.status === 200 &&
          (theirs.body?.findings ?? []).length === 0 &&
          (theirs.body?.facets?.clients ?? []).length === 0,
        JSON.stringify({ rows: theirs.body?.findings?.length, clients: theirs.body?.facets?.clients })
      );

      // Tidy up: later blocks count findings on this engagement.
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${crit.body._id}`);
      await call(alice, 'DELETE', `/audits/${auditId}/findings/${low.body._id}`);
    }

    /* --------------------------------------------- hours against the plan ---- */
    log.info('Time logged');
    {
      const { Booking: Plan } = await import('../models/booking.model.js');
      const { TimeEntry } = await import('../models/time-entry.model.js');
      await TimeEntry.deleteMany({ audit: auditId });
      await Plan.deleteMany({ audit: auditId });

      const logged = await call(bob, 'POST', '/time', {
        audit: auditId,
        day: '2026-09-07',
        hours: 6,
        note: 'authenticated testing',
      });
      check('anyone on the engagement can log their own hours', logged.status === 201, JSON.stringify(logged.body?.error));
      check(
        'the entry comes back with the person and the engagement resolved',
        logged.body?.user?.username === bob.user.username && Boolean(logged.body?.audit?.name),
        JSON.stringify({ user: logged.body?.user?.username, audit: logged.body?.audit?.name })
      );

      // The whole reason for the unique index: a day logged twice is a correction, not a
      // second shift. A timesheet that silently doubles is worse than no timesheet.
      const again = await call(bob, 'POST', '/time', {
        audit: auditId,
        day: '2026-09-07',
        hours: 7.5,
        note: 'and the write-up',
      });
      const afterCorrection = await TimeEntry.find({ audit: auditId, user: bob.user._id });
      check(
        'logging the same day again corrects it rather than adding to it',
        again.status === 201 && afterCorrection.length === 1 && afterCorrection[0].hours === 7.5,
        JSON.stringify(afterCorrection.map((entry) => [entry.day, entry.hours]))
      );

      const eighth = await call(bob, 'POST', '/time', { audit: auditId, day: '2026-09-08', hours: 4 });
      check('a second day is a second entry', eighth.status === 201, JSON.stringify(eighth.body?.error));

      const odd = await call(bob, 'POST', '/time', { audit: auditId, day: '2026-09-09', hours: 1.1 });
      check('hours that are not quarters are refused', odd.status === 422, `got ${odd.status}`);
      const impossible = await call(bob, 'POST', '/time', { audit: auditId, day: '2026-09-09', hours: 25 });
      check('and neither is a 25-hour day', impossible.status === 422, `got ${impossible.status}`);

      const notADay = await call(bob, 'POST', '/time', { audit: auditId, day: '07/09/2026', hours: 1 });
      check('the day has to be a day', notADay.status === 422, `got ${notADay.status}`);

      // The same rules as a booking: off the team is refused, and filling in somebody
      // else's hours is the creator's call.
      const strangerAccount = await makeUser('timestranger', 'user');
      const offTeam = await call(alice, 'POST', '/time', {
        audit: auditId,
        user: strangerAccount.user._id.toString(),
        day: '2026-09-07',
        hours: 2,
      });
      check(
        'time cannot be logged for somebody off the team',
        offTeam.status === 400 && /not on this engagement/i.test(offTeam.body?.error ?? ''),
        `${offTeam.status} ${offTeam.body?.error}`
      );

      const bobLogsAlice = await call(bob, 'POST', '/time', {
        audit: auditId,
        user: alice.user._id.toString(),
        day: '2026-09-07',
        hours: 2,
      });
      check(
        'a collaborator cannot fill in somebody else\u2019s hours',
        bobLogsAlice.status === 403,
        `got ${bobLogsAlice.status}`
      );

      const creatorLogs = await call(alice, 'POST', '/time', {
        audit: auditId,
        user: bob.user._id.toString(),
        day: '2026-09-10',
        hours: 3,
      });
      check('the creator can', creatorLogs.status === 201, JSON.stringify(creatorLogs.body?.error));

      /* ---------------------------------------------------- reading it back --- */
      const windowed = await call(bob, 'GET', '/time?from=2026-09-01&to=2026-09-08');
      check(
        'the window filters by day',
        windowed.status === 200 && (windowed.body?.entries ?? []).length === 2,
        JSON.stringify((windowed.body?.entries ?? []).map((entry) => [entry.day, entry.hours]))
      );
      check(
        'and totals what it returned',
        windowed.body?.totals?.hours === 11.5,
        JSON.stringify(windowed.body?.totals)
      );

      const theirs = await call(strangerAccount, 'GET', '/time');
      check(
        'somebody on no engagements sees no hours',
        theirs.status === 200 && (theirs.body?.entries ?? []).length === 0,
        JSON.stringify(theirs.body?.entries?.length)
      );
      const noPeeking = await call(strangerAccount, 'GET', `/time/audit/${auditId}`);
      check('nor can they read an engagement\u2019s hours', noPeeking.status === 404, `got ${noPeeking.status}`);

      /* --------------------------------------------- planned against actual --- */
      // Three booked days against 14.5 logged hours: the comparison the feature exists for.
      await Plan.insertMany([
        { audit: auditId, user: bob.user._id, start: '2026-09-07', end: '2026-09-09' },
      ]);
      const perAudit = await call(bob, 'GET', `/time/audit/${auditId}`);
      check(
        'an engagement totals its hours',
        perAudit.status === 200 && perAudit.body?.totals?.hours === 14.5,
        JSON.stringify(perAudit.body?.totals)
      );
      check(
        'and expresses them as person-days at eight hours to the day',
        perAudit.body?.totals?.days === 1.81 && perAudit.body?.hoursPerDay === 8,
        JSON.stringify(perAudit.body?.totals)
      );
      check(
        'the plan is beside it, counted as distinct days',
        perAudit.body?.totals?.bookedDays === 3,
        JSON.stringify(perAudit.body?.totals)
      );
      check(
        'the first and last day of the work are reported',
        perAudit.body?.totals?.firstDay === '2026-09-07' &&
          perAudit.body?.totals?.lastDay === '2026-09-10',
        JSON.stringify(perAudit.body?.totals)
      );
      const bobsRow = (perAudit.body?.people ?? []).find(
        (person) => person.user?.username === bob.user.username
      );
      check(
        'and per person: hours, days touched, days booked',
        bobsRow?.hours === 14.5 && bobsRow?.days === 3 && bobsRow?.bookedDays === 3,
        JSON.stringify(bobsRow)
      );

      /* ------------------------------------------------ in the report data --- */
      const withEffort = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'the report can print what the engagement took',
        withEffort.body?.hasEffort === true && withEffort.body?.effort?.hours === 14.5,
        JSON.stringify(withEffort.body?.effort)
      );
      check(
        'as person-days, which is what clients are quoted in',
        withEffort.body?.effort?.days === 1.81,
        JSON.stringify(withEffort.body?.effort?.days)
      );
      check(
        'with a row per person for a table',
        (withEffort.body?.effort?.people ?? []).length === 1 &&
          withEffort.body.effort.people[0].hours === 14.5,
        JSON.stringify(withEffort.body?.effort?.people)
      );

      /* ------------------------------------------------------ on the Team page */
      /*
       * Utilisation looks *backwards* from today, so the fixed dates above sit outside
       * every window it offers. Three recent days, deliberately totalling something other
       * than the 12.5 h logged above, so a leak between the two would be visible.
       */
      const recent = (offset) =>
        new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
      await Plan.insertMany([
        { audit: auditId, user: bob.user._id, start: recent(-3), end: recent(-1) },
      ]);
      for (const [offset, amount] of [[-3, 6], [-2, 4.5], [-1, 2]]) {
        await call(bob, 'POST', '/time', { audit: auditId, day: recent(offset), hours: amount });
      }

      const teamHours = await call(alice, 'GET', '/users/engagements?days=30');
      const bobsTeamRow = (teamHours.body?.users ?? []).find(
        (entry) => entry.username === bob.user.username
      );
      check(
        'the Team page shows the hours beside the bookings',
        bobsTeamRow?.logged?.hours === 12.5 && bobsTeamRow?.booked?.days === 3,
        JSON.stringify({ logged: bobsTeamRow?.logged, booked: bobsTeamRow?.booked })
      );
      check(
        'an entry outside the window stays outside it',
        bobsTeamRow?.logged?.days === 3,
        JSON.stringify(bobsTeamRow?.logged)
      );
      check(
        'and the rate that says whether the estimate held',
        bobsTeamRow?.logged?.hoursPerBookedDay === 4.2 && bobsTeamRow?.logged?.effortDays === 1.6,
        JSON.stringify(bobsTeamRow?.logged)
      );
      const idle = (teamHours.body?.users ?? []).find(
        (entry) => entry.username === strangerAccount.user.username
      );
      check(
        'somebody with no bookings has no rate rather than a rate of zero',
        idle?.logged?.hours === 0 && idle?.logged?.hoursPerBookedDay === null,
        JSON.stringify(idle?.logged)
      );
      check(
        'hours per engagement reach the row that expands',
        (bobsTeamRow?.engagements ?? []).some((entry) => entry.loggedHours === 12.5),
        JSON.stringify(bobsTeamRow?.engagements?.map((e) => [e.reference, e.loggedHours]))
      );
      check(
        'and the engagement itself carries what it has taken',
        (teamHours.body?.engagements ?? []).some((entry) => entry.loggedHours === 12.5),
        JSON.stringify(teamHours.body?.engagements?.map((e) => [e.reference, e.loggedHours]))
      );
      for (const offset of [-3, -2, -1]) {
        await call(bob, 'POST', '/time', { audit: auditId, day: recent(offset), hours: 0 });
      }

      /* ------------------------------------------------------------ removing --- */
      const removedOwn = await call(bob, 'DELETE', `/time/${logged.body._id}`);
      check('you can remove your own entry', removedOwn.status === 200, JSON.stringify(removedOwn.body));

      const zeroed = await call(bob, 'POST', '/time', { audit: auditId, day: '2026-09-08', hours: 0 });
      const left = await TimeEntry.countDocuments({ audit: auditId });
      check(
        'and logging zero hours deletes the day',
        zeroed.status === 200 && zeroed.body?.removed === true && left === 1,
        JSON.stringify({ status: zeroed.status, body: zeroed.body, left })
      );

      await TimeEntry.deleteMany({ audit: auditId });
      const empty = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'an engagement nobody logged time on prints nothing rather than zero days',
        empty.body?.hasEffort === false && empty.body?.effort?.hours === 0,
        JSON.stringify(empty.body?.effort)
      );

      await Plan.deleteMany({ audit: auditId });
    }

    /* ------------------------------------------- library bundles ------------- */
    log.info('Library export and import');
    {
      const { Vulnerability } = await import('../models/vulnerability.model.js');

      const bundle = await call(alice, 'GET', '/vulnerabilities/export');
      check(
        'the library exports as a bundle',
        bundle.status === 200 &&
          bundle.body?.format === 'engy-vulnerability-library' &&
          Array.isArray(bundle.body?.entries),
        JSON.stringify({ status: bundle.status, format: bundle.body?.format })
      );
      check(
        'ids and authorship stay behind',
        (bundle.body.entries ?? []).every((entry) => !entry._id && !entry.createdBy),
        'an instance-specific field was exported'
      );

      const before = await Vulnerability.countDocuments();
      const again = await call(alice, 'POST', '/vulnerabilities/import', bundle.body);
      check(
        're-importing the same bundle changes nothing',
        again.body?.added === 0 && again.body?.skipped === bundle.body.count,
        JSON.stringify(again.body)
      );
      check(
        'so the library is not duplicated',
        (await Vulnerability.countDocuments()) === before,
        `${before} → ${await Vulnerability.countDocuments()}`
      );

      const fresh = {
        format: 'engy-vulnerability-library',
        version: 1,
        entries: [
          {
            cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
            category: 'zz Bundle probe',
            details: [
              {
                locale: 'en',
                title: 'zz Entry from a bundle',
                description: '<p>with <img src="/api/media/aaaaaaaaaaaaaaaaaaaaaaaa"> evidence</p>',
              },
            ],
          },
        ],
      };
      const added = await call(alice, 'POST', '/vulnerabilities/import', fresh);
      check('a new entry is added', added.body?.added === 1, JSON.stringify(added.body));
      check(
        'and screenshots it cannot carry are reported rather than hidden',
        added.body?.danglingScreenshots === 1,
        JSON.stringify(added.body?.danglingScreenshots)
      );

      const updated = await call(alice, 'POST', '/vulnerabilities/import', {
        ...fresh,
        mode: 'update',
      });
      check(
        'update mode overwrites instead of duplicating',
        updated.body?.updated === 1 && updated.body?.added === 0,
        JSON.stringify(updated.body)
      );

      const wrong = await call(alice, 'POST', '/vulnerabilities/import', {
        format: 'somebody-elses-format',
        entries: fresh.entries,
      });
      check('a file from another tool is refused', wrong.status === 400, `got ${wrong.status}`);
      const newer = await call(alice, 'POST', '/vulnerabilities/import', { ...fresh, version: 99 });
      check('so is a bundle from a newer version', newer.status === 400, `got ${newer.status}`);

      await Vulnerability.deleteMany({ category: 'zz Bundle probe' });
    }

    /* --------------------------------------------- credential vault ---------- */
    log.info('Credential vault');
    {
      const { Credential } = await import('../models/credential.model.js');
      const crypto = await import('node:crypto');
      const keyBefore = process.env.VAULT_KEY;

      // With no key the vault must explain itself rather than store anything, and it must
      // certainly not fall back to plaintext under a reassuring label.
      delete process.env.VAULT_KEY;
      const off = await call(alice, 'GET', `/audits/${auditId}/credentials`);
      check(
        'with no key the vault is off and says why',
        off.body?.enabled === false && /VAULT_KEY/.test(off.body?.disabledReason ?? ''),
        JSON.stringify(off.body)
      );
      const refused = await call(alice, 'POST', `/audits/${auditId}/credentials`, {
        label: 'zz nope',
        secret: 'hunter2',
      });
      check(
        'and refuses to store anything',
        refused.status === 400 && /VAULT_KEY/.test(refused.body?.error ?? ''),
        `${refused.status} ${refused.body?.error}`
      );

      process.env.VAULT_KEY = crypto.default.randomBytes(32).toString('hex');
      const SECRET = 'correct-horse-battery-staple';

      const stored = await call(alice, 'POST', `/audits/${auditId}/credentials`, {
        label: 'zz Staging VPN',
        username: 'pentest01',
        secret: SECRET,
        notes: 'provided by the client',
      });
      check('a credential can be stored', stored.status === 201, JSON.stringify(stored.body?.error));
      check(
        'and the response never carries the secret back',
        !JSON.stringify(stored.body).includes(SECRET),
        'the secret came back in the create response'
      );

      const row = await Credential.findById(stored.body._id).lean();
      check(
        'what is written to the database is ciphertext',
        !JSON.stringify(row).includes(SECRET) && Boolean(row.secret?.iv && row.secret?.tag),
        'the plaintext reached the database'
      );

      const listed = await call(bob, 'GET', `/audits/${auditId}/credentials`);
      check(
        'the team can see that it exists',
        listed.body?.credentials?.some((entry) => entry.label === 'zz Staging VPN'),
        JSON.stringify(listed.body?.credentials?.map((c) => c.label))
      );
      check(
        'without the list handing out secrets',
        !JSON.stringify(listed.body).includes(SECRET),
        'the list leaked the secret'
      );

      const revealed = await call(
        bob,
        'POST',
        `/audits/${auditId}/credentials/${stored.body._id}/reveal`,
        {}
      );
      check('revealing returns it', revealed.body?.secret === SECRET, JSON.stringify(revealed.body));
      const afterReveal = await call(alice, 'GET', `/audits/${auditId}/credentials`);
      const trail = afterReveal.body.credentials.find((c) => c._id === stored.body._id);
      check(
        'and leaves a trail saying who looked',
        trail?.reveals === 1 && trail?.lastRevealedBy?.username === bob.user.username,
        JSON.stringify({ reveals: trail?.reveals, by: trail?.lastRevealedBy?.username })
      );
      const vaultLog = await call(alice, 'GET', `/audits/${auditId}/activity`);
      check(
        'in the engagement log as well',
        (vaultLog.body?.entries ?? []).some((entry) => entry.action === 'credential.revealed'),
        JSON.stringify(vaultLog.body?.entries?.slice(0, 3).map((e) => e.action))
      );

      // A secret must be invisible to everything that reads an engagement — which is why
      // it lives in its own collection rather than on the audit.
      const auditBody = await call(alice, 'GET', `/audits/${auditId}`);
      const reportBody = await call(alice, 'GET', `/audits/${auditId}/report-data`);
      check(
        'no part of the engagement or the report can see it',
        !JSON.stringify(auditBody.body).includes(SECRET) &&
          !JSON.stringify(reportBody.body).includes(SECRET) &&
          !JSON.stringify(auditBody.body).includes('zz Staging VPN'),
        'a credential reached the engagement payload'
      );

      const renamed = await call(alice, 'PUT', `/audits/${auditId}/credentials/${stored.body._id}`, {
        label: 'zz Staging VPN (renamed)',
      });
      check('the label can change', renamed.body?.label === 'zz Staging VPN (renamed)');
      const stillThere = await call(
        alice,
        'POST',
        `/audits/${auditId}/credentials/${stored.body._id}/reveal`,
        {}
      );
      check(
        'without having to retype the secret',
        stillThere.body?.secret === SECRET,
        'editing a label lost the secret'
      );

      // A changed key must fail loudly rather than return something plausible.
      process.env.VAULT_KEY = crypto.default.randomBytes(32).toString('hex');
      const wrongKey = await call(
        alice,
        'POST',
        `/audits/${auditId}/credentials/${stored.body._id}/reveal`,
        {}
      );
      check(
        'a different key cannot read it, and says so',
        wrongKey.status === 400 && /VAULT_KEY/.test(wrongKey.body?.error ?? ''),
        `${wrongKey.status} ${wrongKey.body?.error}`
      );

      const purged = await call(alice, 'DELETE', `/audits/${auditId}/credentials`);
      check('purging removes everything', purged.body?.removed >= 1, JSON.stringify(purged.body));
      check(
        'and the collection is empty for this engagement',
        (await Credential.countDocuments({ audit: auditId })) === 0
      );

      if (keyBefore === undefined) delete process.env.VAULT_KEY;
      else process.env.VAULT_KEY = keyBefore;
    }

    /* ------------------------------------------- testing a template ---------- */
    log.info('Template test render');
    {
      const { Template: Templates } = await import('../models/template.model.js');

      // An HTML template can be created through the API, so this exercises the real
      // route rather than the service — including a deliberate misspelling, a tag used
      // outside the loop it belongs to, and a loop the sample leaves empty.
      const made = await call(alice, 'POST', '/templates/html', {
        name: 'zz Test render probe',
        html:
          '<h1>{{ name }}</h1><p>{{ compnay.name }} {{ stats.nonsense }}</p>' +
          '<p>{{ title }}</p>' +
          '<div>{{#findings}}<h2>{{ id }} {{ title }}</h2>{{@rich.description}}{{/findings}}</div>' +
          '<p>{{#approvals}}{{ fullname }} on {{ signedOn }}{{/approvals}}</p>',
      });
      check('an HTML template can be created', made.status === 201, JSON.stringify(made.body?.error));

      /*
       * The same analysis, run at write time rather than on request.
       *
       * A misspelled tag renders as a gap rather than an error, so the moment to say so is while
       * the person who wrote it is still looking at it — not the first time somebody remembers
       * to press "test render".
       */
      const lintOnCreate = made.body?.lint;
      check(
        'creating a template analyses its tags there and then',
        Boolean(lintOnCreate?.at) && lintOnCreate.counts.total > 0,
        JSON.stringify(lintOnCreate?.counts)
      );
      check(
        'and stores the unrecognised ones with the loop they sit in',
        (lintOnCreate?.unknown ?? []).some((entry) => entry.tag === 'compnay.name') &&
          (lintOnCreate?.unknown ?? []).some((entry) => entry.tag === 'stats.nonsense'),
        JSON.stringify(lintOnCreate?.unknown)
      );
      check(
        'a tag that only makes sense inside a loop is not called a typo',
        !(lintOnCreate?.unknown ?? []).some((entry) => entry.tag === 'signedOn'),
        JSON.stringify(lintOnCreate?.unknown)
      );
      check(
        'and nothing that resolves is stored, so the list is a warning rather than noise',
        (lintOnCreate?.unknown ?? []).every((entry) => entry.tag !== 'name'),
        JSON.stringify(lintOnCreate?.unknown)
      );

      // Fixing the spelling clears it, which is the whole point of storing it on the template.
      const fixed = await call(alice, 'PUT', `/templates/${made.body._id}/html`, {
        html: '<h1>{{ name }}</h1><p>{{ company.name }}</p>',
      });
      check(
        'correcting the markup re-analyses it',
        (fixed.body?.lint?.unknown ?? []).length === 0 && fixed.body?.lint?.counts?.total === 2,
        JSON.stringify(fixed.body?.lint)
      );

      const listed = await call(alice, 'GET', '/templates');
      check(
        'and the stored result travels with the list, so no page re-analyses anything',
        Boolean(
          (listed.body ?? []).find((row) => row._id === made.body._id)?.lint?.at
        ),
        'the list has no lint result'
      );

      // Put the deliberate mistakes back for the test render checks below.
      await call(alice, 'PUT', `/templates/${made.body._id}/html`, {
        html:
          '<h1>{{ name }}</h1><p>{{ compnay.name }} {{ stats.nonsense }}</p>' +
          '<p>{{ title }}</p>' +
          '<div>{{#findings}}<h2>{{ id }} {{ title }}</h2>{{@rich.description}}{{/findings}}</div>' +
          '<p>{{#approvals}}{{ fullname }} on {{ signedOn }}{{/approvals}}</p>',
      });

      const report = await call(alice, 'POST', `/templates/${made.body._id}/test`, {});
      check('the test render runs', report.status === 200 && report.body?.ok === true, JSON.stringify(report.body?.error));

      const statusOf = (tag, where = '') =>
        (report.body?.tags ?? []).find((entry) => entry.tag === tag && (entry.where ?? '') === where)
          ?.status;

      check(
        'a misspelled tag is called out',
        statusOf('compnay.name') === 'unknown',
        JSON.stringify(report.body?.tags?.filter((t) => t.status === 'unknown'))
      );
      check(
        'and so is a misspelled leaf under a real one',
        statusOf('stats.nonsense') === 'unknown',
        `stats.nonsense was ${statusOf('stats.nonsense')}`
      );
      check(
        'a tag inside its loop resolves',
        statusOf('id', 'findings') === 'ok' && statusOf('title', 'findings') === 'ok',
        JSON.stringify(report.body?.tags?.filter((t) => t.where === 'findings'))
      );
      check(
        'a loop the sample leaves empty is reported as empty, not as a typo',
        statusOf('signedOn', 'approvals') === 'empty',
        `signedOn was ${statusOf('signedOn', 'approvals')}`
      );
      check(
        'the counts add up',
        report.body.counts.ok + report.body.counts.empty + report.body.counts.unknown ===
          report.body.counts.total,
        JSON.stringify(report.body?.counts)
      );
      check(
        'an HTML template has no .docx to download',
        report.body?.downloadable === false,
        JSON.stringify(report.body?.downloadable)
      );

      // The .docx path, against whatever template this instance actually has.
      const anyDocx = await Templates.findOne({ kind: 'docx' });
      if (anyDocx) {
        const docxReport = await call(alice, 'POST', `/templates/${anyDocx._id}/test`, {});
        check(
          'a Word template renders against the sample',
          docxReport.body?.ok === true && docxReport.body?.size > 0,
          JSON.stringify({ ok: docxReport.body?.ok, error: docxReport.body?.error })
        );
        check(
          'and offers the document itself',
          docxReport.body?.downloadable === true,
          JSON.stringify(docxReport.body?.downloadable)
        );

        const file = await fetch(`${base}/templates/${anyDocx._id}/test-render`, {
          headers: { Authorization: `Bearer ${alice.token}` },
        });
        const bytes = Buffer.from(await file.arrayBuffer());
        check(
          'the download is a real .docx',
          file.status === 200 && bytes.subarray(0, 2).toString() === 'PK' && bytes.length > 5000,
          `${file.status}, ${bytes.length} bytes`
        );
        check(
          'named after the template',
          (file.headers.get('content-disposition') ?? '').includes('Sample%20report'),
          file.headers.get('content-disposition')
        );
      }

      await Templates.deleteOne({ _id: made.body._id });
    }

    /* ----------------------------------------------------------- sessions --- */
    log.info('Sessions');
    const { Session } = await import('../models/session.model.js');

    // A real sign-in, twice, because the whole point is telling two browsers apart —
    // so this part of the suite cannot use a minted token like the rest.
    const signIn = async (agent, password = 'collab-test-password') => {
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': agent },
        body: JSON.stringify({ username: bob.user.username, password }),
      });
      const payload = await response.json().catch(() => null);
      // Both cookies, so the media path can be exercised the way a browser does it.
      const cookie = (response.headers.getSetCookie?.() ?? [])
        .map((entry) => entry.split(';')[0])
        .join('; ');
      return { status: response.status, body: payload, cookie, agent };
    };

    const asBrowser = async (browser, method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${browser.body?.accessToken ?? ''}`,
          Cookie: browser.cookie,
          'User-Agent': browser.agent,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    };

    const laptop = await signIn('zz-test Chrome/9 (Windows NT 10.0)');
    const phone = await signIn('zz-test Safari/9 (iPhone; Mobile)');
    check(
      'signing in twice opens two sessions',
      laptop.status === 200 && phone.status === 200 && Boolean(laptop.cookie && phone.cookie),
      `${laptop.status}/${phone.status}`
    );

    const listed = await asBrowser(laptop, 'GET', '/auth/sessions');
    check(
      'both are listed',
      listed.body?.sessions?.length === 2,
      JSON.stringify(listed.body?.sessions?.map((entry) => entry.userAgent))
    );
    check(
      'exactly one is marked as this browser, and it is the right one',
      listed.body?.sessions?.filter((entry) => entry.current).length === 1 &&
        listed.body.sessions.find((entry) => entry.current)?.userAgent.includes('Windows'),
      JSON.stringify(listed.body?.sessions?.map((entry) => [entry.current, entry.userAgent]))
    );
    check(
      'the session id itself is never published',
      listed.body.sessions.every((entry) => entry.sid === undefined),
      'a sid reached the client'
    );

    /*
     * A signed-out session must lose evidence too: the media cookie lasts as long as
     * the refresh token, so without a session check it would outlive the sign-out by
     * days.
     *
     * Cookie only, no Authorization header — which is exactly what an <img> tag sends,
     * and the reason the cookie exists at all. Same URL every time, so 404 means
     * authorised but no such image and 401 means refused.
     */
    const media = async (browser) => {
      const response = await fetch(`${base}/media/000000000000000000000000`, {
        headers: { Cookie: browser.cookie },
      });
      return response.status;
    };

    check('a live session reaches the media route', (await media(phone)) === 404, 'cookie refused');

    const others = await asBrowser(laptop, 'POST', '/auth/sessions/revoke-others', {});
    check('signing the others out ends one', others.body?.revoked === 1, JSON.stringify(others.body));

    const afterRevoke = await asBrowser(laptop, 'GET', '/auth/sessions');
    check(
      'and it leaves the list',
      afterRevoke.body?.sessions?.length === 1 && afterRevoke.body.sessions[0].current === true,
      JSON.stringify(afterRevoke.body?.sessions?.length)
    );

    const deadRefresh = await asBrowser(phone, 'POST', '/auth/refresh', {});
    check(
      'the signed-out browser cannot refresh',
      deadRefresh.status === 401,
      `got ${deadRefresh.status}: ${JSON.stringify(deadRefresh.body)}`
    );
    const deadMedia = await media(phone);
    check(
      'nor read evidence with the cookie it still holds',
      deadMedia === 401,
      `got ${deadMedia}`
    );
    // The access token it was given before being signed out is stateless and stays
    // valid until it expires. That is the documented trade, so it is asserted rather
    // than left as a surprise: the session dies at the next refresh, up to 30 minutes.
    const tokenStillWorks = await asBrowser(phone, 'GET', '/media/000000000000000000000000');
    check(
      'though the access token it already held lasts until it expires',
      tokenStillWorks.status === 404,
      `got ${tokenStillWorks.status}`
    );

    const stillMine = await asBrowser(laptop, 'POST', '/auth/refresh', {});
    check('while this browser refreshes fine', stillMine.status === 200, `got ${stillMine.status}`);
    const afterRefresh = await asBrowser(laptop, 'GET', '/auth/sessions');
    check(
      'and refreshing reuses the session rather than opening another',
      afterRefresh.body?.sessions?.length === 1,
      JSON.stringify(afterRefresh.body?.sessions?.length)
    );

    const wrongPassword = await signIn('zz-test Firefox/9 (X11; Linux)', 'not-the-password');
    check('a wrong password is refused', wrongPassword.status === 401, `got ${wrongPassword.status}`);
    const withFailures = await asBrowser(laptop, 'GET', '/auth/sessions');
    check(
      'and recorded for the account owner to see',
      withFailures.body?.failedLogins?.[0]?.reason === 'password' &&
        withFailures.body.failedLogins[0].userAgent.includes('Firefox'),
      JSON.stringify(withFailures.body?.failedLogins)
    );
    check(
      'a refused attempt opens no session',
      withFailures.body?.sessions?.length === 1,
      JSON.stringify(withFailures.body?.sessions?.length)
    );

    await asBrowser(laptop, 'DELETE', '/auth/failed-logins');
    const cleared = await asBrowser(laptop, 'GET', '/auth/sessions');
    check(
      'the owner can clear the list once read',
      (cleared.body?.failedLogins ?? []).length === 0,
      JSON.stringify(cleared.body?.failedLogins)
    );

    // Signing out ends the row, rather than only dropping the cookies and leaving the
    // session listed as live on every other device.
    await asBrowser(laptop, 'POST', '/auth/logout', {});
    const live = await Session.countDocuments({ user: bob.user._id, revokedAt: null });
    check('signing out ends the session row', live === 0, `${live} still live`);

    /* ------------------------------------------------ letting somebody in ---- */
    log.info('Account approval');
    {
      const { generateCode } = await import('../services/totp.js');

      // Registration and sign-in are done as a browser does them: the whole feature is
      // about what comes back instead of a session, so a minted token would test nothing.
      const anon = async (method, path, body) => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        const cookies = response.headers.getSetCookie?.() ?? [];
        return { status: response.status, body: parsed, cookies };
      };

      const newcomer = 'zz-collab-newcomer';
      await User.deleteOne({ username: newcomer });

      const signedUp = await anon('POST', '/auth/register', {
        username: newcomer,
        email: `${newcomer}@example.invalid`,
        password: 'newcomer-test-password',
        firstname: 'New',
        lastname: 'Comer',
      });
      check(
        'anybody can register, and is told approval is coming',
        signedUp.status === 201 &&
          signedUp.body?.enrolmentRequired === true &&
          signedUp.body?.approvalRequired === true,
        JSON.stringify([signedUp.status, signedUp.body?.approvalRequired])
      );
      check(
        // The gate is the session, so the absence of one is the thing worth asserting.
        'and gets no session out of it',
        !signedUp.cookies.some((entry) => entry.startsWith('engy_refresh=')),
        JSON.stringify(signedUp.cookies.map((entry) => entry.split('=')[0]))
      );

      /* ------------------------------- enrolment is theirs to do, and it works - */
      const pending = await User.findOne({ username: newcomer }).select('+totpSecret');
      const enrolled = await anon('POST', '/auth/register/verify', {
        enrolmentToken: signedUp.body.enrolmentToken,
        code: generateCode(pending.totpSecret),
      });
      check(
        'they can still pair an authenticator while they wait',
        enrolled.status === 200 && enrolled.body?.approvalRequired === true,
        JSON.stringify([enrolled.status, enrolled.body])
      );
      check(
        'the pairing is kept rather than thrown away',
        Boolean((await User.findOne({ username: newcomer })).totpEnabled),
        'two-factor was not left enabled'
      );
      check(
        'and finishing it still does not sign them in',
        !enrolled.cookies.some((entry) => entry.startsWith('engy_refresh=')),
        JSON.stringify(enrolled.cookies.map((entry) => entry.split('=')[0]))
      );

      /* ------------------------------------------- the right password is not enough */
      const tooSoon = await anon('POST', '/auth/login', {
        username: newcomer,
        password: 'newcomer-test-password',
      });
      check(
        'the right password answers "waiting", not a code prompt',
        tooSoon.status === 200 &&
          tooSoon.body?.approvalRequired === true &&
          !tooSoon.body?.mfaRequired,
        JSON.stringify(tooSoon.body)
      );

      const waiting = await User.findOne({ username: newcomer });
      const asWaiting = { user: waiting, token: signAccessToken(waiting) };
      const refused = await call(asWaiting, 'GET', '/audits');
      check(
        // Belt and braces: even a token minted around the login route reaches nothing.
        'a token for an unapproved account opens nothing',
        refused.status === 401,
        `got ${refused.status}`
      );

      /* -------------------------------------------------- the admins are told -- */
      check(
        'the admins are notified that somebody is waiting',
        (await Notification.countDocuments({
          user: alice.user._id,
          type: 'account-awaiting-approval',
          actor: waiting._id,
        })) === 1,
        'no account-awaiting-approval notification'
      );

      const queue = await call(alice, 'GET', '/users/pending');
      const row = (queue.body?.waiting ?? []).find((entry) => entry.username === newcomer);
      check(
        'they are in the queue, with whether they paired an app',
        queue.status === 200 && row?.twoFactorReady === true,
        JSON.stringify(queue.body?.waiting?.map((entry) => entry.username))
      );
      check(
        // A list of people who have proved a password and nothing else.
        'the queue is not readable by everybody',
        (await call(bob, 'GET', '/users/pending')).status === 403,
        'a non-admin could read the approval queue'
      );

      const pickable = await call(alice, 'GET', '/users?active=true');
      check(
        'and they are not offered as somebody to give work to',
        !(pickable.body ?? []).some((entry) => entry.username === newcomer),
        'an unapproved account was in the pickable list'
      );

      /* ------------------------------------------------------------- let in --- */
      const letIn = await call(alice, 'POST', `/users/${waiting._id}/approval`, { approved: true });
      check(
        'an admin can let them in',
        letIn.status === 200 && letIn.body?.awaitingApproval === false,
        JSON.stringify([letIn.status, letIn.body?.awaitingApproval])
      );
      check(
        'and they are told who did it',
        (await Notification.countDocuments({
          user: waiting._id,
          type: 'account-approved',
        })) === 1,
        'no account-approved notification'
      );

      const nowAsked = await anon('POST', '/auth/login', {
        username: newcomer,
        password: 'newcomer-test-password',
      });
      check(
        'now the password gets them a code prompt like anybody else',
        nowAsked.body?.mfaRequired === true && !nowAsked.body?.approvalRequired,
        JSON.stringify(nowAsked.body)
      );
      const approvedUser = await User.findOne({ username: newcomer });
      check(
        'and a token for them works',
        (await call({ token: signAccessToken(approvedUser) }, 'GET', '/audits')).status === 200,
        'an approved account still could not read anything'
      );

      /* --------------------------------------------------- and taken back ----- */
      const before = approvedUser.tokenVersion;
      const withdrawn = await call(alice, 'POST', `/users/${waiting._id}/approval`, {
        approved: false,
      });
      const after = await User.findOne({ username: newcomer });
      check(
        'approval can be withdrawn, which ends the sessions they hold',
        withdrawn.status === 200 && !after.approvedAt && after.tokenVersion === before + 1,
        JSON.stringify([withdrawn.status, after.approvedAt, after.tokenVersion, before])
      );
      check(
        'nobody can lock themselves out of the instance they run',
        (await call(alice, 'POST', `/users/${alice.user._id}/approval`, { approved: false }))
          .status === 400,
        'an admin withdrew their own approval'
      );

      /* ------------------------- an admin typing it in is the approval itself -- */
      const made = await call(alice, 'POST', '/users', {
        username: 'zz-collab-hired',
        email: 'zz-collab-hired@example.invalid',
        password: 'hired-test-password',
        role: 'user',
      });
      check(
        'an account an admin creates does not queue for that same admin',
        made.status === 201 && made.body?.awaitingApproval === false,
        JSON.stringify([made.status, made.body?.awaitingApproval])
      );

      /* ------------------------------ accounts that predate all of this ------- */
      const { backfillApprovals } = await import('../services/account-approval.service.js');
      await User.collection.updateOne({ username: newcomer }, { $unset: { approvedAt: '' } });
      check(
        'an account from before this feature is treated as already approved',
        (await backfillApprovals()) === 1 &&
          Boolean((await User.findOne({ username: newcomer })).approvedAt),
        'the backfill did not approve a field-less account'
      );
      check('running the backfill again does nothing', (await backfillApprovals()) === 0);

      await Notification.deleteMany({ user: { $in: [alice.user._id, waiting._id] } });
    }

    /* ----------------------------------------------------- the sales wall ----- */
    log.info('Sales section');
    {
      const money = await makeUser('sales', 'sales');

      /*
       * The whole point of the role, so it is checked against the actual routers rather
       * than against the middleware in isolation: every one of these is a different
       * mount, and an allowlist that missed one would let this pass anyway.
       */
      const walled = [
        '/dashboard',
        '/audits',
        `/audits/${auditId}`,
        '/findings',
        '/users',
        '/users/skills',
        '/insights',
        '/schedule',
        '/deliveries',
        '/vulnerabilities',
        '/templates',
        '/settings',
        '/data/companies',
        '/inbox',
        '/search?q=a',
        '/setup',
      ];
      const answers = [];
      for (const path of walled) answers.push([path, (await call(money, 'GET', path)).status]);
      check(
        'a sales account is refused everything about the work',
        answers.every(([, status]) => status === 403),
        JSON.stringify(answers.filter(([, status]) => status !== 403))
      );

      const own = await call(money, 'GET', '/sales/dashboard');
      check(
        'and can open the Sales section',
        own.status === 200 && own.body?.ready === true,
        JSON.stringify([own.status, own.body?.ready])
      );
      check(
        // The pipeline, counted. Not money: there are no prices anywhere in this app, and a
        // currency card invented to fill the space would be a number nobody could trust.
        'which shows them the pipeline rather than nothing',
        typeof own.body?.summary?.open === 'number' &&
          Array.isArray(own.body?.mine) &&
          Array.isArray(own.body?.waitingOnOthers),
        JSON.stringify(own.body?.summary)
      );

      const shell = await Promise.all([
        call(money, 'GET', '/version'),
        call(money, 'GET', '/notifications'),
        call(money, 'GET', '/auth/me'),
      ]);
      check(
        // Their own bell, the build label and their own account: the app has to be usable.
        'the shell and their own account still work',
        shell.every((answer) => answer.status === 200),
        JSON.stringify(shell.map((answer) => answer.status))
      );

      /* ------------------------------------------- and it is not a back door -- */
      check(
        'somebody who does the work cannot read the figures',
        (await call(bob, 'GET', '/sales/dashboard')).status === 403,
        'a consultant could open the Sales section'
      );
      check(
        // Deliberate, and said on the page: an admin who cannot open it cannot tell
        // whether it works, and on this instance they can grant themselves the role.
        'an admin can',
        (await call(alice, 'GET', '/sales/dashboard')).status === 200,
        'an admin could not open the Sales section'
      );

      /* ------------------------- nobody is offered work they cannot open ------ */
      const pickable = await call(alice, 'GET', '/users?active=true');
      check(
        'a sales account is not offered as somebody to put on a job',
        !(pickable.body ?? []).some((row) => row.username === money.user.username),
        'a sales account was in the pickable list'
      );
      check(
        'nor in the skills directory',
        !((await call(alice, 'GET', '/users/skills')).body?.people ?? []).some(
          (row) => row.username === money.user.username
        ),
        'a sales account was in the skills directory'
      );

      const mention = await call(alice, 'POST', `/audits/${auditId}/findings/${findingId}/comments`, {
        body: `@${money.user.username} what does this cost?`,
      });
      check(
        // A mention is a notification with a link in it, and that link would answer 403.
        'and mentioning one notifies nobody',
        (mention.body?.mentioned ?? []).length === 0 &&
          (await Notification.countDocuments({ user: money.user._id, type: 'mention' })) === 0,
        JSON.stringify(mention.body?.mentioned)
      );

      /* ------------------------------------------- a role nobody has heard of -- */
      await User.updateOne({ _id: money.user._id }, { $set: { role: 'finance' } });
      check(
        // The gate confines anything that is not a working role, rather than naming the
        // one it knows. This role was spelled `finance` for a single commit, and under
        // the other rule a leftover account would have been handed the whole app.
        'an unrecognised role is walled in rather than let through',
        (await call(money, 'GET', '/audits')).status === 403,
        'a stale role reached the engagements'
      );
      await User.updateOne({ _id: money.user._id }, { $set: { role: 'sales' } });

      await Notification.deleteMany({ user: money.user._id });
    }

    /* ------------------------------------------------ the proposal pipeline ---- */
    log.info('Proposals');
    {
      const { Proposal } = await import('../models/proposal.model.js');
      const { Company } = await import('../models/company.model.js');
      const { Client: Contacts } = await import('../models/client.model.js');
      const { Template: Templates } = await import('../models/template.model.js');
      const { Settings: SettingsModel2 } = await import('../models/settings.model.js');
      const { SalesActivity: SalesActivityForKickoff } = await import(
        '../models/sales-activity.model.js'
      );
      const PizZip2 = (await import('pizzip')).default;

      const seller = await makeUser('seller', 'sales');
      /*
       * Signing a client's paperwork off takes a manager, so the suite needs one. `bob` stays a
       * plain consultant on purpose — the interesting check is that he is refused.
       */
      const boss = await makeUser('boss', 'user');
      boss.user.roles = ['user', 'manager'];
      await boss.user.save();

      await Proposal.deleteMany({ title: /^zz-collab/ });
      await Company.deleteMany({ name: /^zz-collab/ });
      await Contacts.deleteMany({ email: /zz-collab/ });
      await Templates.deleteMany({ name: /^zz-collab/ });

      /* -------------------------------------- the client book, from sales' side - */
      const madeClient = await call(seller, 'POST', '/sales/clients', {
        name: 'zz-collab-prop Northwind',
        address: '5 Client Road, Leeds',
      });
      check(
        'sales can put a client on record',
        madeClient.status === 201 && Boolean(madeClient.body?.id),
        JSON.stringify(madeClient.body)
      );
      const madeContact = await call(seller, 'POST', '/sales/contacts', {
        email: 'dana@zz-collab-prop.invalid',
        firstname: 'Dana',
        lastname: 'Reyes',
        title: 'CISO',
        company: madeClient.body.id,
      });
      check('and the people at it', madeContact.status === 201, JSON.stringify(madeContact.body));
      check(
        // The wall is the whole point of the section; the client book is reached through it.
        'an operator cannot reach the sales client book',
        (await call(bob, 'GET', '/sales/clients')).status === 403,
        'a consultant read the sales client book'
      );

      /* ------------------------------------------------------- raising one ------ */
      const raised = await call(seller, 'POST', '/proposals', {
        title: 'zz-collab-prop internal test',
        company: madeClient.body.id,
        contacts: [madeContact.body.id],
        auditType: 'Internal Penetration Test',
        summary: 'Two domains, 400 hosts.',
        constraints: 'Out of hours only.',
        salesDays: 5,
        expectedStart: '2026-09-01',
        expectedEnd: '2026-09-10',
        validUntil: '2026-08-31',
      });
      check(
        'a proposal is raised with a reference of its own',
        raised.status === 201 && /^PRO-\d{4}-\d{3}$/.test(raised.body?.reference ?? ''),
        JSON.stringify([raised.status, raised.body?.reference])
      );
      const pid = raised.body._id;
      check(
        'it starts as a draft, and only sales can move it on',
        raised.body.status === 'draft' &&
          (raised.body.transitions ?? []).map((t) => t.to).join() === 'evaluating',
        JSON.stringify(raised.body.transitions)
      );

      /* ------------------------------- the estimate is not sales' to agree ------ */
      check(
        // The whole reason the evaluation step exists.
        'sales cannot agree its own estimate',
        (await call(seller, 'PUT', `/proposals/${pid}/estimate`, { days: 5 })).status === 403,
        'sales set the agreed effort'
      );
      check(
        'and cannot skip the evaluation',
        (await call(seller, 'POST', `/proposals/${pid}/status`, { status: 'evaluated' })).status === 400,
        'a proposal went straight to evaluated'
      );

      await call(seller, 'POST', `/proposals/${pid}/status`, { status: 'evaluating' });
      const queued = await call(bob, 'GET', '/proposals/queue');
      check(
        'it appears in the queue of the people who would do the work',
        (queued.body?.evaluating ?? []).some((row) => row._id === pid),
        JSON.stringify((queued.body?.evaluating ?? []).map((r) => r.reference))
      );

      const revised = await call(bob, 'PUT', `/proposals/${pid}/estimate`, {
        days: 9,
        note: 'The AD estate is larger than the brief suggested',
      });
      check(
        // Both numbers, which is what makes an override visible as an override.
        'an operator can change the effort, and what sales said is kept',
        revised.body?.estimate?.salesDays === 5 && revised.body?.estimate?.days === 9,
        JSON.stringify(revised.body?.estimate)
      );
      check(
        'the effort that counts is the agreed one',
        revised.body?.effortDays === 9 && revised.body?.effortAgreed === true,
        JSON.stringify([revised.body?.effortDays, revised.body?.effortAgreed])
      );

      await call(bob, 'PUT', `/proposals/${pid}/evaluation`, { notes: 'Feasible', verdict: 'feasible' });
      await call(bob, 'POST', `/proposals/${pid}/status`, { status: 'evaluated' });

      /* ---------------------------------------------- generating the paperwork -- */
      const settingsNow = await SettingsModel2.getSettings();
      const firmBefore = settingsNow.firm?.toObject?.() ?? { ...(settingsNow.firm ?? {}) };
      settingsNow.firm = {
        legalName: 'zz-collab-prop Offensive Ltd',
        address: '1 Test Street',
        registration: '12345678',
        signatoryName: 'Alex Prine',
        signatoryTitle: 'Director',
        jurisdiction: 'England and Wales',
      };
      await settingsNow.save();

      const tpl = await Templates.create({
        name: 'zz-collab-prop NDA',
        kind: 'docx',
        purpose: 'proposal',
        docType: 'nda',
        filename: 'engy-starter-nda.docx',
      });

      /* ------------------------------ templates from before `purpose` existed --- */
      {
        /*
         * A Mongoose default applies when a document is created and does nothing to rows already
         * in the database, so every template uploaded before this field existed has no `purpose`
         * key at all. An exact match on 'report' skipped them, which took somebody's only report
         * template out of the engagement picker and made the dashboard claim none was uploaded.
         */
        const { backfillTemplatePurpose } = await import(
          '../services/template-purpose.service.js'
        );
        const legacy = await Templates.collection.insertOne({
          name: 'zz-collab-prop legacy report',
          kind: 'docx',
          ext: 'docx',
          filename: 'engy-default-template.docx',
          detectedTags: [],
          size: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const forReports = await call(alice, 'GET', '/templates?purpose=report');
        check(
          'a template from before `purpose` existed still counts as a report template',
          (forReports.body ?? []).some((row) => row.name === 'zz-collab-prop legacy report'),
          JSON.stringify((forReports.body ?? []).map((r) => [r.name, r.purpose]))
        );
        check(
          // The other direction has to stay exact, or an unmarked row would be offered as an NDA.
          'and is not offered as proposal paperwork',
          !((await call(alice, 'GET', '/templates?purpose=proposal')).body ?? []).some(
            (row) => row.name === 'zz-collab-prop legacy report'
          ),
          'a legacy template was offered as proposal paperwork'
        );

        check(
          'the boot backfill fills the field in',
          (await backfillTemplatePurpose()) >= 1 &&
            (await Templates.findById(legacy.insertedId)).purpose === 'report',
          'the backfill did not mark it as a report template'
        );
        check(
          'and running it again does nothing',
          (await backfillTemplatePurpose()) === 0,
          'the backfill was not idempotent'
        );

        await Templates.deleteOne({ _id: legacy.insertedId });
      }

      const offered = await call(seller, 'GET', '/proposals/templates');
      check(
        'sales is offered the proposal templates, and only those',
        (offered.body ?? []).some((row) => row.id === tpl._id.toString()) &&
          (offered.body ?? []).every((row) => row.docType),
        JSON.stringify(offered.body?.map((r) => r.name))
      );
      check(
        // A report template rendered as an NDA would be nonsense with a client's name on it.
        'a report template is refused as proposal paperwork',
        (
          await call(seller, 'POST', `/proposals/${pid}/documents/generate`, {
            template: (await Templates.findOne({ purpose: 'report' }))?._id?.toString() ?? tpl._id.toString(),
          })
        ).status === 400 ||
          !(await Templates.findOne({ purpose: 'report' })),
        'a report template generated proposal paperwork'
      );

      const generated = await call(seller, 'POST', `/proposals/${pid}/documents/generate`, {
        template: tpl._id.toString(),
      });
      check(
        'the NDA is generated through the report pipeline',
        generated.status === 201 && (generated.body?.documents ?? []).length === 1,
        JSON.stringify([generated.status, generated.body?.documents?.length])
      );
      const docId = generated.body.documents[0]._id;

      const download = await call(seller, 'GET', `/proposals/${pid}/documents/${docId}/download`);
      check(
        // Never inline, whatever it claims to be — the same rule as a client's documents.
        'and comes back as an attachment the browser will not render',
        /attachment/.test(download.headers['content-disposition'] ?? '') &&
          download.headers['x-content-type-options'] === 'nosniff',
        download.headers['content-disposition']
      );

      /*
       * Fetched again as bytes. `call` decodes the body as text, which mangles a zip — and the
       * question here is what is *inside* the document, so it has to be read as a package.
       */
      const raw = await fetch(`${base}/proposals/${pid}/documents/${docId}/download`, {
        headers: { Authorization: `Bearer ${seller.token}` },
      });
      const bytes = Buffer.from(await raw.arrayBuffer());
      const rendered = new PizZip2(bytes)
        .file('word/document.xml')
        .asText()
        .replace(/<[^>]*>/g, '');
      check(
        'with both parties and the reference actually rendered into it',
        rendered.includes('zz-collab-prop Offensive Ltd') &&
          rendered.includes('zz-collab-prop Northwind') &&
          rendered.includes('Dana Reyes') &&
          rendered.includes(raised.body.reference),
        rendered.slice(0, 160)
      );
      check('and no placeholder left unresolved', !/\{\{/.test(rendered), 'a tag survived the render');

      /* ------------------------------------ the kickoff, and the permission ---- */
      const ptaTemplate = await Templates.create({
        name: 'zz-collab-prop permission',
        kind: 'docx',
        purpose: 'proposal',
        docType: 'pta',
        filename: 'engy-starter-pta.docx',
      });

      /*
       * Generated before the call has happened. The permission has to leave the kickoff section
       * out rather than print a signature block over an empty date — a document asserting a
       * meeting nobody held is worse than one that does not mention it.
       */
      const early = await call(seller, 'POST', `/proposals/${pid}/documents/generate`, {
        template: ptaTemplate._id.toString(),
      });
      const earlyDoc = (early.body?.documents ?? []).find((doc) => doc.docType === 'pta');
      const readDoc = async (docId) => {
        const raw = await fetch(`${base}/proposals/${pid}/documents/${docId}/download`, {
          headers: { Authorization: `Bearer ${seller.token}` },
        });
        return new PizZip2(Buffer.from(await raw.arrayBuffer()))
          .file('word/document.xml')
          .asText()
          .replace(/<[^>]*>/g, '');
      };
      const earlyText = await readDoc(earlyDoc._id);
      check(
        'a permission to attack is generated, and calls itself that',
        early.status === 201 && /Permission to attack/i.test(earlyText),
        earlyText.slice(0, 80)
      );
      check(
        'and leaves the kickoff out while there has not been one',
        !/Agreed at the kickoff/.test(earlyText),
        'the kickoff section appeared before the call happened'
      );

      /* ------------------------------------------------ recording the kickoff --- */
      const kicked = await call(bob, 'PUT', `/proposals/${pid}/kickoff`, {
        heldOn: '2026-08-20',
        attendeesOurs: 'Collab alice, Collab bob',
        attendeesTheirs: 'Dana Reyes (CISO)',
        emergencyContact: 'Dana Reyes — +44 7700 900000',
        notes: 'Out of hours only, from 20:00. Domain account on day one.',
      });
      check(
        // Either side, unlike the estimate: whoever was on the call writes it up.
        'somebody doing the work can record the kickoff',
        kicked.status === 200 && kicked.body?.kickoff?.heldOn === '2026-08-20',
        JSON.stringify([kicked.status, kicked.body?.kickoff?.heldOn])
      );
      check(
        'and so can sales',
        (
          await call(seller, 'PUT', `/proposals/${pid}/kickoff`, {
            notes: 'Out of hours only, from 20:00. Domain account on day one. Two sites.',
          })
        ).status === 200,
        'sales could not record the kickoff'
      );

      const regenerated = await call(seller, 'POST', `/proposals/${pid}/documents/generate`, {
        template: ptaTemplate._id.toString(),
      });
      const laterDoc = (regenerated.body?.documents ?? []).find((doc) => doc.docType === 'pta');
      const laterText = await readDoc(laterDoc._id);
      check(
        'regenerating it now carries what was agreed on the call',
        /Agreed at the kickoff/.test(laterText) &&
          /Dana Reyes \(CISO\)/.test(laterText) &&
          /Domain account on day one/.test(laterText),
        laterText.slice(0, 120)
      );
      check(
        // The field somebody reaches for at two in the morning.
        'including who to ring if testing breaks something',
        /\+44 7700 900000/.test(laterText),
        'the emergency contact was not in the permission'
      );
      check(
        'and regenerating replaced the old one rather than adding a second',
        (regenerated.body?.documents ?? []).filter((doc) => doc.docType === 'pta').length === 1,
        JSON.stringify((regenerated.body?.documents ?? []).map((d) => d.docType))
      );
      check(
        // By proposal id, not by reference: the reference sequence carries on across runs, and a
        // count over all of history is not a count of what this run did.
        'the kickoff is recorded in the sales log, once per edit',
        (await SalesActivityForKickoff.countDocuments({
          action: 'kickoff.recorded',
          proposal: pid,
        })) === 2,
        'the kickoff was not logged twice'
      );

      /* ------------------------------------------ the pre-engagement document --- */
      const preEngagement = new FormData();
      preEngagement.append(
        'file',
        new Blob(['zz-collab-prop pre-engagement scope notes'], { type: 'text/plain' }),
        'pre-engagement.txt'
      );
      preEngagement.append('docType', 'pre-engagement');
      const uploaded = await call(seller, 'POST', `/proposals/${pid}/documents`, preEngagement);
      check(
        'the pre-engagement document can be uploaded against the proposal',
        uploaded.status === 201 &&
          (uploaded.body?.documents ?? []).some(
            (doc) => doc.docType === 'pre-engagement' && !doc.generated
          ),
        JSON.stringify((uploaded.body?.documents ?? []).map((d) => [d.docType, d.generated]))
      );
      check(
        // Only what we produced needs a signature from our side.
        'and does not sit there waiting for a sign-off',
        (
          await call(boss, 'POST', `/proposals/${pid}/documents/${
            (uploaded.body.documents.find((d) => d.docType === 'pre-engagement'))._id
          }/review`, { approved: true })
        ).status === 400,
        'an uploaded document was signed off'
      );

      // Off again, so the sign-off checks below see only the NDA.
      for (const doc of (await call(seller, 'GET', `/proposals/${pid}`)).body.documents) {
        if (doc.docType !== 'nda') {
          await call(seller, 'DELETE', `/proposals/${pid}/documents/${doc._id}`);
        }
      }

      /* --------------------------------- somebody else has to sign it off ------ */
      await call(seller, 'POST', `/proposals/${pid}/status`, { status: 'documents-review' });
      const tooSoon = await call(seller, 'POST', `/proposals/${pid}/status`, { status: 'sent' });
      check(
        'it cannot be sent while the paperwork is unchecked',
        tooSoon.status === 400 && /signed off/.test(tooSoon.body?.error ?? ''),
        JSON.stringify(tooSoon.body?.error)
      );
      check(
        'and the author cannot sign off their own paperwork',
        (
          await call(seller, 'POST', `/proposals/${pid}/documents/${docId}/review`, { approved: true })
        ).status === 403,
        'sales signed off its own document'
      );
      const notAManager = await call(bob, 'POST', `/proposals/${pid}/documents/${docId}/review`, {
        approved: true,
      });
      check(
        // Deciding a contract may leave the building is an authority, not a skill: a consultant
        // writes the estimate, a manager signs the paperwork.
        'nor can somebody who does the work but is not a manager',
        notAManager.status === 403 && /manager/.test(notAManager.body?.error ?? ''),
        JSON.stringify([notAManager.status, notAManager.body?.error])
      );
      check(
        'and they cannot send it back either, which is the same decision',
        (await call(bob, 'POST', `/proposals/${pid}/status`, { status: 'evaluated' })).status === 400,
        'a non-manager sent the paperwork back'
      );

      const rejected = await call(boss, 'POST', `/proposals/${pid}/documents/${docId}/review`, {
        approved: false,
        reason: 'Clause 3 names the wrong term',
      });
      check(
        'it can be sent back with a reason',
        rejected.body?.documents?.[0]?.rejectedReason === 'Clause 3 names the wrong term',
        JSON.stringify(rejected.body?.documents?.[0])
      );
      check(
        'a rejection with no reason is refused',
        (
          await call(boss, 'POST', `/proposals/${pid}/documents/${docId}/review`, { approved: false })
        ).status === 400,
        'a document was rejected with no reason'
      );
      const approved = await call(boss, 'POST', `/proposals/${pid}/documents/${docId}/review`, {
        approved: true,
      });
      check(
        'and signed off, which clears the rejection',
        Boolean(approved.body?.documents?.[0]?.approvedAt) &&
          !approved.body?.documents?.[0]?.rejectedAt,
        JSON.stringify(approved.body?.documents?.[0])
      );

      /* ------------------------------------------------- sent, then accepted --- */
      const sent = await call(seller, 'POST', `/proposals/${pid}/status`, { status: 'sent' });
      check('now it can go out', sent.status === 200 && sent.body?.status === 'sent', JSON.stringify(sent.body?.error));
      check(
        // The record and the paper on the client's desk must not be able to disagree.
        'and its details are frozen once it has',
        (await call(seller, 'PUT', `/proposals/${pid}`, { title: 'zz-collab-prop changed' })).status === 400,
        'a sent proposal could still be edited'
      );

      const accepted = await call(seller, 'POST', `/proposals/${pid}/status`, {
        status: 'accepted',
        reason: 'availability',
        note: 'We could start in the week they wanted.',
      });
      check('the client accepts', accepted.body?.status === 'accepted', JSON.stringify(accepted.body?.status));
      check(
        'and a win records why, which is the half nobody writes down',
        accepted.body?.outcome?.reason === 'availability' &&
          /week they wanted/.test(accepted.body?.outcome?.note ?? ''),
        JSON.stringify(accepted.body?.outcome)
      );

      const inquiries = await call(bob, 'GET', '/proposals?status=accepted,converted');
      check(
        'it shows up as an inquired engagement, with the effort on it',
        (inquiries.body?.proposals ?? []).some((row) => row._id === pid && row.effortDays === 9),
        JSON.stringify((inquiries.body?.proposals ?? []).map((r) => [r.reference, r.effortDays]))
      );

      /* ------------------------------------------------ and becomes a job ------ */
      check(
        'sales does not create the engagement',
        (await call(seller, 'POST', `/proposals/${pid}/convert`, {})).status === 403,
        'sales created an engagement'
      );
      const converted = await call(bob, 'POST', `/proposals/${pid}/convert`, {});
      check(
        'the work side turns it into one',
        converted.status === 201 && converted.body?.proposal?.status === 'converted',
        JSON.stringify([converted.status, converted.body?.proposal?.status])
      );

      const { Audit: Audits17 } = await import('../models/audit.model.js');
      const born = await Audits17.findById(converted.body?.audit?.id);
      check(
        // Retyping the number is how the engagement ends up disagreeing with the contract.
        'and the days sold come across with it',
        born?.daysSold === 9 && String(born?.proposal) === String(pid),
        JSON.stringify([born?.daysSold, String(born?.proposal)])
      );
      check(
        'a proposal that became a job cannot be deleted',
        (await call(seller, 'DELETE', `/proposals/${pid}`)).status === 400,
        'a converted proposal was deleted'
      );

      /* ------------------------------------------------ more than one role ------ */
      check(
        'an account can hold two roles and passes both checks',
        boss.user.roles.join() === 'user,manager' &&
          boss.user.hasRole('user') &&
          boss.user.hasRole('manager') &&
          !boss.user.hasRole('sales'),
        JSON.stringify(boss.user.roles)
      );
      {
        const { User: Users19 } = await import('../models/user.model.js');
        // The queries every picker uses match array membership, so a manager is still somebody
        // you can put on a job.
        check(
          'and is still offered as somebody to put on a job',
          ((await call(alice, 'GET', '/users?active=true')).body ?? []).some(
            (row) => row.username === boss.user.username
          ),
          'a manager was not in the pickable list'
        );
        check(
          'the roles list is what is published, not just the primary',
          ((await call(alice, 'GET', '/users')).body ?? []).find(
            (row) => row.username === boss.user.username
          )?.roles?.join() === 'user,manager',
          'the roles were not published'
        );

        /* The migration that made all this survivable. */
        const { backfillRoles } = await import('../services/roles-migration.service.js');
        await Users19.collection.updateOne(
          { _id: boss.user._id },
          { $unset: { roles: '' }, $set: { role: 'manager' } }
        );
        check(
          'an account from before roles were a list is migrated onto one',
          (await backfillRoles()) >= 1 &&
            (await Users19.findById(boss.user._id)).roles.join() === 'manager',
          'the roles backfill did not run'
        );
        check('and running it again does nothing', (await backfillRoles()) === 0);
        await Users19.updateOne({ _id: boss.user._id }, { $set: { roles: ['user', 'manager'] } });
      }

      /* ---------------------------------------- deleting, and what refuses it -- */
      const { SalesActivity } = await import('../models/sales-activity.model.js');

      check(
        // A client with a proposal against it must not be removable, or the proposal is left
        // naming something that no longer exists.
        'a client with a proposal against it cannot be deleted',
        (await call(seller, 'DELETE', `/sales/clients/${madeClient.body.id}`)).status === 400,
        'a client in use was deleted'
      );
      const clientRefusal = await call(seller, 'DELETE', `/sales/clients/${madeClient.body.id}`);
      check(
        'and the refusal names what is in the way',
        /proposal/.test(clientRefusal.body?.error ?? '') &&
          /contact/.test(clientRefusal.body?.error ?? ''),
        JSON.stringify(clientRefusal.body?.error)
      );
      check(
        'a contact named on a proposal cannot be deleted either',
        (await call(seller, 'DELETE', `/sales/contacts/${madeContact.body.id}`)).status === 400,
        'a contact in use was deleted'
      );
      {
        /*
         * A delivery must not block it. A delivery is never removed — it is the evidence a report
         * went to somebody on a date — so treating one as a blocker made the contact permanently
         * undeletable, under an instruction that could only be followed by destroying the record.
         * The delivery keeps its own snapshot of the name and address, so it loses nothing.
         */
        const { Delivery: Deliveries2 } = await import('../models/delivery.model.js');
        const spareContact = await Contacts.create({
          email: 'zz-collab-prop-delivered@example.invalid',
          firstname: 'Delivered',
          company: madeClient.body.id,
        });
        await Deliveries2.create({
          audit: auditId,
          version: 'zz-collab-prop 1.0',
          // Required: a delivery with no date is not a record of anything.
          sentAt: new Date(),
          recipients: [{ client: spareContact._id, name: 'Delivered To', email: spareContact.email }],
        });
        const gone = await call(seller, 'DELETE', `/sales/contacts/${spareContact._id}`);
        check(
          'a contact who has been sent a report can still be deleted',
          gone.status === 200,
          JSON.stringify(gone.body?.error)
        );
        const survived = await Deliveries2.findOne({ version: 'zz-collab-prop 1.0' });
        check(
          'and the delivery still says who it went to',
          survived?.recipients?.[0]?.email === 'zz-collab-prop-delivered@example.invalid' &&
            survived?.recipients?.[0]?.name === 'Delivered To',
          JSON.stringify(survived?.recipients)
        );
        await Deliveries2.deleteMany({ version: /^zz-collab-prop/ });
      }
      check(
        // The looser of the two doors, until this rule was shared. A company deleted here used
        // to leave engagements pointing at nothing.
        'and the Clients & Data page refuses the same thing',
        (await call(alice, 'DELETE', `/data/companies/${madeClient.body.id}`)).status === 400,
        'the data page deleted a client that was in use'
      );

      /* -------------------------------------------- the log, for admins only --- */
      const salesLog = await call(alice, 'GET', '/sales/activity');
      const actions = (salesLog.body?.entries ?? []).map((entry) => entry.action);
      check(
        'the sales log records what happened, newest first',
        salesLog.status === 200 &&
          ['client.added', 'contact.added', 'proposal.raised', 'estimate.set', 'proposal.moved',
           'document.generated', 'document.approved', 'proposal.converted']
            .every((action) => actions.includes(action)),
        JSON.stringify(actions.slice(0, 12))
      );
      const estimateEntry = (salesLog.body?.entries ?? []).find((e) => e.action === 'estimate.set');
      check(
        // The entry an admin comes here for: both figures, so a pattern is visible.
        'an effort change records both figures',
        estimateEntry?.meta?.days === 9 && estimateEntry?.meta?.salesDays === 5,
        JSON.stringify(estimateEntry?.meta)
      );
      check(
        'and says which hat the person was wearing',
        (salesLog.body?.entries ?? []).some((entry) => entry.actorRole === 'sales') &&
          (salesLog.body?.entries ?? []).some((entry) => entry.actorRole === 'user'),
        JSON.stringify((salesLog.body?.entries ?? []).map((e) => e.actorRole).slice(0, 8))
      );
      check(
        // Not a colleague's business, which is the whole difference from an engagement's log.
        'sales cannot read the sales log',
        (await call(seller, 'GET', '/sales/activity')).status === 403,
        'a sales account read the sales log'
      );
      check(
        'nor can somebody doing the work',
        (await call(bob, 'GET', '/sales/activity')).status === 403,
        'a consultant read the sales log'
      );
      check(
        'it can be narrowed to one part of the flow',
        ((await call(alice, 'GET', '/sales/activity?area=effort')).body?.entries ?? []).every(
          (entry) => entry.area === 'effort'
        ),
        'the area filter let something else through'
      );

      /* --------------------------------------------- why it was won or lost ---- */
      log.info('Win and loss reasons');
      {
        /*
         * A second proposal, taken all the way to a decision and then lost. The full walk is
         * unavoidable: a proposal cannot be declined before it has been sent, and it cannot be sent
         * before somebody with the authority has signed off the paperwork — which is the flow working
         * as intended, so the test walks it rather than reaching into the database.
         */
        const raised = await call(seller, 'POST', '/proposals', {
          title: 'zz-collab-prop lost proposal',
          company: madeClient.body.id,
          contacts: [madeContact.body.id],
          summary: 'A job we do not get.',
        });
        const lostId = raised.body?._id;
        check('a second proposal to lose', raised.status === 201, JSON.stringify(raised.body?.error));

        await call(seller, 'POST', `/proposals/${lostId}/status`, { status: 'evaluating' });
        await call(bob, 'PUT', `/proposals/${lostId}/estimate`, { days: 4 });
        await call(bob, 'POST', `/proposals/${lostId}/status`, { status: 'evaluated' });

        /*
         * Generated rather than uploaded: sending requires paperwork this app produced, which is the
         * rule that stops an offer going out as somebody's hand-edited copy. `tpl` is the proposal
         * template the block above registered.
         */
        const madePaper = await call(seller, 'POST', `/proposals/${lostId}/documents/generate`, {
          template: tpl._id.toString(),
        });
        const docToSign = madePaper.body?.documents?.[0]?._id;
        check('the second one has paperwork of its own', madePaper.status === 201, JSON.stringify(madePaper.body?.error));
        await call(seller, 'POST', `/proposals/${lostId}/status`, { status: 'documents-review' });
        await call(boss, 'POST', `/proposals/${lostId}/documents/${docToSign}/review`, {
          approved: true,
        });
        const wentOut = await call(seller, 'POST', `/proposals/${lostId}/status`, { status: 'sent' });
        check('the second one goes out too', wentOut.body?.status === 'sent', JSON.stringify(wentOut.body?.error));

        const noReason = await call(seller, 'POST', `/proposals/${lostId}/status`, {
          status: 'declined',
        });
        check(
          'a loss with no reason is refused — the whole point is that the reason exists',
          noReason.status === 400 && /why it was lost/i.test(noReason.body?.error ?? ''),
          JSON.stringify([noReason.status, noReason.body?.error])
        );

        const nonsense = await call(seller, 'POST', `/proposals/${lostId}/status`, {
          status: 'declined',
          reason: 'they-were-rude',
        });
        check(
          'and so is a reason that is not one of the reasons',
          nonsense.status === 400,
          JSON.stringify([nonsense.status, nonsense.body?.error])
        );

        const lost = await call(seller, 'POST', `/proposals/${lostId}/status`, {
          status: 'declined',
          reason: 'competitor',
          competitor: 'Some Other Firm',
          note: 'Cheaper and could start sooner.',
        });
        check(
          'a loss records the reason and who to',
          lost.body?.outcome?.reason === 'competitor' &&
            lost.body?.outcome?.competitor === 'Some Other Firm',
          JSON.stringify(lost.body?.outcome)
        );
        check(
          'and keeps the older free-text field in step, which the proposal page prints',
          /Cheaper/.test(lost.body?.declineReason ?? ''),
          JSON.stringify(lost.body?.declineReason)
        );

        const outcomes = await call(seller, 'GET', '/proposals/outcomes?months=12');
        check('the reasons can be counted', outcomes.status === 200, JSON.stringify(outcomes.body).slice(0, 160));
        check(
          'the count knows what was lost, to whom, and the win rate',
          (outcomes.body?.losses ?? []).some((row) => row.reason === 'competitor' && row.count >= 1) &&
            (outcomes.body?.competitors ?? []).some((row) => row.name === 'Some Other Firm') &&
            typeof outcomes.body?.totals?.winRate === 'number',
          JSON.stringify(outcomes.body?.totals)
        );
        check(
          'and it counts the win too',
          (outcomes.body?.wins ?? []).some((row) => row.reason === 'availability'),
          JSON.stringify(outcomes.body?.wins)
        );

        /*
         * Reopening clears it. A proposal lost on price in March and won in June must not carry
         * March's reason into the win column.
         */
        const reopened = await call(seller, 'POST', `/proposals/${lostId}/status`, { status: 'draft' });
        check(
          'reopening a lost proposal forgets why it was lost',
          reopened.status === 200 && !reopened.body?.outcome?.reason,
          JSON.stringify(reopened.body?.outcome)
        );

        /*
          * `seller`, not `boss`. Only the sales side may delete a proposal, so this call answered
          * 403 every run — and because nothing checked the result, every run left one behind in the
          * real pipeline. Ten of them had piled up before somebody saw them on the dashboard.
          */
         const goneAgain = await call(seller, 'DELETE', `/proposals/${lostId}`);
         check(
           'and the one we lost can be tidied away by the side that raised it',
           goneAgain.status === 200,
           JSON.stringify([goneAgain.status, goneAgain.body?.error])
         );
      }

      /*
       * Handles the five blocks below share. Imported here rather than at the top of the file for
       * the same reason every other model in this script is: the suite mints its tokens before the
       * models are needed, and a top-level import of half the app makes the failure of one block
       * look like a failure to start.
       */
      const { SalesTarget: SalesTargets, quarterOf } = await import(
        '../models/sales-target.model.js'
      );
      const { buildProposalData } = await import('../services/proposal-data.service.js');
      const { PROPOSAL_POPULATE: PROPOSAL_POPULATE2 } = await import(
        '../services/proposal.service.js'
      );

      /* ------------------------------------------- the argument in writing ----- */
      log.info('Comments on a proposal');
      {
        const empty = await call(seller, 'POST', `/proposals/${pid}/comments`, { body: '   ' });
        // 422, like every other body this app rejects before the route sees it.
        check('an empty comment is refused', empty.status === 422, JSON.stringify(empty.status));

        const asked = await call(seller, 'POST', `/proposals/${pid}/comments`, {
          body: 'Nine days for 40 hosts — is the AD estate inside that figure?',
        });
        check(
          'sales can ask about the estimate where the estimate is',
          asked.status === 201 && (asked.body?.comments ?? []).length === 1,
          JSON.stringify([asked.status, asked.body?.comments?.length])
        );
        check(
          'and the comment names who wrote it, rather than an id the page has to resolve',
          asked.body?.comments?.[0]?.author?.name === 'Collab seller' &&
            asked.body.comments[0].mine === true,
          JSON.stringify(asked.body?.comments?.[0]?.author)
        );

        /* Both audiences, which is the point: every other panel belongs to one side. */
        const answered = await call(bob, 'POST', `/proposals/${pid}/comments`, {
          body: 'It is. Two of the nine are the domain.',
        });
        check(
          'the work side can answer in the same place',
          answered.status === 201 && (answered.body?.comments ?? []).length === 2,
          JSON.stringify([answered.status, answered.body?.comments?.length])
        );
        check(
          'and each side sees which of the two is theirs',
          answered.body.comments.filter((row) => row.mine).length === 1,
          JSON.stringify(answered.body.comments.map((row) => [row.author?.username, row.mine]))
        );

        const theirs = answered.body.comments[0]._id;
        const mine = answered.body.comments[1]._id;
        check(
          'somebody else editing what you said is not a comment thread',
          (await call(bob, 'DELETE', `/proposals/${pid}/comments/${theirs}`)).status === 403,
          'one person deleted another persons comment'
        );
        check(
          'but an admin can tidy anybody up',
          (await call(alice, 'DELETE', `/proposals/${pid}/comments/${theirs}`)).status === 200,
          'an admin could not remove a comment'
        );
        const afterMine = await call(bob, 'DELETE', `/proposals/${pid}/comments/${mine}`);
        check(
          'and your own goes when you say so',
          afterMine.status === 200 && (afterMine.body?.comments ?? []).length === 0,
          JSON.stringify(afterMine.body?.comments?.length)
        );
        check(
          'a comment that is not there answers 404 rather than pretending',
          (await call(bob, 'DELETE', `/proposals/${pid}/comments/${mine}`)).status === 404,
          'deleting a missing comment did not 404'
        );
      }

      /* ------------------------------------------------ next year's, from this - */
      log.info('Cloning a proposal');
      {
        const source = await call(seller, 'GET', `/proposals/${pid}`);
        const cloned = await call(seller, 'POST', `/proposals/${pid}/clone`, {});
        check(
          'a closed proposal can be raised again',
          cloned.status === 201 && cloned.body?.status === 'draft',
          JSON.stringify([cloned.status, cloned.body?.status, cloned.body?.error])
        );
        check(
          'with a reference of its own',
          cloned.body?.reference && cloned.body.reference !== converted.body?.proposal?.reference,
          JSON.stringify([cloned.body?.reference, converted.body?.proposal?.reference])
        );
        check(
          // The scope and the constraints are the part somebody would otherwise retype, and a
          // constraint left out of the retyping is the one the client cared about.
          'carrying the scope, the constraints and the contacts across',
          cloned.body?.summary === source.body?.summary &&
            cloned.body?.constraints === source.body?.constraints &&
            (cloned.body?.contacts ?? []).length === (source.body?.contacts ?? []).length &&
            String(cloned.body?.company?._id ?? cloned.body?.company) === String(madeClient.body.id),
          JSON.stringify([cloned.body?.summary, cloned.body?.constraints])
        );
        check(
          'the dates a year on, because that is what "annual" means',
          cloned.body?.expectedStart?.slice(0, 4) ===
            String(Number(source.body?.expectedStart?.slice(0, 4)) + 1),
          JSON.stringify([source.body?.expectedStart, cloned.body?.expectedStart])
        );
        check(
          // It is about the job as it was scoped then, and it belongs to whoever agreed it.
          'and deliberately not the agreed estimate, so it goes round the loop again',
          cloned.body?.estimate?.days === null &&
            cloned.body?.estimate?.salesDays === source.body?.estimate?.salesDays &&
            cloned.body?.effortAgreed === false,
          JSON.stringify(cloned.body?.estimate)
        );
        check(
          // An NDA is signed and a permission to attack names dates; carried across, it would be a
          // contract about last year with this year's reference on it.
          'nor the paperwork, nor the engagement it became',
          (cloned.body?.documents ?? []).length === 0 && !cloned.body?.audit,
          JSON.stringify([cloned.body?.documents?.length, cloned.body?.audit])
        );
        check(
          // Blank on the first cut, which made the clone look like a record from nowhere.
          'raised today, and saying which proposal it came from',
          Boolean(cloned.body?.requestedOn) &&
            (cloned.body?.history ?? []).length === 1 &&
            new RegExp(source.body.reference).test(cloned.body.history[0].note ?? ''),
          JSON.stringify([cloned.body?.requestedOn, cloned.body?.history])
        );
        check(
          'and the log says where it came from',
          (await SalesActivity.countDocuments({
            action: 'proposal.raised',
            'meta.clonedFrom': converted.body?.proposal?.reference,
          })) === 1,
          'the clone was not logged against its source'
        );

        /*
         * Removed straight from the collection rather than through the route.
         *
         * A reference is the highest one in use plus one, so deleting the newest frees it for the
         * next proposal — and a logged deletion would then leave two `proposal.deleted` rows naming
         * the same reference, which is exactly what the check further down counts. A fixture
         * teardown has no business writing to the activity log anyway.
         */
        await Proposal.deleteOne({ _id: cloned.body._id });
      }

      /* ---------------------------------------------------------- retainers --- */
      log.info('Retainers');
      {
        const half = await call(seller, 'POST', '/proposals', {
          title: 'zz-collab-prop half a retainer',
          company: madeClient.body.id,
          retainer: { engagements: 4 },
        });
        const halfData = buildProposalData(await Proposal.findById(half.body._id), {}, {}, {});
        check(
          // One engagement every three months is a one-off with a stray number attached.
          'half a retainer is not a retainer, and prints as nothing',
          halfData.isRetainer === false && halfData.retainer.summary === '',
          JSON.stringify(halfData.retainer)
        );
        await Proposal.deleteOne({ _id: half.body._id });

        const sold = await call(seller, 'POST', '/proposals', {
          title: 'zz-collab-prop retainer',
          company: madeClient.body.id,
          contacts: [madeContact.body.id],
          summary: 'Four tests across the year, sold together.',
          expectedStart: '2026-09-01',
          expectedEnd: '2026-09-11',
          retainer: { engagements: 4, everyMonths: 3 },
        });
        const rid = sold.body?._id;
        check(
          'several engagements can be sold as one agreement',
          sold.status === 201 && sold.body?.retainer?.engagements === 4,
          JSON.stringify([sold.status, sold.body?.retainer])
        );

        const soldData = buildProposalData(await Proposal.findById(rid), {}, {}, {});
        check(
          // A template author should not have to assemble the sentence out of two integers.
          'and the offer can print the sentence rather than the two numbers',
          soldData.isRetainer === true &&
            soldData.retainer.summary === '4 engagements, one every 3 months',
          JSON.stringify(soldData.retainer)
        );

        /* The whole walk again: it is the only way to reach a conversion. */
        await call(seller, 'POST', `/proposals/${rid}/status`, { status: 'evaluating' });
        await call(bob, 'PUT', `/proposals/${rid}/estimate`, { days: 5 });
        await call(bob, 'POST', `/proposals/${rid}/status`, { status: 'evaluated' });
        const paper = await call(seller, 'POST', `/proposals/${rid}/documents/generate`, {
          template: tpl._id.toString(),
        });
        await call(seller, 'POST', `/proposals/${rid}/status`, { status: 'documents-review' });
        await call(boss, 'POST', `/proposals/${rid}/documents/${paper.body.documents[0]._id}/review`, {
          approved: true,
        });
        await call(seller, 'POST', `/proposals/${rid}/status`, { status: 'sent' });
        await call(seller, 'POST', `/proposals/${rid}/status`, {
          status: 'accepted',
          reason: 'relationship',
        });
        const madeJob = await call(bob, 'POST', `/proposals/${rid}/convert`, {});
        const job = await Audits17.findById(madeJob.body?.audit?.id);
        check(
          // Four half-built engagements with nobody booked on them is a surprise; a reminder on
          // the date is the same agreement without the app committing the team.
          'converting a retainer schedules the next one instead of creating them all',
          job?.repeat?.months === 3 && job?.repeat?.nextDue === '2026-12-01',
          JSON.stringify(job?.repeat)
        );
        check(
          'and says which of the four this is',
          (await SalesActivity.countDocuments({
            action: 'proposal.converted',
            'meta.retainer': '1 of 4',
          })) === 1,
          'the conversion did not record the retainer position'
        );

        const oneOff = await Audits17.findById(converted.body?.audit?.id);
        check(
          'while an ordinary proposal still becomes an engagement that repeats never',
          !oneOff?.repeat?.months,
          JSON.stringify(oneOff?.repeat)
        );

        await Audits17.deleteOne({ _id: job._id });
        await Proposal.deleteOne({ _id: rid });
      }

      /* -------------------------------------------------- worth another call --- */
      log.info('Reviving a lost proposal');
      {
        /*
         * Backdated in the database rather than walked to.
         *
         * The flow cannot produce "declined eight months ago" — every route stamps the moment it
         * runs — and the thing under test is the query, not the walk, which the block above already
         * covers end to end. So three fixtures are written directly and the endpoint is asked.
         */
        const eightMonthsAgo = new Date();
        eightMonthsAgo.setMonth(eightMonthsAgo.getMonth() - 8);

        const make = async (title, reason, company) => {
          const raised = await call(seller, 'POST', '/proposals', {
            title,
            company,
            contacts: company === madeClient.body.id ? [madeContact.body.id] : [],
          });
          await Proposal.updateOne(
            { _id: raised.body._id },
            {
              $set: {
                status: 'declined',
                outcome: { reason, competitor: '', note: 'Next year.', at: eightMonthsAgo, by: null },
              },
            }
          );
          return raised.body;
        };

        const other = await call(seller, 'POST', '/sales/clients', {
          name: 'zz-collab-prop Quiet Ltd',
        });
        const budget = await make('zz-collab-prop no budget then', 'budget', other.body.id);
        const price = await make('zz-collab-prop too dear', 'price', other.body.id);
        /* This client is already being talked to again — the proposal above is still live. */
        const talking = await make('zz-collab-prop went quiet', 'no-response', madeClient.body.id);

        const list = await call(seller, 'GET', '/proposals/resurrect?months=6');
        const refs = (list.body?.proposals ?? []).map((row) => row.reference);
        check(
          'a proposal lost on budget eight months ago comes back as a phone call',
          list.status === 200 && refs.includes(budget.reference),
          JSON.stringify([list.status, refs])
        );
        check(
          // "Too expensive" is a verdict on us; "no budget then" is a verdict on the calendar.
          'one lost on price does not, because that answer has not expired',
          !refs.includes(price.reference),
          JSON.stringify(refs)
        );
        check(
          // Appearing here would be noise at best and an awkward phone call at worst.
          'and nor does a client who is already back in the pipeline',
          !refs.includes(talking.reference),
          JSON.stringify(refs)
        );
        check(
          'with the name and address on the row, because the point is to ring somebody',
          (list.body?.proposals ?? []).find((row) => row.reference === budget.reference)?.company ===
            'zz-collab-prop Quiet Ltd',
          JSON.stringify(list.body?.proposals?.[0])
        );
        check(
          'and a longer window asks for older silence than this',
          !((await call(seller, 'GET', '/proposals/resurrect?months=24')).body?.proposals ?? [])
            .map((row) => row.reference)
            .includes(budget.reference),
          'an eight-month-old loss showed up under a two-year window'
        );

        await Proposal.deleteMany({ _id: { $in: [budget._id, price._id, talking._id] } });
        await call(seller, 'DELETE', `/sales/clients/${other.body.id}`);
      }

      /* ------------------------------------------------ the quarter's target --- */
      log.info('Sales targets');
      {
        const mineNow = await call(seller, 'GET', '/proposals/targets');
        check(
          'a salesperson can see their own quarter',
          mineNow.status === 200 && mineNow.body?.team === false && mineNow.body?.mine,
          JSON.stringify([mineNow.status, mineNow.body?.team])
        );
        check(
          // Their wins are real work; hiding them until somebody fills a form in would make the
          // page look like nothing had happened.
          'with no target set yet, and the wins counted anyway',
          mineNow.body?.mine?.target === null && mineNow.body?.mine?.wins >= 1,
          JSON.stringify(mineNow.body?.mine)
        );
        check(
          'a nonsense quarter is refused rather than written',
          (await call(seller, 'GET', '/proposals/targets?quarter=13')).status === 400,
          'quarter 13 was accepted'
        );
        check(
          // A target somebody sets for themselves is a note, not a target.
          'and setting one is not theirs to do',
          (await call(seller, 'PUT', '/proposals/targets', { user: String(seller.user._id), wins: 3 }))
            .status === 403,
          'a salesperson set their own target'
        );

        const set = await call(boss, 'PUT', '/proposals/targets', {
          user: String(seller.user._id),
          wins: 4,
          note: 'Two of these should be retainers.',
        });
        check('a manager sets it', set.status === 200 && set.body?.wins === 4, JSON.stringify(set.body));
        const again = await call(boss, 'PUT', '/proposals/targets', {
          user: String(seller.user._id),
          wins: 6,
        });
        check(
          // "Set the target to six" is one intention whether or not a row exists, and asking the
          // caller to know which is a race against the unique key.
          'and setting it again edits the same row rather than colliding with it',
          again.status === 200 &&
            again.body?.wins === 6 &&
            (await SalesTargets.countDocuments({ user: seller.user._id })) === 1,
          JSON.stringify(again.body)
        );

        const withTarget = await call(seller, 'GET', '/proposals/targets');
        check(
          'the salesperson now sees progress against it',
          withTarget.body?.mine?.target === 6 &&
            withTarget.body?.mine?.percent !== null &&
            withTarget.body?.mine?.remaining === 6 - withTarget.body.mine.wins,
          JSON.stringify(withTarget.body?.mine)
        );

        const teamView = await call(boss, 'GET', '/proposals/targets');
        check(
          'a manager sees the team instead of one line',
          teamView.body?.team === true &&
            (teamView.body?.rows ?? []).some((row) => row.user.id === String(seller.user._id)),
          JSON.stringify((teamView.body?.rows ?? []).map((row) => row.user.username))
        );
        check(
          'with the totals somebody would otherwise add up by hand',
          teamView.body?.totals?.target >= 6 && teamView.body?.totals?.wins >= 1,
          JSON.stringify(teamView.body?.totals)
        );
        check(
          'and the target is logged, because it is a promise about a period',
          (await SalesActivity.countDocuments({ action: 'target.set' })) >= 2,
          'setting a target was not logged'
        );

        /*
         * The date a win counts under. A proposal accepted in one quarter and converted in the next
         * belongs to the quarter the client said yes in, which `updatedAt` cannot express — it moves
         * every time somebody attaches a file.
         */
        const lastQuarter = new Date();
        lastQuarter.setMonth(lastQuarter.getMonth() - 4);
        await Proposal.updateOne(
          { _id: pid },
          { $set: { 'history.$[entry].at': lastQuarter } },
          { arrayFilters: [{ 'entry.to': 'accepted' }] }
        );
        const thisQuarter = await call(seller, 'GET', '/proposals/targets');
        check(
          'a win counts under the quarter the client accepted in, not the one the paperwork caught up in',
          thisQuarter.body?.mine?.wins === 0,
          JSON.stringify(thisQuarter.body?.mine)
        );
        const then = quarterOf(lastQuarter);
        const backThen = await call(
          seller,
          'GET',
          `/proposals/targets?year=${then.year}&quarter=${then.quarter}`
        );
        check(
          'and shows up in that one',
          backThen.body?.mine?.wins === 1,
          JSON.stringify([then, backThen.body?.mine])
        );

        await SalesTargets.deleteMany({ user: seller.user._id });
      }

      /* --------------------------------------------------------- the rate card --- */
      log.info('Pricing, and the floor');
      {
        const settingsDoc = await SettingsModel2.getSettings();
        const salesBefore = settingsDoc.toObject().sales;
        settingsDoc.sales = {
          currency: 'EUR',
          dayRate: 1000,
          floorDayRate: 900,
          maxDiscountPercent: 10,
          taxLabel: 'VAT',
          taxPercent: 19,
          paymentTermsDays: 30,
        };
        settingsDoc.markModified('sales');
        await settingsDoc.save();

        /* A client with its own rate, which must beat the card and lose to the proposal. */
        await call(seller, 'PUT', `/sales/clients/${madeClient.body.id}`, {
          billing: { dayRate: 1100, poRequired: true, invoiceEmail: 'ap@zz-collab-prop.invalid' },
        });

        const raised = await call(seller, 'POST', '/proposals', {
          title: 'zz-collab-prop priced work',
          company: madeClient.body.id,
          contacts: [madeContact.body.id],
          summary: 'Ten days of testing.',
          salesDays: 10,
          source: { kind: 'referral', detail: 'Dana introduced them' },
        });
        const priced = raised.body?._id;
        check(
          'a proposal knows what it is worth without anybody typing a total',
          raised.body?.price?.priced === true &&
            raised.body.price.dayRate === 1100 &&
            raised.body.price.rateFrom === 'client' &&
            raised.body.price.net === 11_000,
          JSON.stringify(raised.body?.price)
        );
        check(
          'with the tax worked out and the total after it',
          raised.body.price.tax === 2090 && raised.body.price.total === 13_090,
          JSON.stringify([raised.body.price.tax, raised.body.price.total])
        );
        check(
          // The client's terms beat the firm's, which is the whole point of putting them on the client.
          'and the client’s own payment terms carried across',
          raised.body.price.paymentTermsDays === 30,
          JSON.stringify(raised.body.price.paymentTermsDays)
        );
        check(
          'the channel it came through is on the record',
          raised.body?.source?.kind === 'referral' && /Dana/.test(raised.body?.source?.detail ?? ''),
          JSON.stringify(raised.body?.source)
        );
        check(
          'and a channel nobody has heard of is refused rather than counted as its own',
          (
            await call(seller, 'POST', '/proposals', {
              title: 'zz-collab-prop bad source',
              company: madeClient.body.id,
              source: { kind: 'a friend of a friend' },
            })
          ).status === 422,
          'an invented source was accepted'
        );

        /* The price the proposal quotes wins over both. */
        const quoted = await call(seller, 'PUT', `/proposals/${priced}/pricing`, { dayRate: 1200 });
        check(
          'a rate on the proposal beats the client’s, which beats the rate card',
          quoted.body?.price?.dayRate === 1200 && quoted.body.price.rateFrom === 'proposal',
          JSON.stringify([quoted.body?.price?.dayRate, quoted.body?.price?.rateFrom])
        );
        check(
          'the effort is not the price’s to set',
          (await call(bob, 'PUT', `/proposals/${priced}/pricing`, { dayRate: 900 })).status === 403,
          'the work side set a price'
        );

        /* ------------------------------------------- the gate, and what opens it -- */
        const cheap = await call(seller, 'PUT', `/proposals/${priced}/pricing`, {
          dayRate: 1200,
          discountPercent: 30,
          note: 'Third job this year.',
        });
        check(
          // 1200 less 30% is 840, under the 900 floor, and 30% is over the 10% cap.
          'a discount past the cap needs signing off, and says why in both halves',
          cheap.body?.price?.belowFloor === true &&
            cheap.body.price.overDiscount === true &&
            cheap.body.price.approvalState === 'pending',
          JSON.stringify(cheap.body?.price)
        );
        check(
          'and until it is, the offer cannot go out',
          (cheap.body?.transitions ?? []).every(
            (entry) => entry.to !== 'sent' || /sign-off|signing off/i.test(entry.problem ?? '')
          ),
          JSON.stringify((cheap.body?.transitions ?? []).map((t) => [t.to, t.problem]))
        );
        check(
          'a salesperson cannot sign off their own discount',
          (await call(seller, 'POST', `/proposals/${priced}/pricing/review`, { approved: true }))
            .status === 403,
          'a salesperson approved their own price'
        );

        const approved = await call(boss, 'POST', `/proposals/${priced}/pricing/review`, {
          approved: true,
          note: 'Fine for a repeat client.',
        });
        check(
          'a manager can',
          approved.body?.price?.approvalState === 'approved' &&
            approved.body.price.approvalOutstanding === false,
          JSON.stringify(approved.body?.price)
        );

        /*
         * The part a careless implementation gets wrong: an approval is for a *price*. Getting 30%
         * signed off and then typing 45% must cost the signature rather than keep it.
         */
        const worse = await call(seller, 'PUT', `/proposals/${priced}/pricing`, {
          dayRate: 1200,
          discountPercent: 45,
        });
        check(
          'and changing the price afterwards costs the signature',
          worse.body?.price?.approvalStale === false &&
            worse.body.price.approvalState === 'pending' &&
            worse.body.price.approvalOutstanding === true,
          JSON.stringify(worse.body?.price)
        );

        const sentBack = await call(boss, 'POST', `/proposals/${priced}/pricing/review`, {
          approved: false,
          note: 'Too far. 20% at most.',
        });
        check(
          'a price can be sent back with a reason',
          sentBack.body?.price?.approvalState === 'rejected',
          JSON.stringify(sentBack.body?.price?.approvalState)
        );

        const inside = await call(seller, 'PUT', `/proposals/${priced}/pricing`, {
          dayRate: 1200,
          discountPercent: 5,
        });
        check(
          // 1200 less 5% is 1140, over the floor, and 5% is inside the cap — so no gate at all.
          'and a price back inside the rules needs no sign-off at all',
          inside.body?.price?.needsApproval === false &&
            inside.body.price.approvalState === 'not-needed' &&
            inside.body.price.approvalOutstanding === false,
          JSON.stringify(inside.body?.price)
        );
        check(
          'there being nothing left to sign off, asking is refused',
          (await call(boss, 'POST', `/proposals/${priced}/pricing/review`, { approved: true }))
            .status === 400,
          'a price inside the rules was signed off anyway'
        );

        /* ------------------------------------------------- and it prints on the offer */
        const forPrint = await Proposal.findById(priced).populate(PROPOSAL_POPULATE2);
        const offer = buildProposalData(forPrint, settingsDoc, {}, {});
        check(
          'the offer can print the figure, already written out',
          offer.isPriced === true &&
            offer.price.netText === '11 400.00 EUR' &&
            offer.price.dayRateText === '1 200.00 EUR',
          JSON.stringify([offer.price.netText, offer.price.dayRateText])
        );
        check(
          'and the client’s VAT number and purchase order, which is how an invoice gets paid',
          offer.billing.invoiceEmail === 'ap@zz-collab-prop.invalid',
          JSON.stringify(offer.billing)
        );

        /* ---------------------------------------------------------- the purchase order */
        const po = await call(seller, 'PUT', `/proposals/${priced}/billing`, { poNumber: '4500123' });
        check(
          'a purchase order can be recorded',
          po.body?.billing?.poNumber === '4500123',
          JSON.stringify(po.body?.billing)
        );

        /* --------------------------------------------------- money on the targets ---- */
        await Proposal.updateOne(
          { _id: priced },
          {
            $set: {
              status: 'accepted',
              history: [{ from: 'sent', to: 'accepted', by: seller.user._id, at: new Date() }],
            },
          }
        );
        const targets = await call(seller, 'GET', '/proposals/targets');
        check(
          'a quarter’s wins can now be counted in money as well as in wins',
          targets.body?.mine?.value === 11_400 && targets.body?.currency === 'EUR',
          JSON.stringify([targets.body?.mine?.value, targets.body?.currency])
        );

        /* ------------------------------------------------------------- invoicing ----- */
        const outstanding = await call(seller, 'GET', '/proposals/invoicing');
        const mineRow = (outstanding.body?.rows ?? []).find((row) => row.reference === raised.body.reference);
        check(
          'won work appears on the invoicing list with what it is worth',
          outstanding.status === 200 && mineRow?.net === 11_400,
          JSON.stringify(mineRow)
        );
        check(
          // The commonest reason an invoice comes back, said before it goes out rather than after.
          'and a client who needs a purchase order is flagged when there is none',
          mineRow?.poRequired === true && mineRow?.blocked === '',
          JSON.stringify([mineRow?.poRequired, mineRow?.blocked])
        );

        await call(seller, 'PUT', `/proposals/${priced}/billing`, { poNumber: '' });
        const blocked = await call(seller, 'GET', '/proposals/invoicing');
        check(
          'with the missing order named as what is stopping it',
          (blocked.body?.rows ?? []).find((row) => row.reference === raised.body.reference)?.blocked ===
            'No purchase order',
          JSON.stringify((blocked.body?.rows ?? []).map((row) => [row.reference, row.blocked]))
        );

        const csv = await call(seller, 'GET', '/proposals/invoicing?format=csv');
        check(
          'the list comes out as a spreadsheet, which is what finance will ask for',
          /^﻿?Reference,Client,Title/.test(csv.text ?? '') &&
            new RegExp(raised.body.reference).test(csv.text ?? ''),
          (csv.text ?? '').slice(0, 120)
        );

        const invoiced = await call(seller, 'PUT', `/proposals/${priced}/billing`, {
          poNumber: '4500123',
          invoiceRef: 'INV-2026-0001',
          invoicedAt: new Date().toISOString(),
        });
        check(
          'marking it invoiced records who and when',
          Boolean(invoiced.body?.billing?.invoicedAt) &&
            String(invoiced.body.billing.invoicedBy) === String(seller.user._id),
          JSON.stringify(invoiced.body?.billing)
        );
        check(
          'and it leaves the outstanding list',
          !((await call(seller, 'GET', '/proposals/invoicing')).body?.rows ?? []).some(
            (row) => row.reference === raised.body.reference
          ),
          'an invoiced proposal was still outstanding'
        );

        /* ------------------------------------------------------- where it came from --- */
        const sources = await call(seller, 'GET', '/proposals/sources?months=12');
        const referrals = (sources.body?.rows ?? []).find((row) => row.source === 'referral');
        check(
          'the channels can be counted, with a win rate of the decisions',
          sources.status === 200 && referrals?.proposals >= 1 && referrals?.won >= 1,
          JSON.stringify(sources.body?.rows)
        );
        check(
          // A tally with a quarter of its rows missing and no sign of it is worse than one that says so.
          'and everything unlabelled is admitted rather than dropped',
          (sources.body?.rows ?? []).some((row) => row.source === 'not recorded'),
          JSON.stringify((sources.body?.rows ?? []).map((row) => row.source))
        );
        check(
          'with what the referrals were worth, now there is a rate card',
          referrals?.wonValue >= 11_400,
          JSON.stringify(referrals)
        );

        /* ------------------------------------------------------------ comparables ---- */
        check(
          'comparing against nothing is refused rather than answered with zeroes',
          (await call(seller, 'GET', '/proposals/comparables')).status === 400,
          'a comparison with no type was accepted'
        );
        const noneYet = await call(seller, 'GET', '/proposals/comparables?auditType=zz-nothing-like-this');
        check(
          'a type nothing has been done in says so plainly',
          noneYet.status === 200 && noneYet.body?.samples === 0,
          JSON.stringify(noneYet.body)
        );

        /*
         * A real comparison needs an engagement with time logged against it, which is exactly the
         * point: an engagement nobody recorded time on cannot tell you what the work took, and is
         * left out rather than counted as zero days.
         */
        const job = await Audits17.create({
          name: 'zz-collab-prop comparable job',
          auditType: 'zz-collab-prop Type',
          daysSold: 5,
          date_start: '2026-01-05',
          date_end: '2026-01-12',
          createdBy: bob.user._id,
        });
        const { TimeEntry: Times2 } = await import('../models/time-entry.model.js');
        await Times2.create([
          { audit: job._id, user: bob.user._id, day: '2026-01-05', hours: 8, note: 'zz' },
          { audit: job._id, user: bob.user._id, day: '2026-01-06', hours: 8, note: 'zz' },
          { audit: job._id, user: bob.user._id, day: '2026-01-07', hours: 8, note: 'zz' },
          { audit: job._id, user: bob.user._id, day: '2026-01-08', hours: 8, note: 'zz' },
          { audit: job._id, user: bob.user._id, day: '2026-01-09', hours: 8, note: 'zz' },
          { audit: job._id, user: bob.user._id, day: '2026-01-12', hours: 8, note: 'zz' },
        ]);
        const compared = await call(seller, 'GET', '/proposals/comparables?auditType=zz-collab-prop%20Type');
        check(
          'what a job of this type actually took, from the time logged against it',
          compared.body?.samples === 1 && compared.body?.actual?.median === 6,
          JSON.stringify(compared.body)
        );
        check(
          // The gap is the useful part: sold as five, took six.
          'against what it was sold as, which is the number somebody is about to type again',
          compared.body?.sold?.median === 5 && compared.body?.gap?.median === 1,
          JSON.stringify([compared.body?.sold, compared.body?.gap])
        );
        check(
          'and no client names in it, because a sales account reads this',
          (compared.body?.rows ?? []).every((row) => !('name' in row) && !('reference' in row)),
          JSON.stringify(compared.body?.rows?.[0])
        );

        await Times2.deleteMany({ audit: job._id });
        await Audits17.deleteOne({ _id: job._id });
        await Proposal.deleteMany({ title: /^zz-collab-prop (priced work|bad source)/ });

        /* The rate card back as it was: this is somebody's real instance. */
        settingsDoc.sales = salesBefore;
        settingsDoc.markModified('sales');
        await settingsDoc.save();
      }

      /* ------------------------------------------------ rows, not whole records --- */
      log.info('What the pipeline list carries');
      {
        /*
         * The list used to answer with `present()` for every proposal: the full summary and
         * constraints, every generated document with its hashes, every comment, the whole status
         * history — four hundred of them, so that opening one needed no request. It grew every time
         * this section gained a feature, which is the part that would not have stopped on its own.
         */
        const list = await call(seller, 'GET', '/proposals');
        const row = (list.body?.proposals ?? []).find((entry) => entry._id === pid);
        check('the list still answers', list.status === 200 && Boolean(row), JSON.stringify(list.status));
        check(
          'with everything the table draws',
          row.reference &&
            row.title &&
            row.status &&
            row.company?.name &&
            typeof row.effortDays === 'number' &&
            typeof row.effortAgreed === 'boolean' &&
            row.updatedAt,
          JSON.stringify(row)
        );
        check(
          // The delete button on a row is disabled while a *live* engagement depends on it, and an
          // engagement in the trash no longer does. Leaving this out made converted proposals
          // undeletable forever — the exact bug that rule was written to fix.
          'including whether the engagement it became is still live',
          row.audit && 'deletedAt' in row.audit,
          JSON.stringify(row.audit)
        );
        check(
          'and none of the record a row does not draw',
          !('documents' in row) &&
            !('comments' in row) &&
            !('history' in row) &&
            !('summary' in row) &&
            !('evaluation' in row),
          Object.keys(row).join(', ')
        );
        check(
          'so a row is a fraction of the size the record is',
          JSON.stringify(row).length * 3 <
            JSON.stringify((await call(seller, 'GET', `/proposals/${pid}`)).body).length,
          `row ${JSON.stringify(row).length} bytes vs record ${
            JSON.stringify((await call(seller, 'GET', `/proposals/${pid}`)).body).length
          }`
        );

        const detail = await call(seller, 'GET', `/proposals/${pid}`);
        check(
          // Which is where everything the row left out has to still be.
          'while the one being read answers in full',
          Array.isArray(detail.body?.documents) &&
            Array.isArray(detail.body?.comments) &&
            Array.isArray(detail.body?.history) &&
            Array.isArray(detail.body?.transitions) &&
            detail.body?.can,
          Object.keys(detail.body ?? {}).join(', ')
        );

        const queue = await call(bob, 'GET', '/proposals/queue');
        check(
          'and the work queue is rows too',
          [...(queue.body?.evaluating ?? []), ...(queue.body?.reviewing ?? [])].every(
            (entry) => !('documents' in entry)
          ),
          'the queue still carries whole records'
        );
      }

      /* ------------------------------------------- the client's own history ---- */
      log.info('The client timeline');
      {
        const timeline = await call(bob, 'GET', `/data/companies/${madeClient.body.id}/timeline`);
        check('a client has a timeline', timeline.status === 200, JSON.stringify(timeline.body).slice(0, 200));
        const kinds = new Set((timeline.body?.events ?? []).map((event) => event.kind));
        check(
          'built from the proposals, what was won, and the engagement it became',
          kinds.has('proposal') && kinds.has('won') && kinds.has('engagement'),
          [...kinds].join(', ')
        );
        check(
          'newest first, which is the only order it is read in',
          (timeline.body?.events ?? []).every(
            (event, index, all) => index === 0 || new Date(all[index - 1].at) >= new Date(event.at)
          ),
          'out of order'
        );
        check(
          'and it names who did what',
          (timeline.body?.events ?? []).some((event) => event.actor),
          JSON.stringify((timeline.body?.events ?? []).slice(0, 3))
        );
      }

      /* ------------------------------------------------- search, over sales ---- */
      const found = await call(seller, 'GET', '/sales/search?q=zz-collab-prop');
      check(
        'sales can search its own things',
        found.status === 200 &&
          (found.body?.results ?? []).some((row) => row.type === 'proposal') &&
          (found.body?.results ?? []).some((row) => row.type === 'salesClient'),
        JSON.stringify((found.body?.results ?? []).map((r) => r.type))
      );
      check(
        // Same shape as /search, so one palette can serve both.
        'in the same shape the engagement search answers in',
        (found.body?.results ?? []).every(
          (row) => row.type && row.title && row.href && row.id
        ),
        JSON.stringify(found.body?.results?.[0])
      );
      check(
        'and a short query asks nothing of the database',
        ((await call(seller, 'GET', '/sales/search?q=a')).body?.results ?? []).length === 0,
        'a one-letter query returned results'
      );

      /* -------------------------------- deleting a proposal, and its paperwork -- */
      const spare = await call(seller, 'POST', '/proposals', {
        title: 'zz-collab-prop spare',
        company: madeClient.body.id,
      });
      const before = await SalesActivity.countDocuments({ action: 'proposal.deleted' });
      /*
       * Counted for this reference *before* the delete as well as after.
       *
       * A reference is the highest one in use plus one, so deleting the newest frees it — and an
       * earlier block in this run that raises and deletes something gets the same string. Asserting
       * "exactly one entry names PRO-2026-906" was really asserting that nothing else in the suite
       * had ever used that number, which stopped being true the moment another block did.
       */
      const refBefore = await SalesActivity.countDocuments({
        action: 'proposal.deleted',
        proposalRef: spare.body.reference,
      });
      const removed = await call(seller, 'DELETE', `/proposals/${spare.body._id}`);
      check('a proposal can be deleted', removed.status === 200, JSON.stringify(removed.body?.error));
      check(
        // The one log entry whose subject is gone, so it carries the reference as text.
        'and the log keeps its reference now that the record is gone',
        (await SalesActivity.countDocuments({
          action: 'proposal.deleted',
          proposalRef: spare.body.reference,
        })) === refBefore + 1 &&
          (await SalesActivity.countDocuments({ action: 'proposal.deleted' })) === before + 1,
        `expected an entry naming ${spare.body.reference}`
      );

      /* ---------------------------------------------------------- tidying up --- */
      /*
       * By what the row points at, not by what its sentence happens to say.
       *
       * Two goes at this leaked. Matching `target` left the contact rows behind, because their
       * target is an email address rather than the prefix; matching `summary` then left the
       * kickoff rows behind, because that sentence names the reference and never the title. The
       * ids and references are what a row actually carries, so they are what to match on.
       */
      const madeRefs = (await Proposal.find({ title: /^zz-collab/ }).select('reference'))
        .map((row) => row.reference)
        .filter(Boolean);
      await SalesActivity.deleteMany({
        $or: [
          { proposal: { $in: (await Proposal.find({ title: /^zz-collab/ }).select('_id')).map((r) => r._id) } },
          ...(madeRefs.length ? [{ proposalRef: { $in: madeRefs } }] : []),
          { summary: /zz-collab/ },
          { target: /^zz-collab/ },
        ],
      });
      await Audits17.deleteMany({ name: /^zz-collab/ });
      /* The record of every document these proposals generated, which the paperwork block creates. */
      const { RenderRecord: Renders2 } = await import('../models/render-record.model.js');
      await Renders2.deleteMany({
        $or: [
          { proposal: { $in: (await Proposal.find({ title: /^zz-collab/ }).select('_id')).map((r) => r._id) } },
          { subject: /zz-collab/ },
        ],
      });
      await Proposal.deleteMany({ title: /^zz-collab/ });
      await Templates.deleteMany({ name: /^zz-collab/ });
      await Contacts.deleteMany({ email: /zz-collab/ });
      await Company.deleteMany({ name: /^zz-collab/ });
      const restore = await SettingsModel2.getSettings();
      restore.firm = firmBefore;
      await restore.save();
    }

  } finally {
    /* ------------------------------------------------------------- teardown */
    if (auditId) {
      const { DeletedFinding: Deleted } = await import('../models/deleted-finding.model.js');
      const { Credential: Creds } = await import('../models/credential.model.js');
      const { Booking: Bookings } = await import('../models/booking.model.js');
      const { TimeEntry: Times } = await import('../models/time-entry.model.js');
      await Bookings.deleteMany({ audit: auditId });
      await Times.deleteMany({ audit: auditId });
      await Deleted.deleteMany({ audit: auditId });
      await Creds.deleteMany({ audit: auditId });
      await Activity.deleteMany({ audit: auditId });
      await Notification.deleteMany({ audit: auditId });
      const { RenderRecord: Renders3 } = await import('../models/render-record.model.js');
      await Renders3.deleteMany({ audit: auditId });
      await Audit.deleteOne({ _id: auditId });
    }
    const { Session: Sessions } = await import('../models/session.model.js');
    // Every throwaway this run made, not just the two named ones: each block that needs a
    // bystander mints another, and naming them here individually is how they got left
    // behind in the users list.
    const throwaway = await User.find({ username: /^zz-collab-/ });
    await Sessions.deleteMany({ user: { $in: throwaway.map((u) => u._id) } });
    const { SalesTarget: Targets } = await import('../models/sales-target.model.js');
    await Targets.deleteMany({ user: { $in: throwaway.map((u) => u._id) } });
    await User.deleteMany({ username: /^zz-collab-/ });
    await new Promise((resolve) => server.close(resolve));
    await disconnectDatabase();
  }

  log.info('');
  if (failed === 0) log.info(`RESULT: ${passed} checks passed`);
  else log.error(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
