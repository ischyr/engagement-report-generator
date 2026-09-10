import mongoose from 'mongoose';

/**
 * Something an operator did, and whether the client's side ever noticed.
 *
 * A pentest report says what is broken. It almost never says whether anybody *saw* the testing,
 * which is a separate and often more uncomfortable answer: the perimeter held for four days and
 * the SOC did not raise a single ticket. Teams do keep this — in a spreadsheet, or in the notes
 * tab as a list of times — and then retype it into the report at the end.
 *
 * Its own collection, like credentials and scope changes. Two reasons: this is a log that grows
 * all week, so it must not be loaded on every `GET /audits/:id` alongside the findings, and it
 * is the only part of an engagement whose interesting question is *when*, to the minute.
 *
 * Which is the one place this model departs from the rest of the app. Bookings, leave, time
 * entries and signatures all store `yyyy-mm-dd`, because a day is what they mean. Here a day
 * would destroy the fact: "detected in eleven minutes" and "detected the following afternoon"
 * are the difference between a working detection capability and a compliance artefact, and only
 * a timestamp can tell them apart.
 */

export const DETECTION_OUTCOMES = [
  'not-detected',
  'logged',
  'alerted',
  'blocked',
  'contacted',
  'unknown',
];

/**
 * A ladder rather than a boolean, because the middle of it is where the findings live.
 *
 * "It was logged but nobody looked" is the most common real result and the most useful thing a
 * report can say: the telemetry exists, so this is a monitoring failure and not a tooling gap —
 * a conclusion `detected: false` cannot express and a client would rightly dispute.
 */
export const DETECTION_OUTCOME_LABELS = {
  'not-detected': 'Not detected',
  logged: 'Logged, no response',
  alerted: 'Alert raised',
  blocked: 'Blocked',
  contacted: 'They contacted us',
  unknown: 'Not confirmed',
};

/**
 * How loud the action was.
 *
 * Without this the numbers mean nothing. Thirty undetected actions that were all deliberately
 * quiet is a normal red-team result; three undetected actions that were meant to be caught is
 * the finding. The report needs to be able to tell those apart, so the operator says which they
 * were aiming for at the time — not afterwards, once the outcome is known.
 */
export const DETECTION_NOISE = ['quiet', 'standard', 'loud'];

export const DETECTION_NOISE_LABELS = {
  quiet: 'Deliberately quiet',
  standard: 'Normal',
  loud: 'Deliberately loud',
};

const detectionEventSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'Audit', required: true, index: true },

    /** What was done, in the words the report can print. */
    action: { type: String, required: true, trim: true, maxlength: 300 },
    /** What it was aimed at — a host, a URL, an account. Free text; one action can hit several. */
    target: { type: String, default: '', trim: true, maxlength: 300 },
    /**
     * The technique, however the team refers to it — "T1110.003", "Kerberoasting", both.
     *
     * Free text and not validated against a catalogue: ATT&CK moves, teams have their own
     * shorthand, and a required dropdown would push half the entries into the notes field.
     * Grouping in the report is by whatever string is here, so a team that is consistent gets
     * a coverage table for free and a team that is not still gets its timeline.
     */
    technique: { type: String, default: '', trim: true, maxlength: 160 },

    /** When the operator did it. The clock everything else is measured from. */
    occurredAt: { type: Date, required: true },

    outcome: { type: String, enum: DETECTION_OUTCOMES, default: 'unknown' },
    noise: { type: String, enum: DETECTION_NOISE, default: 'standard' },

    /**
     * When their side noticed, and when somebody actually did something about it.
     *
     * Two fields because they are two different failures. An alert that fires in ninety seconds
     * and is triaged three days later is a response problem; one that fires after three days is
     * a detection problem. A single "detected at" would report both as the same number, and the
     * remediation advice for them is not the same.
     */
    detectedAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },

    /** How you know — "EDR console", "their SOC called", "confirmed on the closeout call". */
    source: { type: String, default: '', trim: true, maxlength: 200 },
    notes: { type: String, default: '', maxlength: 2000 },

    /**
     * The finding this became, when a gap was worth reporting as one.
     *
     * A subdocument id inside the engagement's own `findings` array rather than a ref: findings
     * are not their own collection, so there is nothing to populate. Stored so the tab can show
     * which gaps were written up and which are still just observations.
     */
    finding: { type: mongoose.Schema.Types.ObjectId, default: null },

    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

/**
 * Times that cannot have happened, as sentences.
 *
 * Refused rather than corrected, because every one of these is a typo in a form and silently
 * nudging a timestamp would produce a latency figure the report then states as fact. The
 * `not-detected` check is the important one: a row claiming both "nobody noticed" and a time
 * they noticed is the kind of contradiction that only surfaces when a client reads the table.
 *
 * Exported so the route can refuse a bad save with the sentence itself and the model can hold
 * the same line for a script or a seed. One list, so the two cannot drift apart.
 */
export function detectionProblems(row) {
  const problems = [];
  const at = (value) => (value ? new Date(value) : null);
  const occurred = at(row.occurredAt);
  const detected = at(row.detectedAt);
  const responded = at(row.respondedAt);

  if (detected && occurred && detected < occurred) {
    problems.push('Nobody can detect an action before it happened');
  }
  if (responded && occurred && responded < occurred) {
    problems.push('The response cannot come before the action');
  }
  if (responded && detected && responded < detected) {
    problems.push('The response cannot come before the detection');
  }
  if (row.outcome === 'not-detected' && (detected || responded)) {
    problems.push('This is marked as not detected, so it cannot have a detection time');
  }
  return problems;
}

detectionEventSchema.pre('validate', function ensureOrder(next) {
  // `invalidate` rather than a thrown Error, so this arrives as a real mongoose
  // ValidationError and the error middleware answers with the sentence instead of a 500.
  for (const problem of detectionProblems(this)) this.invalidate('occurredAt', problem);
  return next();
});

// The tab and the report both read one engagement's events in the order they happened.
detectionEventSchema.index({ audit: 1, occurredAt: 1 });

export const DetectionEvent = mongoose.model('DetectionEvent', detectionEventSchema);
export default DetectionEvent;
