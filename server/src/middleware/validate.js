import { unprocessable } from '../utils/http-error.js';

/**
 * Validates `req[source]` against a Zod schema and replaces it with the parsed
 * result, so handlers work with coerced, trimmed data.
 */
export const validate =
  (schema, source = 'body') =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        unprocessable(
          'Validation failed',
          result.error.issues.map((issue) => ({
            field: issue.path.join('.') || source,
            message: issue.message,
          }))
        )
      );
    }
    req[source] = result.data;
    return next();
  };

export default validate;
