import mongoose from 'mongoose';
import { HttpError } from '../utils/http-error.js';
import { log } from '../utils/logger.js';
import env from '../config/env.js';

/**
 * Every error says which request it was.
 *
 * On all of them rather than only the ones nobody expected: a 409 that somebody insists they should
 * not have had is exactly as worth tracing as a 500, and deciding case by case which failures are
 * traceable is how the useful half ends up without an id. It costs eight characters.
 */
const withId = (req, body) => ({ ...body, requestId: req.id ?? undefined });

export function notFoundHandler(req, res) {
  res.status(404).json(withId(req, { error: `No route for ${req.method} ${req.originalUrl}` }));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json(withId(req, { error: err.message, details: err.details }));
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.entries(err.errors).map(([field, e]) => ({
      field,
      message: e.message,
    }));
    return res.status(422).json(withId(req, { error: 'Validation failed', details }));
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json(withId(req, { error: `Invalid value for "${err.path}"` }));
  }

  // Duplicate key
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'value';
    return res.status(409).json(withId(req, { error: `That ${field} is already taken` }));
  }

  if (err?.name === 'ZodError') {
    return res.status(422).json(
      withId(req, {
        error: 'Validation failed',
        details: err.issues?.map((i) => ({ field: i.path.join('.'), message: i.message })),
      })
    );
  }

  // Multer
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json(withId(req, { error: 'File is too large (limit is 50 MB)' }));
  }

  /**
   * The engagement has outgrown what MongoDB will store in one document.
   *
   * 16MB, and three collections have already been moved out to stay under it — enumeration
   * bodies, phishing targets, evidence — each with a comment saying the same thing: reaching the
   * ceiling does not make a page slow, it makes the next save refuse, mid-work.
   *
   * Which until now it did as a 500 and "Internal server error": the least useful possible answer
   * to somebody who has just lost a paragraph, because it describes the server's feelings rather
   * than what they should do. The prose fields are capped at the door now, so arriving here means
   * the *document* is full rather than one field being absurd, and the thing to say is which kind
   * of content moves out of it.
   *
   * Matched on the driver's own codes and on the message, because this arrives by several routes —
   * a `save()`, a `bulkWrite`, an aggregation — and they do not agree on which code they set.
   */
  const tooLarge =
    err?.code === 10334 ||
    err?.code === 17419 ||
    /BSONObjectTooLarge|object to insert too large|resulting document after update is larger/i.test(
      String(err?.message ?? '')
    );
  if (tooLarge) {
    return res.status(413).json(
      withId(req, {
        error:
          'This engagement has reached the size a single record can hold. Nothing was saved. ' +
          'Move large tool output onto enumeration steps, which are stored separately, and ' +
          'attach screenshots rather than pasting them — then try again.',
      })
    );
  }

  /* The id is on this line already — `log` puts it there — so the stack is findable from the toast. */
  log.error(err.stack ?? err.message ?? err);
  return res.status(500).json(
    withId(req, {
      error: 'Internal server error',
      ...(env.isProd ? {} : { debug: err.message }),
    })
  );
}

export default errorHandler;
