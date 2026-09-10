/**
 * What was done with the accounts the client lent you.
 *
 * The vault has held borrowed credentials and audited every reveal since it was written, which
 * answers "who on our side looked at this password". It never answered the question the client
 * actually asks at the end of a job: *what did you access with the login we gave you?*
 *
 * Derived rather than stored. A step, a finding and an intrusion each record which account they were
 * done with, because that is where somebody knows it; this reads the three and turns them inside
 * out. The alternative — a `uses` array on the credential, written at the same time as the field on
 * the work — is two places to write one fact and therefore two places that can disagree, in exactly
 * the record a client is going to be shown.
 *
 * Nothing here touches a secret. The vault is not opened, no reveal is recorded, and the answer is
 * safe to print: a label, a username, and where it was used.
 */

/** A borrowed account, without its secret, in the shape both the app and a report can use. */
const publicCredential = (credential) => ({
  _id: credential._id,
  label: credential.label ?? '',
  username: credential.username ?? '',
  url: credential.url ?? '',
  /** Whether this one is gone: a restricted engagement expires its credentials. */
  expiresAt: credential.expiresAt ?? null,
});

/**
 * Where each account was used, and where each piece of work names an account.
 *
 * @param {object} audit the engagement, as a document or a plain object
 * @param {Array} credentials the engagement's credentials, secrets included or not — untouched
 * @returns {{byCredential: Array, unknown: Array, total: number}}
 */
export function credentialUsage(audit, credentials = []) {
  const known = new Map(credentials.map((row) => [String(row._id), row]));

  /*
   * Every mention, from all three places, flattened first.
   *
   * One pass over the engagement rather than three passes per credential: an engagement with sixty
   * steps and forty findings and eight accounts would otherwise be a nested walk for no reason.
   */
  const mentions = [];
  const note = (kind, id, entry, extra) => {
    for (const credentialId of entry.credentialsUsed ?? []) {
      mentions.push({ credential: String(credentialId), kind, id: String(id), ...extra });
    }
  };

  for (const finding of audit?.findings ?? []) {
    note('finding', finding._id, finding, {
      title: finding.title ?? '',
      identifier: finding.identifier ?? null,
    });
  }
  for (const step of audit?.enumeration ?? []) {
    note('step', step._id, step, {
      title: step.title ?? '',
      tool: step.tool ?? '',
      at: step.ranAt ?? '',
    });
  }
  for (const intrusion of audit?.intrusions ?? []) {
    note('intrusion', intrusion._id, intrusion, {
      title: intrusion.title ?? '',
      action: intrusion.action ?? '',
      at: intrusion.at ?? '',
      reverted: Boolean(intrusion.revertedAt),
    });
  }

  const byCredential = credentials.map((credential) => {
    const used = mentions.filter((mention) => mention.credential === String(credential._id));
    return {
      ...publicCredential(credential),
      /* Split by kind, because a report prints them under different headings. */
      findings: used.filter((mention) => mention.kind === 'finding'),
      steps: used.filter((mention) => mention.kind === 'step'),
      intrusions: used.filter((mention) => mention.kind === 'intrusion'),
      uses: used.length,
      /*
       * Whether anything was done with it at all.
       *
       * Worth stating rather than leaving to be inferred from an empty list: "we were given this
       * and never used it" is a sentence a client is glad to read, and it is also the prompt to
       * ask why it was asked for.
       */
      unused: used.length === 0,
    };
  });

  /*
   * Work that names an account this engagement does not have.
   *
   * It happens: a credential is deleted, or expires off a restricted engagement, while the finding
   * that used it stays. Reported rather than dropped, because a reference to something that is gone
   * is a fact about the record and quietly discarding it would make the trail look complete.
   */
  const unknown = mentions
    .filter((mention) => !known.has(mention.credential))
    .map((mention) => ({ ...mention, credential: mention.credential }));

  return { byCredential, unknown, total: mentions.length };
}

/**
 * The same thing shaped for a template, which wants sentences rather than ids.
 *
 * A report's appendix says "the reader-only account was used for four findings and two tool runs,
 * and to disable MFA on the test user". So the loop gets counts and a list of titles, and the
 * document decides how to phrase it.
 */
export function credentialUsageForReport(audit, credentials = []) {
  const { byCredential } = credentialUsage(audit, credentials);

  return byCredential.map((entry) => ({
    label: entry.label,
    username: entry.username,
    url: entry.url,
    unused: entry.unused,
    counts: {
      findings: entry.findings.length,
      steps: entry.steps.length,
      intrusions: entry.intrusions.length,
      total: entry.uses,
    },
    /** Titles only: an id in a client's report is noise, and a secret is unthinkable. */
    findings: entry.findings.map((use) => ({
      identifier: use.identifier ?? '',
      title: use.title,
    })),
    steps: entry.steps.map((use) => ({ title: use.title, tool: use.tool, at: use.at })),
    intrusions: entry.intrusions.map((use) => ({
      title: use.title,
      action: use.action,
      at: use.at,
      reverted: use.reverted,
    })),
  }));
}

export default credentialUsage;
