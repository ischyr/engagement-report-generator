/**
 * Issuing pre-engagement questionnaires, and turning the answers into an engagement.
 *
 * The same shape as the password invitations: a long random token, only its hash stored, an
 * expiry, and a public page that knows nothing except what it needs to show. The differences are
 * deliberate — this one points at a *client* rather than an account, it grants no session and
 * never could, and the answers outlive the link because they are the reason it existed.
 */

import crypto from 'node:crypto';

import { Intake } from '../models/intake.model.js';

/** A fortnight. Long enough to chase somebody twice, short enough not to be a standing door. */
export const INTAKE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * A new questionnaire for a client.
 *
 * Earlier open ones for the same client are *not* cancelled, unlike an account invitation: two
 * jobs for one client can genuinely be scoped at the same time, and quietly killing the first
 * link would strand whoever was already filling it in.
 */
export async function issueIntake({ company, label = '', requestedBy = null }) {
  const token = crypto.randomBytes(32).toString('base64url');

  const intake = await Intake.create({
    tokenHash: hash(token),
    company: company._id ?? company,
    label,
    requestedBy: requestedBy?._id ?? null,
    expiresAt: new Date(Date.now() + INTAKE_LIFETIME_MS),
  });

  return {
    intake,
    token,
    /** What to append to the instance's own address. The app has no idea what that is. */
    path: `/intake/${token}`,
  };
}

/** The questionnaire behind a token, or null. Never throws — the route decides what to say. */
export async function readIntake(token) {
  if (!token || typeof token !== 'string') return null;
  const intake = await Intake.findOne({ tokenHash: hash(token) }).populate({
    path: 'company',
    select: 'name',
  });
  if (!intake) return null;
  return intake;
}

/** Whether this one can still be filled in, and why not if it cannot. */
export function intakeState(intake) {
  if (!intake) return { open: false, reason: 'This link is not valid.' };
  if (intake.status === 'cancelled') {
    return { open: false, reason: 'This questionnaire was withdrawn.' };
  }
  if (intake.expiresAt <= new Date()) {
    return { open: false, reason: 'This link has expired. Ask for a new one.' };
  }
  /*
   * A submitted questionnaire stays editable until somebody builds the engagement from it.
   * People remember a constraint an hour after pressing send, and a form that refuses the
   * correction means the correction arrives by email and is lost.
   */
  if (intake.status === 'used') {
    return { open: false, reason: 'This has already been used to set up the engagement.' };
  }
  return { open: true, reason: '' };
}

/**
 * What the public page is allowed to know.
 *
 * The client's name, because somebody filling in a form needs to be sure it is theirs. Nothing
 * else: not who asked for it, not what else this instance holds, not whether the company has
 * other engagements.
 */
export function publicView(intake) {
  const state = intakeState(intake);
  return {
    company: intake?.company?.name ?? '',
    label: intake?.label ?? '',
    status: intake?.status ?? 'cancelled',
    open: state.open,
    reason: state.reason,
    expiresAt: intake?.expiresAt ?? null,
    /** So a correction starts from what was said rather than from an empty form. */
    answers: state.open ? (intake.answers ?? {}) : null,
  };
}

/** One asset per line, the way people paste them. */
export function parseAssets(text) {
  return String(text ?? '')
    .split(/[\n,;]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2000);
}

/**
 * The engagement these answers describe.
 *
 * Built as a *draft* of what the client asked for, never as the agreed thing: everything here is
 * one side's account, typed into a form by somebody who may have guessed. Whoever sets the job up
 * reads it and edits it, and the questionnaire is kept beside it either way.
 */
export function engagementFromAnswers(intake, { creator }) {
  const answers = intake.answers ?? {};
  const assets = parseAssets(answers.assets);

  const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  return {
    name: answers.engagementName || intake.label || `${intake.company?.name ?? 'Client'} engagement`,
    auditType: answers.kind || '',
    company: intake.company?._id ?? intake.company,
    creator: creator._id,
    collaborators: [creator._id],
    date_start: answers.windowStart || '',
    date_end: answers.windowEnd || '',
    scope: assets.length
      ? [
          {
            name: 'From the questionnaire',
            hosts: assets.map((asset) => ({
              hostname: IPV4.test(asset) ? '' : asset,
              ip: IPV4.test(asset) ? asset : '',
              status: 'pending',
            })),
          },
        ]
      : [],
    /*
     * The constraints land in a note rather than in a field, because there is no field for them
     * — and a note is visible, searchable and quotable, which is better than losing them. When
     * rules of engagement become first-class this is what moves.
     */
    notes: [
      answers.constraints || answers.testingWindowNote || answers.escalationName
        ? {
            title: 'What the client told us before we started',
            content: [
              answers.constraints ? `<p><strong>Constraints:</strong> ${escapeHtml(answers.constraints)}</p>` : '',
              answers.testingWindowNote
                ? `<p><strong>Testing window:</strong> ${escapeHtml(answers.testingWindowNote)}</p>`
                : '',
              answers.escalationName
                ? `<p><strong>Escalation:</strong> ${escapeHtml(answers.escalationName)}${
                    answers.escalationPhone ? ` — ${escapeHtml(answers.escalationPhone)}` : ''
                  }</p>`
                : '',
              answers.extra ? `<p>${escapeHtml(answers.extra)}</p>` : '',
            ]
              .filter(Boolean)
              .join(''),
            pinned: true,
            author: creator._id,
          }
        : null,
    ].filter(Boolean),
  };
}

/** The answers are the client's text, and it is going into a field that renders HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default issueIntake;
