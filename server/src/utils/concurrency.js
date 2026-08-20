/**
 * Optimistic concurrency for the things two people edit at once.
 *
 * Without this the finding editor was last-write-wins: two testers on the same
 * write-up, and whoever saved second silently replaced the other's work with no
 * warning to either of them. Presence made that *more* likely, not less, by
 * putting colleagues in the same engagement at the same time.
 *
 * The token is the document's own `updatedAt`. Every mutable subdocument carries
 * timestamps already, so nothing extra has to be stored or maintained — and a
 * client that has just saved gets the fresh value back in the response.
 */

import { HttpError } from './http-error.js';

/** 409, carrying the server's current copy so the client can show the difference. */
export class ConflictError extends HttpError {
  constructor(message, current) {
    super(409, message);
    this.name = 'ConflictError';
    this.details = { conflict: true, current };
  }
}

/**
 * Throws if the caller's copy is older than what is stored.
 *
 * Passing no token skips the check — scripts, imports and older clients keep
 * working rather than being locked out by a field they do not send.
 *
 * @param {{updatedAt?: Date}} doc the stored subdocument or document
 * @param {string|undefined|null} expectedUpdatedAt ISO timestamp the client last saw
 * @param {{label?: string, current?: any}} [options]
 */
export function assertFresh(doc, expectedUpdatedAt, options = {}) {
  if (!expectedUpdatedAt) return;
  if (!doc?.updatedAt) return;

  const expected = new Date(expectedUpdatedAt).getTime();
  if (Number.isNaN(expected)) return;

  const stored = new Date(doc.updatedAt).getTime();

  // Compared exactly, because the interesting case is two people saving seconds
  // apart — a tolerance wide enough to smooth over clock noise would wave through
  // precisely the collision this exists to catch.
  //
  // The one concession: a client that sent a timestamp with no fractional part
  // truncated it, so there is nothing below the second to compare and the
  // comparison drops to second resolution rather than reporting a false conflict.
  const truncated = typeof expectedUpdatedAt === 'string' && !/\.\d/.test(expectedUpdatedAt);
  if (truncated ? Math.floor(stored / 1000) <= Math.floor(expected / 1000) : stored <= expected) {
    return;
  }

  const label = options.label ?? 'this item';
  throw new ConflictError(
    `Someone else changed ${label} while you were editing. Your copy is out of date.`,
    options.current ?? doc
  );
}

export default assertFresh;
