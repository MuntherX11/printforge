/**
 * SSRF guard — returns true only for private/LAN/Tailscale addresses.
 * Used by the camera proxy and Moonraker bridge to prevent server-side
 * request forgery via user-supplied URLs.
 *
 * Allowed ranges:
 *   - localhost / 127.0.0.1 / ::1
 *   - 192.168.x.x
 *   - 10.x.x.x
 *   - 172.16-31.x.x
 *   - *.local  (mDNS)
 *   - 100.64.x.x – 100.127.x.x  (Tailscale CGNAT)
 */
export function isLocalUrl(rawUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    if (!['http:', 'https:'].includes(protocol)) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname.startsWith('192.168.')) return true;
    if (hostname.startsWith('10.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (hostname.endsWith('.local')) return true;
    const o = hostname.split('.').map(Number);
    if (o.length === 4 && o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  } catch {
    return false;
  }
}
