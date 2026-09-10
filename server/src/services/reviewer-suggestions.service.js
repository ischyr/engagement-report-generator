/**
 * Who else could review this, given what it is about and who is around.
 *
 * Three things already knew a piece of this and none of them had been introduced. The skills
 * matrix knows who can do what. Leave and bookings know who is available — the review check
 * already reads them. And a finding carries a category and a vulnerability type, so an engagement
 * quietly describes its own subject matter. Put together they answer a question a lead currently
 * answers from memory: *this is mostly Active Directory work, who understands it and is free?*
 *
 * It suggests, and says why. Adding somebody as a reviewer stays a deliberate act.
 */

import { User, WORKING_ROLES } from '../models/user.model.js';
import { Leave } from '../models/leave.model.js';
import { availableDaysFor, leaveDayMap, weekdaysBetween } from './leave.service.js';
import { reviewWindow } from './review-availability.service.js';

const LEVEL_RANK = { learning: 1, working: 2, strong: 3, expert: 4 };

/** Short words carry no subject matter, and matching on them would suggest everybody. */
const NOISE = new Set([
  'test',
  'testing',
  'security',
  'assessment',
  'review',
  'audit',
  'general',
  'other',
  'misc',
  'and',
  'the',
]);

const normalise = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * What this engagement is about, in its own words.
 *
 * Read from what the team already typed rather than from a field nobody fills in: the engagement
 * type, and the categories and vulnerability types on its findings. An engagement with no findings
 * yet still has a type, which is usually enough to be useful on day one.
 */
export function engagementTopics(audit) {
  const topics = new Map();
  const add = (value) => {
    const key = normalise(value);
    if (!key || NOISE.has(key)) return;
    if (!topics.has(key)) topics.set(key, String(value).trim());
  };

  add(audit.auditType);
  for (const finding of audit.findings ?? []) {
    add(finding.category);
    add(finding.vulnType);
  }

  const all = [...topics.entries()].map(([key, label]) => ({ key, label }));
  /*
   * A topic wholly inside another is dropped, keeping the shorter one.
   *
   * An engagement typed "Active Directory review" whose findings are categorised "Active
   * Directory" listed both, so the reason read "skills in Active Directory review, Active
   * Directory" — which says one thing twice and makes the sentence look automated. Matching is
   * unaffected: anything the longer one would have matched, the shorter one matches too.
   */
  return all.filter(
    (topic) => !all.some((other) => other.key !== topic.key && topic.key.includes(other.key))
  );
}

/**
 * Whether a skill is about a topic.
 *
 * Exact, or one wholly containing the other — "Active Directory" matches an engagement whose
 * findings are categorised "Active Directory", and a skill called "Web" matches "Web application".
 * Deliberately not a shared-word test: "application" and "security" appear in half of everything,
 * and a suggestion engine that fires on them is one nobody trusts twice.
 */
export function skillMatchesTopic(skillName, topicKey) {
  const skill = normalise(skillName);
  if (!skill || NOISE.has(skill)) return false;
  if (skill === topicKey) return true;
  // Long enough to mean something on its own before being accepted as a substring.
  if (skill.length >= 4 && topicKey.includes(skill)) return true;
  if (topicKey.length >= 4 && skill.includes(topicKey)) return true;
  return false;
}

/**
 * People who could be asked, ranked.
 *
 * @param {object} audit a loaded engagement
 * @param {string} [from] first day of the window, defaulting to the next working day
 * @param {number} [limit] how many to hand back
 */
export async function suggestReviewers({ audit, from, limit = 6 }) {
  const window = reviewWindow(from);
  const workingDays = weekdaysBetween(window.from, window.to);
  const topics = engagementTopics(audit);

  /*
   * Everybody already attached to this engagement is out.
   *
   * The creator because the server refuses to let an author sign off their own report, and the
   * rest because suggesting somebody who is already a reviewer is not a suggestion.
   */
  const excluded = new Set(
    [
      audit.creator,
      ...(audit.reviewers ?? []),
      ...(audit.collaborators ?? []),
    ]
      .map((person) => String(person?._id ?? person ?? ''))
      .filter(Boolean)
  );

  const people = (
    await User.find({
      enabled: true,
      approvedAt: { $ne: null },
      // Readonly cannot approve, and sales cannot open it at all.
      roles: { $in: WORKING_ROLES, $ne: 'readonly' },
    }).select(
      'username firstname lastname title profile.headline profile.skills'
    )
  ).filter((person) => !excluded.has(String(person._id)));

  if (!people.length) {
    return { ...window, workingDays, topics, bySkill: false, suggestions: [] };
  }

  const leaves = await Leave.find({
    $or: [{ user: { $in: people.map((person) => person._id) } }, { user: null }],
    start: { $lte: window.to },
    end: { $gte: window.from },
  }).select('user start end type portion status');
  const dayMap = leaveDayMap(leaves, window.from, window.to);

  const rows = people.map((person) => {
    const { available, off } = availableDaysFor(person._id, window.from, window.to, dayMap);

    /** Every skill this person holds that is about something this engagement is about. */
    const matched = [];
    for (const skill of person.profile?.skills ?? []) {
      const topic = topics.find((entry) => skillMatchesTopic(skill.name, entry.key));
      if (topic) matched.push({ name: skill.name, level: skill.level, about: topic.label });
    }

    return {
      _id: person._id,
      username: person.username,
      firstname: person.firstname ?? '',
      lastname: person.lastname ?? '',
      title: person.title ?? '',
      headline: person.profile?.headline ?? '',
      matchedSkills: matched,
      /** The best level held among the matching skills, for ranking and for the sentence. */
      bestLevel:
        matched.reduce(
          (best, skill) => (LEVEL_RANK[skill.level] > LEVEL_RANK[best] ? skill.level : best),
          ''
        ) || '',
      availableDays: available,
      awayDays: off,
      workingDays,
      away: available === 0,
    };
  });

  const skilled = rows.filter((row) => row.matchedSkills.length && !row.away);

  /*
   * Falls back to plain availability, and says which it did.
   *
   * A new instance has no skills recorded at all, and an engagement can be about something nobody
   * has written down. "Nobody matches" would be true and useless; "these three are free" is the
   * honest lesser answer, provided the page does not dress it up as expertise.
   */
  const bySkill = skilled.length > 0;
  const pool = bySkill ? skilled : rows.filter((row) => !row.away);

  pool.sort(
    (a, b) =>
      (LEVEL_RANK[b.bestLevel] ?? 0) - (LEVEL_RANK[a.bestLevel] ?? 0) ||
      b.matchedSkills.length - a.matchedSkills.length ||
      b.availableDays - a.availableDays ||
      (a.firstname || a.username).localeCompare(b.firstname || b.username)
  );

  return {
    ...window,
    workingDays,
    topics: topics.map((entry) => entry.label),
    /** False when nobody's recorded skills matched, so the page can word it honestly. */
    bySkill,
    suggestions: pool.slice(0, limit),
  };
}

export default suggestReviewers;
