/**
 * Errors thrown with this class are trusted: their message and status reach the
 * client verbatim. Anything else surfaces as a generic 500.
 */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (msg = 'Bad request', details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg);
export const forbidden = (msg = 'You are not allowed to do that') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg = 'Already exists') => new HttpError(409, msg);
export const unprocessable = (msg = 'Cannot process request', details) =>
  new HttpError(422, msg, details);

export default HttpError;
