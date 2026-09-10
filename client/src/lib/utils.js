import clsx from 'clsx';

/** Class-name helper. `clsx` alone is enough here — no conflicting-class merge. */
export const cn = (...parts) => clsx(parts);

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'None'];

export const SEVERITY_META = {
  Critical: { label: 'Critical', text: 'text-crit', bg: 'bg-crit/12', ring: 'ring-crit/35', dot: 'bg-crit' },
  High: { label: 'High', text: 'text-high', bg: 'bg-high/12', ring: 'ring-high/35', dot: 'bg-high' },
  Medium: { label: 'Medium', text: 'text-med', bg: 'bg-med/12', ring: 'ring-med/35', dot: 'bg-med' },
  Low: { label: 'Low', text: 'text-low', bg: 'bg-low/12', ring: 'ring-low/35', dot: 'bg-low' },
  None: { label: 'Info', text: 'text-info', bg: 'bg-info/12', ring: 'ring-info/35', dot: 'bg-info' },
};

export const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
export const COMPLEXITY_LABELS = { 1: 'Easy', 2: 'Medium', 3: 'Complex' };

export const AUDIT_STATE_META = {
  EDIT: { label: 'In progress', text: 'text-info', bg: 'bg-info/12' },
  REVIEW: { label: 'In review', text: 'text-med', bg: 'bg-med/12' },
  APPROVED: { label: 'Approved', text: 'text-low', bg: 'bg-low/12' },
};

/** ISO date (or anything Date accepts) → "2 Aug 2026". Empty input stays empty. */
/**
 * SHA-256 of a file, computed in the browser.
 *
 * The file never leaves the machine: identifying a document does not require storing a second copy
 * of it, and both callers — the delivery record and the render history — only want to know whether
 * the bytes in front of somebody are the bytes that were produced.
 *
 * `crypto.subtle` needs a secure context. Localhost counts; plain http on a LAN does not, which is
 * why this throws a recognisable error rather than returning nothing, and the callers offer a
 * pasted hash instead.
 */
export async function sha256OfFile(file) {
  if (!window.crypto?.subtle) throw new Error('insecure-context');
  const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function formatDate(value, options) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, options ?? { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3 minutes ago" for list views. */
export function timeAgo(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  if (seconds < 45) return 'just now';
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      const value_ = Math.round(seconds / size);
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-value_, unit);
    }
  }
  return 'just now';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value >= 10 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

/** Strips HTML to a single-line snippet for table cells and cards. */
export function htmlToSnippet(html, max = 140) {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** True when the editor value holds nothing a reader would see. */
export function isHtmlEmpty(html) {
  if (!html) return true;
  if (/<(img|table|hr|iframe)\b/i.test(html)) return false;
  return htmlToSnippet(html, 10_000) === '';
}

export const initialsOf = (nameOrUser) => {
  if (!nameOrUser) return '?';
  const source =
    typeof nameOrUser === 'string'
      ? nameOrUser
      : [nameOrUser.firstname, nameOrUser.lastname].filter(Boolean).join(' ') ||
        nameOrUser.username ||
        nameOrUser.email ||
        '';
  const parts = source.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export const displayName = (user) => {
  if (!user) return '';
  return (
    user.fullname ||
    [user.firstname, user.lastname].filter(Boolean).join(' ') ||
    user.username ||
    user.email ||
    ''
  );
};

/** Triggers a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Reads the server's suggested filename out of Content-Disposition. */
export function filenameFromResponse(response, fallback = 'download') {
  const header = response.headers.get('content-disposition') ?? '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : fallback;
}

export const debounce = (fn, wait = 300) => {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
