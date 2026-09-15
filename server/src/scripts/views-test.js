/**
 * Saved views: whose they are, and what a view is allowed to point at.
 *
 *   npm run test:views
 *
 * A view is a label and a URL, which makes it the smallest feature in the app and one of the two
 * or three with a genuine security question in it. Two, in fact:
 *
 * **Whose.** These are private. Not "private by convention, because the page only ever asks for
 * its own" — private because every query names `req.user`, which is a different thing and the
 * only one that survives somebody guessing an id. An admin has no override here either; which
 * lists a colleague works from is not an administrative matter.
 *
 * **What.** The stored string is rendered as a link in its owner's sidebar, so it is a destination
 * their browser will follow. `//evil.example` looks like a path and is a protocol-relative URL;
 * `javascript:` is not a path at all; `/\evil.example` is a path to one parser and a host to
 * another. None of those can arrive through the app's own control, which sends
 * `location.pathname + location.search` — but the endpoint takes a session and a curl, and the
 * person who eats the consequence is the one whose sidebar it lands in. So the refusals are
 * asserted one by one, because a validator is exactly the kind of code that gets simplified by
 * somebody who cannot see what each clause was for.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import mongoose from 'mongoose';

import { SavedView } from '../models/saved-view.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { signAccessToken } from '../middleware/auth.js';

process.env.VAULT_KEY = process.env.VAULT_KEY || crypto.randomBytes(32).toString('hex');

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

const PORT = 4137;
const APP = `http://127.0.0.1:${PORT}`;
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-views-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const call = async (method, path, body, session) => {
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: {
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
};

const person = async (username) => {
  const user = await User.create({
    username,
    email: `${username}@example.invalid`,
    password: 'ViewsPass123!',
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  return { user, session: signAccessToken(user) };
};

try {
  await Settings.getSettings();

  const ines = await person('views-ines');
  const dana = await person('views-dana');
  const boss = await User.create({
    username: 'views-admin',
    email: 'views-admin@example.invalid',
    password: 'ViewsPass123!',
    role: 'admin',
    roles: ['admin'],
    enabled: true,
    approvedAt: new Date(),
  });
  const bossSession = signAccessToken(boss);

  /* ------------------------------------------------------------------------ */
  console.log('\nSaving a place and getting back to it:');
  {
    const created = await call(
      'POST',
      '/api/views',
      { label: 'In review, mine', href: '/engagements?state=REVIEW&mine=1&sort=-updatedAt' },
      ines.session
    );
    check('a view is saved', created.status === 201, `${created.status} ${created.text.slice(0, 120)}`);
    check(
      '  and the address is split into a path and a query',
      created.body?.path === '/engagements' &&
        created.body?.query === 'state=REVIEW&mine=1&sort=-updatedAt',
      `${created.body?.path} / ${created.body?.query}`
    );
    check(
      '  and handed back as one address again',
      created.body?.href === '/engagements?state=REVIEW&mine=1&sort=-updatedAt',
      created.body?.href
    );

    const list = await call('GET', '/api/views', null, ines.session);
    check('it is in the list', (list.body?.views ?? []).length === 1, JSON.stringify(list.body));

    /*
     * The same address again is a rename, not a second row. The control is a star on a page, and
     * a sidebar with three copies of one list under three names is what turns people off this.
     */
    const again = await call(
      'POST',
      '/api/views',
      { label: 'Waiting on me', href: '/engagements?state=REVIEW&mine=1&sort=-updatedAt' },
      ines.session
    );
    check('saving the same place again renames it', again.status === 200, String(again.status));
    const after = await call('GET', '/api/views', null, ines.session);
    check(
      '  and there is still only one row',
      (after.body?.views ?? []).length === 1 && after.body.views[0].label === 'Waiting on me',
      JSON.stringify(after.body?.views?.map((view) => view.label))
    );

    /* A different query is a different view — that is the whole point of saving the query. */
    const other = await call(
      'POST',
      '/api/views',
      { label: 'Everything in review', href: '/engagements?state=REVIEW' },
      ines.session
    );
    check('a different query is a different view', other.status === 201, String(other.status));

    const fragment = await call(
      'POST',
      '/api/views',
      { label: 'With a fragment', href: '/library?q=xss#somewhere' },
      ines.session
    );
    check(
      'a fragment is dropped, since nothing here routes on one',
      fragment.body?.href === '/library?q=xss',
      fragment.body?.href
    );
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd a view points inside this app, or it is not saved:');
  {
    const REFUSED = [
      ['a protocol-relative URL', '//evil.example/steal'],
      ['a scheme', 'https://evil.example/steal'],
      ['javascript:', 'javascript:alert(document.cookie)'],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['a bare word', 'engagements?state=REVIEW'],
      ['a backslash that some parsers read as a host', '/\\evil.example'],
      ['a newline', '/engagements\n/evil'],
      ['nothing at all', ''],
    ];
    /*
     * 422, not 400. The request schema refuses these before the route sees them and `validate`
     * answers unprocessable — which is not the answer the ceiling below gives, that one being a
     * rule about this account rather than about the shape of what was sent.
     *
     * And which of the two walls refused it is asserted, not just that something did. Both walls
     * answer 422 through the same error handler, so a check on the status alone passes whichever
     * one is standing: removing the route's `//` clause entirely left this suite green, because
     * the model caught it on the way to the database. That is the right behaviour and the wrong
     * test. The two name different fields — `href` is what the request carried, `path` is what
     * the document would have stored — so the field in the refusal says which wall it hit.
     */
    for (const [why, href] of REFUSED) {
      const response = await call('POST', '/api/views', { label: 'Nope', href }, ines.session);
      const fields = (response.body?.details ?? []).map((detail) => detail.field);
      check(
        `${why} is refused`,
        response.status === 422,
        `${response.status} for ${JSON.stringify(href)}`
      );
      check(
        `  by the request validator, before it is a document`,
        fields.includes('href'),
        `refused on ${fields.join(', ') || 'nothing named'} — the model caught it, the route did not`
      );
    }

    const stored = await SavedView.countDocuments({ user: ines.user._id });
    check('and none of them reached the database', stored === 3, `${stored} rows`);

    /* The model refuses it too, so a future route that forgets is still walled. */
    let modelRefused = false;
    try {
      await SavedView.create({ user: ines.user._id, label: 'Direct', path: '//evil.example' });
    } catch {
      modelRefused = true;
    }
    check('the model refuses it as well as the route', modelRefused, 'the model accepted it');
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nThey are one person’s, including from an admin:');
  {
    const mine = await call('GET', '/api/views', null, ines.session);
    const theirs = await call('GET', '/api/views', null, dana.session);
    check('somebody else sees none of them', (theirs.body?.views ?? []).length === 0, JSON.stringify(theirs.body));

    const id = mine.body.views[0]._id;
    const stolenRead = await call('PUT', `/api/views/${id}`, { label: 'Mine now' }, dana.session);
    check('and cannot rename one by its id', stolenRead.status === 404, String(stolenRead.status));
    const stolenDelete = await call('DELETE', `/api/views/${id}`, null, dana.session);
    check('  or delete one', stolenDelete.status === 404, String(stolenDelete.status));

    /*
     * An admin has every other override in this app and deliberately not this one. Which lists a
     * colleague works from is not an administrative question.
     */
    const asAdmin = await call('GET', '/api/views', null, bossSession);
    check('an admin sees their own, not everybody’s', (asAdmin.body?.views ?? []).length === 0, JSON.stringify(asAdmin.body));
    const adminDelete = await call('DELETE', `/api/views/${id}`, null, bossSession);
    check('  and cannot delete somebody else’s', adminDelete.status === 404, String(adminDelete.status));

    const survived = await call('GET', '/api/views', null, ines.session);
    check('  so it is still there', (survived.body?.views ?? []).length === 3, JSON.stringify(survived.body?.views?.length));
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nRenaming, removing, and the ceiling:');
  {
    const list = await call('GET', '/api/views', null, ines.session);
    const first = list.body.views[0];
    const renamed = await call('PUT', `/api/views/${first._id}`, { label: 'Renamed' }, ines.session);
    check('a view can be renamed', renamed.body?.label === 'Renamed', renamed.body?.label);
    check(
      '  and still points where it did',
      renamed.body?.href === first.href,
      `${renamed.body?.href} vs ${first.href}`
    );

    const removed = await call('DELETE', `/api/views/${first._id}`, null, ines.session);
    check('and can be removed', removed.status === 200, String(removed.status));
    const left = await call('GET', '/api/views', null, ines.session);
    check('  leaving the others', (left.body?.views ?? []).length === 2, String(left.body?.views?.length));

    /*
     * The cap is about the sidebar, not about storage. A list long enough to scroll past is a list
     * nobody reads, and hitting the ceiling should say so rather than quietly accepting the
     * thirty-first and drawing a sidebar nobody can use.
     */
    let last = null;
    for (let index = 0; index < 40; index += 1) {
      last = await call(
        'POST',
        '/api/views',
        { label: `View ${index}`, href: `/library?q=needle-${index}` },
        ines.session
      );
      if (last.status === 400) break;
    }
    check('there is a ceiling, and it says so', last?.status === 400, String(last?.status));
    check(
      '  and it names the number rather than just refusing',
      /\d+ views/.test(last?.body?.error ?? last?.text ?? ''),
      (last?.body?.error ?? last?.text ?? '').slice(0, 120)
    );
    const total = await SavedView.countDocuments({ user: ines.user._id });
    check('  and nothing past it was written', total === 30, `${total} rows`);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nAnd none of it is reachable without a session:');
  {
    const anonymous = await call('GET', '/api/views', null, null);
    check('the list needs one', anonymous.status === 401, String(anonymous.status));
    const write = await call('POST', '/api/views', { label: 'x', href: '/library?q=x' }, null);
    check('and so does saving', write.status === 401, String(write.status));
  }
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  the suite itself stopped — ${error.stack}`);
} finally {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
