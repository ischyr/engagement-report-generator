import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { User, ROLES, WORKING_ROLES } from '../models/user.model.js';
import { Audit } from '../models/audit.model.js';
import { Booking } from '../models/booking.model.js';
import { TimeEntry, HOURS_PER_DAY } from '../models/time-entry.model.js';
import { Leave } from '../models/leave.model.js';
import { leaveDayMap, availableDaysFor } from '../services/leave.service.js';
import asyncHandler from '../utils/async-handler.js';
import { badRequest, forbidden, notFound } from '../utils/http-error.js';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/auth.js';
import { disableTotp } from '../services/mfa.service.js';
import { issueAccountToken } from '../services/account-tokens.service.js';
import { pendingAccounts, setApproval } from '../services/account-approval.service.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Utilisation                                                                */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const dayString = (date) => date.toISOString().slice(0, 10);

/**
 * The window utilisation is measured over, as `yyyy-mm-dd` strings.
 *
 * Bookings are stored as day strings — a booking is a day, not an instant — so the window
 * is expressed the same way rather than converting either side into a timestamp and
 * inheriting a timezone.
 */
function utilisationWindow(days) {
  const span = Math.min(Math.max(Number(days) || 90, 7), 730);
  const end = new Date();
  const start = new Date(end.getTime() - (span - 1) * DAY_MS);
  return { from: dayString(start), to: dayString(end), days: span };
}

/**
 * Weekdays in the window — the raw denominator, before anybody's leave comes off it.
 *
 * Mon–Fri. Leave *is* recorded now, so the per-person denominator is this minus that
 * person's approved holiday and the public holidays everybody gets: a fortnight in August
 * used to count as capacity somebody had, which is a percentage measured against days that
 * did not exist. Part-time contracts are still not modelled, and the page says what the
 * denominator is rather than implying it accounts for everything.
 */
function workingDaysBetween(from, to) {
  let count = 0;
  for (let at = new Date(`${from}T00:00:00Z`); dayString(at) <= to; at = new Date(at.getTime() + DAY_MS)) {
    const weekday = at.getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/**
 * The distinct days a person is booked inside the window, and how many of those they are
 * booked twice.
 *
 * Days rather than a sum of booking lengths: two engagements on one day is one day of that
 * person's life, and adding the bookings up would report 200% utilisation for somebody who
 * simply has a clash. The clash is worth knowing, so it is counted separately.
 */
function bookedDaysFor(bookings, from, to) {
  const perDay = new Map();
  for (const booking of bookings) {
    const start = booking.start > from ? booking.start : from;
    const end = booking.end < to ? booking.end : to;
    if (start > end) continue;
    for (let at = new Date(`${start}T00:00:00Z`); dayString(at) <= end; at = new Date(at.getTime() + DAY_MS)) {
      const key = dayString(at);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
  }
  let clashDays = 0;
  for (const count of perDay.values()) if (count > 1) clashDays += 1;
  return { days: perDay.size, clashDays };
}

/**
 * Every authenticated user can list colleagues — needed to pick collaborators.
 *
 * `?active=true` narrows it to people who could be put on a job: enabled, approved, and
 * holding a role that reaches engagements. Every picker in the app wants that rather than
 * the whole list, because offering a name that cannot open the engagement is how work gets
 * assigned to nobody. The plain list still returns everybody, because the admin page has
 * to show the accounts that are waiting, switched off, or in a different job entirely —
 * those are exactly what it is for.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = {};
    // `?enabled=true` was already being sent by parts of the client and silently ignored.
    if (req.query.active === 'true') {
      /*
       * "Somebody you could put on this job", which is what all five callers are asking:
       * signed-in-capable, and holding a role that reaches engagements at all. A sales
       * account passes the first test and fails the second, and offering one as a
       * collaborator would assign work to somebody the API will not let near it.
       */
      Object.assign(filter, {
        enabled: true,
        approvedAt: { $ne: null },
        // Matches array membership: an account holding any working role is somebody you
        // could put on a job.
        roles: { $in: WORKING_ROLES },
      });
    } else if (req.query.enabled === 'true') filter.enabled = true;

    const users = await User.find(filter).sort({ username: 1 });
    res.json(users.map((u) => u.toPublic()));
  })
);

/**
 * Who is waiting to be let in.
 *
 * Its own route rather than a filter over the list, because it is a queue with a
 * different question behind it — not "who works here" but "what have I not decided
 * yet". Admin-only: it is a list of people who have proved a password and nothing more,
 * and the rest of the team has no use for it.
 *
 * Declared before the parameterised routes, or Express reads "pending" as an id.
 */
router.get(
  '/pending',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const waiting = await pendingAccounts();
    res.json({ waiting, count: waiting.length });
  })
);

/* -------------------------------------------------------------------------- */
/* Skills and experience                                                      */
/* -------------------------------------------------------------------------- */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY, 'Use a yyyy-mm-dd date').or(z.literal(''));

const profileSchema = z.object({
  headline: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(1500).optional(),
  yearsExperience: z.number().int().min(0).max(60).nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  skills: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Name the skill').max(60),
        level: z.enum(['learning', 'working', 'strong', 'expert']).optional().default('working'),
      })
    )
    .max(60)
    .optional(),
  certifications: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Name the certification').max(80),
        issuer: z.string().trim().max(80).optional().default(''),
        obtainedAt: day.optional().default(''),
        expiresAt: day.optional().default(''),
      })
    )
    .max(40)
    .optional(),
});

/** What the page shows about one person. Never the account's own security fields. */
/** Four steps, in order, so "strongest first" means the same thing everywhere. */
const LEVEL_RANK = { learning: 1, working: 2, strong: 3, expert: 4 };

const profileOf = (user) => ({
  id: user._id.toString(),
  username: user.username,
  fullname: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
  firstname: user.firstname,
  lastname: user.lastname,
  title: user.title,
  role: user.role,
  roles: user.roles ?? [],
  enabled: user.enabled !== false,
  headline: user.profile?.headline ?? '',
  bio: user.profile?.bio ?? '',
  yearsExperience: user.profile?.yearsExperience ?? null,
  languages: user.profile?.languages ?? [],
  skills: user.profile?.skills ?? [],
  certifications: user.profile?.certifications ?? [],
});

/**
 * Who can do what.
 *
 * Readable by anyone signed in, on purpose: "who has done Android work" is a question a
 * tester asks as often as a lead does, and an app that keeps the answer in the admin zone
 * leaves it where it was — in somebody's head.
 *
 * Declared before the parameterised routes below, or Express reads "skills" as an id.
 */
router.get(
  '/skills',
  asyncHandler(async (_req, res) => {
    const users = await User.find({
      enabled: true,
      approvedAt: { $ne: null },
      roles: { $in: WORKING_ROLES },
    }).sort({ username: 1 });
    const people = users.map(profileOf);

    /*
     * Every distinct skill, with who holds it and at what level.
     *
     * Grouped case-insensitively but shown as it was first written: "Burp Suite" and "burp
     * suite" are one skill and neither spelling is more correct than the other.
     *
     * The level breakdown is here rather than in the page because it is what turns a list of
     * skills into something to act on: two people who are *learning* Kubernetes and nobody
     * who can run it is a different fact from two people who can, and a count of "2" says
     * neither.
     */
    const tally = new Map();
    for (const person of people) {
      for (const skill of person.skills) {
        const key = skill.name.toLowerCase();
        const entry =
          tally.get(key) ??
          { name: skill.name, people: 0, levels: { learning: 0, working: 0, strong: 0, expert: 0 }, holders: [] };
        entry.people += 1;
        if (entry.levels[skill.level] !== undefined) entry.levels[skill.level] += 1;
        entry.holders.push({ id: person.id, fullname: person.fullname, level: skill.level });
        tally.set(key, entry);
      }
    }

    const skills = [...tally.values()]
      .map((skill) => ({
        ...skill,
        /** People who could be given the work today, rather than taught it. */
        depth: skill.levels.strong + skill.levels.expert,
        holders: skill.holders.sort(
          (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.fullname.localeCompare(b.fullname)
        ),
      }))
      .sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));

    /*
     * Where the team is one deep.
     *
     * The question this page exists for is not "what can we do" but "what happens if one
     * person is unavailable" — and that answer was previously only obtainable by reading
     * every profile and holding twelve of them in your head. A skill exactly one person can
     * carry is a plan with a single point of failure in it; a skill nobody holds above
     * *learning* is one the team cannot currently sell.
     */
    const oneDeep = skills
      .filter((skill) => skill.depth === 1)
      .map((skill) => ({
        name: skill.name,
        person: skill.holders.find((holder) => holder.level === 'expert' || holder.level === 'strong'),
        learners: skill.levels.learning + skill.levels.working,
      }));
    const noneDeep = skills
      .filter((skill) => skill.depth === 0)
      .map((skill) => ({ name: skill.name, people: skill.people }));

    /** Languages, for the question "who can run the workshop in Romanian". */
    const languageTally = new Map();
    for (const person of people) {
      for (const language of person.languages) {
        const key = language.trim().toLowerCase();
        if (!key) continue;
        const entry = languageTally.get(key) ?? { name: language.trim(), people: 0 };
        entry.people += 1;
        languageTally.set(key, entry);
      }
    }

    /*
     * Certifications counted by where they stand, not just how many there are.
     *
     * `expiring` is the number worth putting on a page: a certification that lapsed is a
     * fact, one that lapses in eleven weeks is a decision somebody has to make now. Ninety
     * days, because that is roughly how long a re-sit takes to arrange.
     */
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const certifications = { total: 0, valid: 0, expiring: 0, expired: 0, undated: 0 };
    const issuers = new Map();
    for (const person of people) {
      for (const entry of person.certifications) {
        certifications.total += 1;
        if (!entry.expiresAt) certifications.undated += 1;
        else if (entry.expiresAt < today) certifications.expired += 1;
        else if (entry.expiresAt <= horizon) certifications.expiring += 1;
        else certifications.valid += 1;

        const key = (entry.issuer || 'Unattributed').trim().toLowerCase();
        const issuer = issuers.get(key) ?? { name: (entry.issuer || 'Unattributed').trim(), held: 0 };
        issuer.held += 1;
        issuers.set(key, issuer);
      }
    }

    const years = people
      .map((person) => person.yearsExperience)
      .filter((value) => typeof value === 'number');

    res.json({
      people,
      skills,
      /** Everything a page would otherwise have to derive by reading every profile twice. */
      coverage: {
        people: people.length,
        /** Anybody who has written down anything at all — the rest is a gap, not a person. */
        recorded: people.filter(
          (person) =>
            person.skills.length + person.certifications.length > 0 || Boolean(person.headline)
        ).length,
        distinctSkills: skills.length,
        /** Skill-holdings, not skills: the total size of what the team has written down. */
        holdings: skills.reduce((sum, skill) => sum + skill.people, 0),
        experts: skills.reduce((sum, skill) => sum + skill.levels.expert, 0),
        oneDeep,
        noneDeep,
        languages: [...languageTally.values()].sort(
          (a, b) => b.people - a.people || a.name.localeCompare(b.name)
        ),
        certifications,
        issuers: [...issuers.values()].sort((a, b) => b.held - a.held || a.name.localeCompare(b.name)),
        /** Median, not mean: one twenty-year veteran should not make a young team look old. */
        medianYears: years.length
          ? [...years].sort((a, b) => a - b)[Math.floor(years.length / 2)]
          : null,
      },
    });
  })
);

/** One person's, for the form that edits it. */
router.get(
  '/:id/profile',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');
    res.json(profileOf(user));
  })
);

/**
 * Yours, or anybody's if you are an admin.
 *
 * Deliberately not `requireRole('admin')` on the whole route: a skills record nobody can
 * maintain themselves is a skills record that goes stale, and the person who knows what
 * they can do is the person doing it.
 */
router.put(
  '/:id/profile',
  validate(profileSchema),
  asyncHandler(async (req, res) => {
    if (req.user.role === 'readonly') throw forbidden('Your account is read-only');
    const isSelf = String(req.params.id) === String(req.user._id);
    if (!isSelf && req.user.role !== 'admin') {
      throw forbidden('You can only edit your own skills. An admin can edit anybody\'s.');
    }

    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');

    user.profile = { ...(user.profile?.toObject?.() ?? user.profile ?? {}), ...req.body };
    await user.save({ validateBeforeSave: false });
    res.json(profileOf(user));
  })
);

/**
 * Who is on which engagement, and how much of it each person wrote.
 *
 * Admin-only, and deliberately the one view that ignores engagement membership:
 * answering "who is working on what" is the point, so it reads every engagement.
 * Declared before the parameterised routes below — Express matches in order.
 *
 * Findings are attributed by `createdBy`, which only exists on findings written
 * since authorship was recorded, so the unattributed count is reported rather than
 * folded silently into somebody's total.
 */
router.get(
  '/engagements',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const window = utilisationWindow(req.query.days);
    const [users, audits, bookings, timeEntries, leave] = await Promise.all([
      User.find().sort({ username: 1 }),
      Audit.find({ deletedAt: null })
        .select(
          'name reference state company creator collaborators reviewers ' +
            'findings.createdBy findings.createdAt testChecks.doneBy updatedAt'
        )
        .populate({ path: 'company', select: 'name' })
        .sort({ updatedAt: -1 }),
      // Overlapping the window, not beginning in it: a booking that started before it and
      // runs through counts for the days that fall inside.
      Booking.find({ end: { $gte: window.from }, start: { $lte: window.to } }).select(
        'user audit start end'
      ),
      // A time entry is a single day, so a plain range on `day` is the whole story —
      // unlike a booking, which can straddle the window.
      TimeEntry.find({ day: { $gte: window.from, $lte: window.to } }).select('user audit day hours'),
      // Approved only: a request nobody has answered is not yet a day off, and counting it
      // would quietly flatter the utilisation of anybody with a pending fortnight.
      Leave.find({
        status: 'approved',
        end: { $gte: window.from },
        start: { $lte: window.to },
      }).select('user start end type portion status'),
    ]);

    const idOf = (value) => String(value?._id ?? value ?? '');

    /*
     * Hours logged in the window, grouped two ways before anything is built: by engagement
     * for the engagement rows, and by person-and-engagement for the rows that expand under
     * a person. Quarter-hours are summed as quarters and rounded once at the end, because
     * accumulating 0.25 in floating point and printing it raw shows 7.249999999999999.
     */
    const loggedByAudit = new Map();
    const loggedByUser = new Map();
    const loggedByUserAudit = new Map();
    const loggedDaysByUser = new Map();
    for (const entry of timeEntries) {
      const auditId = idOf(entry.audit);
      const userId = idOf(entry.user);
      loggedByAudit.set(auditId, (loggedByAudit.get(auditId) ?? 0) + entry.hours);
      loggedByUser.set(userId, (loggedByUser.get(userId) ?? 0) + entry.hours);
      loggedByUserAudit.set(
        `${userId}:${auditId}`,
        (loggedByUserAudit.get(`${userId}:${auditId}`) ?? 0) + entry.hours
      );
      if (!loggedDaysByUser.has(userId)) loggedDaysByUser.set(userId, new Set());
      loggedDaysByUser.get(userId).add(entry.day);
    }
    const quarters = (value) => Math.round((value ?? 0) * 4) / 4;

    /** Per user: { engagements: [...], findings, checks }. */
    const byUser = new Map(
      users.map((user) => [
        user._id.toString(),
        {
          id: user._id.toString(),
          username: user.username,
          fullname: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
          email: user.email,
          role: user.role,
          enabled: user.enabled !== false,
          lastSeenAt: user.lastSeenAt ?? null,
          engagements: [],
          findingsCreated: 0,
          checksVerified: 0,
          /** Written inside the window, so it can be divided by days booked in it. */
          findingsInWindow: 0,
        },
      ])
    );

    let unattributedFindings = 0;
    let totalFindings = 0;

    const engagements = audits.map((audit) => {
      // How many findings each person wrote up in this engagement.
      const authored = new Map();
      for (const finding of audit.findings ?? []) {
        totalFindings += 1;
        const author = idOf(finding.createdBy);
        if (!author) {
          unattributedFindings += 1;
          continue;
        }
        authored.set(author, (authored.get(author) ?? 0) + 1);

        // Findings written *in the window*. The all-time total below is the wrong
        // numerator for a rate: dividing a career's findings by 90 days of bookings
        // would produce a number that means nothing.
        const writtenOn = finding.createdAt ? dayString(new Date(finding.createdAt)) : null;
        if (writtenOn && writtenOn >= window.from && writtenOn <= window.to) {
          const person = byUser.get(author);
          if (person) person.findingsInWindow += 1;
        }
      }

      const verified = new Map();
      for (const check of audit.testChecks ?? []) {
        const who = idOf(check.doneBy);
        if (!who) continue;
        verified.set(who, (verified.get(who) ?? 0) + 1);
      }

      /** Everyone attached to this engagement, with every role they hold on it. */
      const roles = new Map();
      const note = (value, role) => {
        const id = idOf(value);
        if (!id) return;
        if (!roles.has(id)) roles.set(id, new Set());
        roles.get(id).add(role);
      };
      note(audit.creator, 'creator');
      for (const entry of audit.collaborators ?? []) note(entry, 'collaborator');
      for (const entry of audit.reviewers ?? []) note(entry, 'reviewer');

      const members = [];
      for (const [id, held] of roles) {
        const user = byUser.get(id);
        const member = {
          id,
          // A deleted account can still be referenced by an engagement.
          fullname: user?.fullname ?? 'Removed account',
          username: user?.username ?? null,
          roles: [...held],
          findingsCreated: authored.get(id) ?? 0,
          checksVerified: verified.get(id) ?? 0,
        };
        members.push(member);

        if (user) {
          user.engagements.push({
            id: audit._id.toString(),
            name: audit.name,
            reference: audit.reference ?? '',
            company: audit.company?.name ?? '',
            state: audit.state,
            roles: member.roles,
            findingsCreated: member.findingsCreated,
            checksVerified: member.checksVerified,
            updatedAt: audit.updatedAt,
          });
          user.findingsCreated += member.findingsCreated;
          user.checksVerified += member.checksVerified;
        }
      }

      // Findings written by somebody no longer attached to the engagement still
      // count as work done, so they are not lost from the per-person totals.
      for (const [id, count] of authored) {
        if (roles.has(id)) continue;
        const user = byUser.get(id);
        if (!user) continue;
        user.engagements.push({
          id: audit._id.toString(),
          name: audit.name,
          reference: audit.reference ?? '',
          company: audit.company?.name ?? '',
          state: audit.state,
          roles: ['former'],
          findingsCreated: count,
          checksVerified: verified.get(id) ?? 0,
          updatedAt: audit.updatedAt,
        });
        user.findingsCreated += count;
      }

      return {
        id: audit._id.toString(),
        name: audit.name,
        reference: audit.reference ?? '',
        company: audit.company?.name ?? '',
        state: audit.state,
        findingCount: (audit.findings ?? []).length,
        /** What it has taken so far, inside the window. */
        loggedHours: quarters(loggedByAudit.get(audit._id.toString())),
        updatedAt: audit.updatedAt,
        members: members.sort(
          (a, b) => b.findingsCreated - a.findingsCreated || a.fullname.localeCompare(b.fullname)
        ),
      };
    });

    /* ----------------------------------------------------------- utilisation */
    const workingDays = workingDaysBetween(window.from, window.to);
    /*
     * One resolution of the leave for the whole window, shared by everybody: public
     * holidays belong to no user and have to be applied to all of them, and somebody's own
     * holiday landing on a public holiday must cost the day once, not twice.
     */
    const dayMap = leaveDayMap(leave, window.from, window.to);
    const bookingsByUser = new Map();
    for (const booking of bookings) {
      const id = idOf(booking.user);
      if (!bookingsByUser.has(id)) bookingsByUser.set(id, []);
      bookingsByUser.get(id).push(booking);
    }

    let bookedDaysTotal = 0;
    for (const [id, person] of byUser) {
      const theirs = bookingsByUser.get(id) ?? [];
      const { days, clashDays } = bookedDaysFor(theirs, window.from, window.to);
      /*
       * The days this person actually had. Somebody who took two of four weeks off and was
       * booked for the other two is fully utilised, and used to read as 50% — a number that
       * makes a busy colleague look idle and an idle one look busy.
       */
      const { available, off } = availableDaysFor(id, window.from, window.to, dayMap);
      person.away = { days: off, workingDays: available };
      person.booked = {
        days,
        clashDays,
        engagements: new Set(theirs.map((booking) => idOf(booking.audit))).size,
        /**
         * Share of the days they were available, not of the calendar's weekdays. Over 100%
         * is still possible and still worth seeing — now it means overbooked rather than
         * "was here on a public holiday".
         */
        utilisation: available ? Math.round((days / available) * 100) : 0,
        /** Kept so a reader can tell a small denominator from a large numerator. */
        availableDays: available,
        daysOff: off,
        /**
         * Findings per booked day, to one decimal. Null rather than zero when nothing is
         * booked: "no rate" and "a rate of nothing" are different answers, and a column
         * of 0.0 for people with no bookings reads as poor performance.
         */
        findingsPerDay: days ? Math.round((person.findingsInWindow / days) * 10) / 10 : null,
      };
      bookedDaysTotal += days;

      /*
       * What the work actually took, beside what was planned.
       *
       * `hoursPerBookedDay` is the honest version of "was the estimate right": a person
       * booked five days who logged fifty hours did not have a five-day week. Null when
       * nothing is booked, for the same reason `findingsPerDay` is — a ratio against a
       * denominator of zero is not a low number, it is no number.
       */
      const loggedHours = quarters(loggedByUser.get(id));
      const loggedDays = loggedDaysByUser.get(id)?.size ?? 0;
      person.logged = {
        hours: loggedHours,
        /** Calendar days that carry any time at all — not hours divided by a day length. */
        days: loggedDays,
        /** The same hours expressed the way work gets quoted. */
        effortDays: Math.round((loggedHours / HOURS_PER_DAY) * 10) / 10,
        hoursPerBookedDay: days ? Math.round((loggedHours / days) * 10) / 10 : null,
      };

      /*
       * Days booked per engagement, for the row that expands underneath a person.
       *
       * Grouped and counted as a set, not summed per booking: two overlapping bookings on
       * the same engagement are still those days, and adding them made the expanded rows
       * total more than the person's own figure — which reads as a bug in the headline.
       */
      const perAudit = new Map();
      for (const booking of theirs) {
        const auditId = idOf(booking.audit);
        if (!perAudit.has(auditId)) perAudit.set(auditId, []);
        perAudit.get(auditId).push(booking);
      }
      for (const [auditId, group] of perAudit) {
        perAudit.set(auditId, bookedDaysFor(group, window.from, window.to).days);
      }
      for (const engagement of person.engagements) {
        engagement.bookedDays = perAudit.get(engagement.id) ?? 0;
        engagement.loggedHours = quarters(loggedByUserAudit.get(`${id}:${engagement.id}`));
      }
    }

    const people = [...byUser.values()].sort(
      (a, b) =>
        b.engagements.length - a.engagements.length ||
        b.findingsCreated - a.findingsCreated ||
        a.fullname.localeCompare(b.fullname)
    );

    res.json({
      /** What the utilisation columns are measured over, so the page can say it. */
      window: {
        ...window,
        workingDays,
        /** Public holidays inside the window — everybody's, so they belong to the window. */
        publicHolidayDays: (dayMap.get('*')?.size ?? 0),
        bookedDays: bookedDaysTotal,
        loggedHours: quarters(timeEntries.reduce((sum, entry) => sum + entry.hours, 0)),
        hoursPerDay: HOURS_PER_DAY,
      },
      users: people,
      engagements,
      totals: {
        users: people.length,
        idle: people.filter((person) => person.engagements.length === 0).length,
        engagements: engagements.length,
        findings: totalFindings,
        /** Written before authorship was recorded, so attributable to nobody. */
        unattributedFindings,
      },
    });
  })
);

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore only'),
  email: z.string().trim().toLowerCase().email(),
  /**
   * Optional now.
   *
   * Left out, the account is created without a usable password and an invitation link comes
   * back instead — which is the better default: an admin choosing somebody's password means the
   * first password an account ever has is one its owner did not pick and somebody else knows.
   * Still accepted, because an instance with no way to pass a link around needs a way in.
   */
  password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  firstname: z.string().trim().max(80).optional().default(''),
  lastname: z.string().trim().max(80).optional().default(''),
  role: z.enum(ROLES).optional().default('user'),
  /** More than one, for an account that both tests and signs things off. */
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  phone: z.string().trim().max(40).optional().default(''),
  title: z.string().trim().max(80).optional().default(''),
});

router.post(
  '/',
  requireRole('admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { password, ...rest } = req.body;

    /*
     * An account with no password chosen yet.
     *
     * The field is required by the schema, so an unguessable random one is stored to satisfy it
     * and immediately made unreachable: the invitation sets a real one, and nothing else can,
     * because nobody — including this process after the next line — knows what was written.
     */
    const user = await User.create({
      ...rest,
      password: password ?? crypto.randomBytes(32).toString('base64url'),
      totpEnrolmentRequired: true,
      /*
       * Approved on creation. An admin filling in this form *is* the decision — sending
       * what they just typed to a queue for themselves to approve would be a second
       * button that can only ever be pressed one way.
       */
      approvedAt: new Date(),
      approvedBy: req.user._id,
    });

    const invitation = password
      ? null
      : await issueAccountToken({
          user,
          purpose: 'invite',
          issuedBy: req.user,
          ip: req.ip,
        });

    res.status(201).json({
      ...user.toPublic(),
      /** Handed back once, to whoever asked for it. It is not stored anywhere readable. */
      invitation: invitation
        ? { path: invitation.path, token: invitation.token, expiresAt: invitation.expiresAt }
        : null,
    });
  })
);

/**
 * A fresh link for somebody who cannot get in.
 *
 * Admin-only and handed straight back rather than emailed — there is no SMTP in this app, and
 * pretending otherwise would mean an account recovery that silently goes nowhere. The admin
 * passes the URL through whatever channel the firm already trusts.
 *
 * Issuing one invalidates any earlier link for that account: "I sent it again" should mean the
 * first one is dead.
 */
router.post(
  '/:id/reset-link',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');
    if (user.enabled === false) {
      throw badRequest('That account is disabled. Enable it first, or it cannot be signed in to.');
    }
    // A link that sets a password an account still cannot use with is a link that looks
    // like access and is not. Say which button is actually wanted.
    if (!user.approvedAt) {
      throw badRequest('That account is waiting for approval. Approve it first, then send a link.');
    }

    const link = await issueAccountToken({
      user,
      purpose: 'reset',
      issuedBy: req.user,
      ip: req.ip,
    });
    res.json({
      path: link.path,
      token: link.token,
      expiresAt: link.expiresAt,
      username: user.username,
    });
  })
);

/**
 * Lets somebody in, or takes it back.
 *
 * One route in both directions rather than an approve and a separate unapprove: it is a
 * single fact about the account, and two endpoints that set the same field is how the
 * two of them end up doing subtly different things.
 *
 * Refusing an account outright is `DELETE /users/:id` and always was — a registration
 * an admin does not recognise should not sit in a list forever, and deleting it frees
 * the username and email for whoever legitimately wanted them.
 */
router.post(
  '/:id/approval',
  requireRole('admin'),
  validate(z.object({ approved: z.boolean() })),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw notFound('User not found');

    // Nobody locks themselves out of the instance they administer.
    if (user._id.equals(req.user._id) && !req.body.approved) {
      throw badRequest('You cannot withdraw approval for your own account');
    }
    if (!req.body.approved && user.role === 'admin') {
      const remaining = await User.countDocuments({
        roles: 'admin',
        enabled: true,
        approvedAt: { $ne: null },
        _id: { $ne: user._id },
      });
      if (remaining === 0) throw badRequest('At least one approved admin account must remain');
    }

    const { changed } = await setApproval(user, req.body.approved, req.user);
    res.json({ ...user.toPublic(), changed });
  })
);

const updateSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  firstname: z.string().trim().max(80).optional(),
  lastname: z.string().trim().max(80).optional(),
  /** The primary, still accepted on its own — see the virtual on the model. */
  role: z.enum(ROLES).optional(),
  /** Or the whole set, which is what the Users page sends now. */
  roles: z.array(z.enum(ROLES)).min(1, 'An account needs at least one role').optional(),
  phone: z.string().trim().max(40).optional(),
  title: z.string().trim().max(80).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

router.put(
  '/:id',
  requireRole('admin'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('+password');
    if (!user) throw notFound('User not found');

    const isSelf = user._id.equals(req.user._id);
    /*
     * Reads whichever the caller sent. Losing your own admin role is the one edit that can lock
     * the last administrator out of their own instance, and it is easy to do by accident when the
     * roles are a set of checkboxes rather than one dropdown.
     */
    const wanted = req.body.roles ?? (req.body.role ? [req.body.role] : null);
    if (isSelf && wanted && !wanted.includes('admin')) {
      throw badRequest('You cannot remove your own admin role');
    }
    if (isSelf && req.body.enabled === false) {
      throw badRequest('You cannot disable your own account');
    }

    const { password, ...rest } = req.body;
    Object.assign(user, rest);
    if (password) {
      user.password = password;
      user.tokenVersion += 1;
    }
    await user.save();
    res.json(user.toPublic());
  })
);

/**
 * Clears two-factor for an account whose owner lost their authenticator. They
 * re-enrol from their profile the next time they sign in.
 *
 * If the locked-out person is the only admin there is nobody left to press this,
 * which is what `npm run reset-2fa` exists for.
 */
router.post(
  '/:id/reset-2fa',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select(
      '+totpSecret +totpLastStep +totpFailures +totpLockedUntil'
    );
    if (!user) throw notFound('User not found');
    if (!user.totpEnabled && !user.totpSecret) {
      throw badRequest('That account does not have two-factor authentication set up.');
    }

    await disableTotp(user);
    // Existing sessions keep working; only the second factor is cleared.
    res.json({ ok: true, user: user.toPublic() });
  })
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user._id.toString()) {
      throw badRequest('You cannot delete your own account');
    }
    const remainingAdmins = await User.countDocuments({
      roles: 'admin',
      _id: { $ne: req.params.id },
    });
    if (remainingAdmins === 0) throw badRequest('At least one admin account must remain');

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) throw notFound('User not found');
    res.json({ ok: true, id: req.params.id });
  })
);

export default router;
