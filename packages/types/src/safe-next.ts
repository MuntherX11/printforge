/**
 * The `?next=` path a login page may return to (safety spec §1).
 *
 * Staff login sends the user back to `next` after signing in, so `next` must
 * stay on this site: an open redirect would let a crafted link bounce a fresh
 * login to another host. Only a plain same-site path is accepted; anything
 * else gives null and the caller falls back to '/'.
 *
 * Pure and DOM-free: the app uses it in the browser and the api jest suite
 * tests it (through the '@printforge/types' moduleNameMapper).
 */

/** Longest `next` accepted, in characters. */
export const SAFE_NEXT_MAX = 512;

/** Login and sign-up pages: returning to one would just ask again. */
const LOGIN_PAGE = /^\/(?:login|staff-login|signup|customer-login)(?:[/?#]|$)/i;

/** API calls and Next.js internals are never a page to land on. */
const NOT_A_PAGE = /^\/(?:api|_next)\//i;

/**
 * Backslashes (browsers read them as '/'), whitespace and control characters.
 * Browsers strip tabs and newlines from URLs, so '/', tab, '/evil.com' would
 * otherwise turn into '//evil.com'.
 */
const UNSAFE_CHAR = /[\\\s\u0000-\u001f\u007f]/;

/**
 * True when a path segment is '.' or '..', also percent-encoded. URL parsing
 * resolves them, so '/.//evil.com' would become '//evil.com', another host.
 */
function hasDotSegment(path: string): boolean {
  const pathOnly = path.split(/[?#]/, 1)[0];
  return pathOnly.split('/').some((segment) => {
    const s = segment.replace(/%2e/gi, '.');
    return s === '.' || s === '..';
  });
}

/**
 * `raw` when it is a safe same-site path, otherwise null. Safe means all of:
 * - a string of 1 to 512 characters that starts with '/';
 * - its second character is not '/' or a backslash (no '//host' or '/\host');
 * - no backslash, whitespace or control character anywhere;
 * - not a login page ('/login', '/staff-login', '/signup', '/customer-login',
 *   followed by the end, '/', '?' or '#', in any case);
 * - not under '/api/' or '/_next/';
 * - no '.' or '..' path segment.
 */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length < 1 || raw.length > SAFE_NEXT_MAX) return null;
  if (raw[0] !== '/') return null;
  if (raw[1] === '/' || raw[1] === '\\') return null;
  if (UNSAFE_CHAR.test(raw)) return null;
  if (LOGIN_PAGE.test(raw)) return null;
  if (NOT_A_PAGE.test(raw)) return null;
  if (hasDotSegment(raw)) return null;
  return raw;
}
