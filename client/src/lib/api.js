/**
 * Thin API client.
 *
 * The access token lives in memory only — never localStorage — so a stray XSS
 * cannot read it from disk. Durability comes from the httpOnly refresh cookie:
 * on boot (and on any 401) we silently exchange it for a fresh access token.
 */

const BASE = '/api';

let accessToken = null;
let refreshInFlight = null;
/** Called when refreshing fails, so the app can drop to the login screen. */
let onSessionLost = () => {};

export const setAccessToken = (token) => {
  accessToken = token ?? null;
};
export const getAccessToken = () => accessToken;
export const setSessionLostHandler = (fn) => {
  onSessionLost = typeof fn === 'function' ? fn : () => {};
};

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when the request never got a reply
   * @param {string} message safe to show a user as-is
   * @param {any[]} [details] field-level validation details
   * @param {'http'|'network'|'unavailable'} [kind] why it failed, so callers can
   *   distinguish "you typed the wrong password" from "the server is down"
   */
  constructor(status, message, details, kind = 'http') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.kind = kind;
  }

  /** True when the API could not be reached at all. */
  get isUnreachable() {
    return this.kind === 'network' || this.kind === 'unavailable';
  }

  /**
   * True when the write was refused because someone else had already changed the
   * thing being edited. The server sends its current copy along with the 409.
   */
  get isConflict() {
    return this.status === 409 && this.details?.conflict === true;
  }

  /**
   * True when the write was refused because somebody has taken the record for editing.
   *
   * Distinct from a conflict: a conflict means the copy on screen is out of date, this means the
   * write is not allowed at all right now. The details carry who holds it, so the message can name
   * them instead of saying "locked".
   */
  get isLocked() {
    return this.status === 423 && this.details?.locked === true;
  }

  /** Who holds the lock, and whether this account may take it off them. */
  get lock() {
    return this.status === 423 ? (this.details ?? null) : null;
  }

  /** The server's version of the record, for a conflict. */
  get current() {
    return this.details?.current ?? null;
  }

  /** Flattens field-level validation details into a readable string. */
  get detailText() {
    if (!Array.isArray(this.details)) return '';
    return this.details
      .map((d) => (d.field ? `${d.field}: ${d.message}` : d.message ?? d.tag ?? ''))
      .filter(Boolean)
      .join('\n');
  }
}

const UNREACHABLE_MESSAGE =
  'Cannot reach the server. Make sure the API is running — try `npm run dev` in the project folder.';

async function parseError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body — handled below */
  }

  if (payload?.error) {
    return new ApiError(response.status, payload.error, payload.details);
  }

  // A 5xx with no JSON body is almost never the API itself: the dev proxy
  // answers this way when nothing is listening behind it. Saying "request
  // failed (500)" sends people hunting for a bug that isn't there.
  if (response.status >= 500) {
    return new ApiError(response.status, UNREACHABLE_MESSAGE, undefined, 'unavailable');
  }
  if (response.status === 413) {
    return new ApiError(413, 'That upload is too large');
  }
  return new ApiError(response.status, `Request failed (${response.status})`);
}

/** Exchanges the refresh cookie for a new access token, coalescing callers. */
async function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!response.ok) return null;
        const data = await response.json();
        setAccessToken(data.accessToken);
        return data;
      } catch {
        return null;
      } finally {
        // Cleared on the next tick so concurrent callers share this attempt.
        setTimeout(() => {
          refreshInFlight = null;
        }, 0);
      }
    })();
  }
  return refreshInFlight;
}

export { refreshSession };

/**
 * @param {string} path
 * @param {{method?:string, body?:any, raw?:boolean, signal?:AbortSignal,
 *   skipAuthRetry?:boolean, headers?:object}} [options]
 */
export async function request(path, options = {}) {
  const { method = 'GET', body, raw = false, signal, skipAuthRetry = false, headers = {} } = options;

  const send = async () => {
    const init = { method, credentials: 'include', signal, headers: { ...headers } };

    if (body instanceof FormData) {
      // Let the browser set the multipart boundary.
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (accessToken) init.headers.Authorization = `Bearer ${accessToken}`;

    try {
      return await fetch(`${BASE}${path}`, init);
    } catch (error) {
      // An aborted request is the caller's own doing; let it through untouched.
      if (error?.name === 'AbortError') throw error;
      // fetch only rejects when the request never completed — DNS, refused
      // connection, offline. There is no status and no body to read.
      throw new ApiError(0, UNREACHABLE_MESSAGE, undefined, 'network');
    }
  };

  let response = await send();

  // One transparent refresh-and-retry on an expired token.
  if (response.status === 401 && !skipAuthRetry && !path.startsWith('/auth/')) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      setAccessToken(null);
      onSessionLost();
      throw await parseError(response);
    }
    response = await send();
  }

  if (!response.ok) throw await parseError(response);
  if (raw) return response;
  if (response.status === 204) return null;

  const type = response.headers.get('content-type') ?? '';
  return type.includes('application/json') ? response.json() : response.text();
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
  raw: (path, options) => request(path, { ...options, raw: true }),
};

export default api;
