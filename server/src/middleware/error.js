import mongoose from 'mongoose';
import { HttpError } from '../utils/http-error.js';
import { log } from '../utils/logger.js';
import env from '../config/env.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.entries(err.errors).map(([field, e]) => ({
      field,
      message: e.message,
    }));
    return res.status(422).json({ error: 'Validation failed', details });
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: `Invalid value for "${err.path}"` });
  }

  // Duplicate key
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'value';
    return res.status(409).json({ error: `That ${field} is already taken` });
  }

  if (err?.name === 'ZodError') {
    return res.status(422).json({
      error: 'Validation failed',
      details: err.issues?.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  // Multer
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large (limit is 50 MB)' });
  }

  log.error(err.stack ?? err.message ?? err);
  return res.status(500).json({
    error: 'Internal server error',
    ...(env.isProd ? {} : { debug: err.message }),
  });
}

export default errorHandler;
