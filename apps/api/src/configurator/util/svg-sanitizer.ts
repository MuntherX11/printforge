/**
 * Server-side SVG sanitizer for generators that accept customer SVG uploads
 * (spec §4 — the highest-risk surface). Neutralises stored-XSS and XXE/entity
 * vectors before the SVG is stored or (re-serialized) shown in the admin UI.
 *
 * This is a conservative allowlist-ish strip. Generators that take SVG input
 * MUST run uploads through sanitizeSvg() and MUST render a server-produced
 * preview (this cleaned SVG or a raster), never the raw uploaded bytes.
 */

const MAX_SVG_BYTES = 512 * 1024; // 512 KB cap — reject oversized early

export interface SvgSanitizeResult {
  ok: boolean;
  svg?: string;
  reason?: string;
}

export function sanitizeSvg(input: string | Buffer): SvgSanitizeResult {
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : input;

  if (raw.length > MAX_SVG_BYTES) {
    return { ok: false, reason: 'SVG exceeds the 512 KB limit' };
  }
  if (!/<svg[\s>]/i.test(raw)) {
    return { ok: false, reason: 'Not a valid SVG document' };
  }

  // Reject XXE / entity-expansion vectors outright rather than trying to clean
  // them — a DOCTYPE or ENTITY in an uploaded SVG has no legitimate use here.
  if (/<!DOCTYPE/i.test(raw) || /<!ENTITY/i.test(raw)) {
    return { ok: false, reason: 'DOCTYPE / entity declarations are not allowed' };
  }
  if (/<\?xml-stylesheet/i.test(raw)) {
    return { ok: false, reason: 'External stylesheet references are not allowed' };
  }

  let svg = raw;

  // Strip scriptable and external-reference constructs.
  svg = svg.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  svg = svg.replace(/<script[^>]*\/>/gi, '');
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  // Event handler attributes: on*="..."
  svg = svg.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  svg = svg.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  svg = svg.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  // javascript:/data: URIs in href/xlink:href/src
  svg = svg.replace(/(href|xlink:href|src)\s*=\s*"(?:\s*(?:javascript|data)\s*:)[^"]*"/gi, '');
  svg = svg.replace(/(href|xlink:href|src)\s*=\s*'(?:\s*(?:javascript|data)\s*:)[^']*'/gi, '');
  // <use> can pull external refs; drop it.
  svg = svg.replace(/<use[\s\S]*?(?:\/>|<\/use\s*>)/gi, '');

  // If anything scriptable survived, fail closed.
  if (/<script|javascript:|\son[a-z]+\s*=/i.test(svg)) {
    return { ok: false, reason: 'SVG contained script content that could not be removed' };
  }

  return { ok: true, svg };
}
