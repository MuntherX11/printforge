/**
 * CSV Export utility with formula injection prevention.
 *
 * Any cell starting with =, +, -, @, \t, \r is prefixed with a single quote
 * to prevent spreadsheet software from executing it as a formula.
 */

const FORMULA_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Prevent CSV formula injection
  if (str.length > 0 && FORMULA_CHARS.has(str[0])) {
    return `'${str}`;
  }
  return str;
}

function escapeCSV(value: string): string {
  // If value contains comma, quote, or newline — wrap in quotes and escape inner quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCSV(
  rows: Record<string, unknown>[],
  columns?: { key: string; label: string }[],
): string {
  if (rows.length === 0) return '';

  // Auto-detect columns from first row if not specified
  const cols = columns || Object.keys(rows[0]).map(k => ({ key: k, label: k }));

  // Header row
  const header = cols.map(c => escapeCSV(c.label)).join(',');

  // Data rows
  const dataRows = rows.map(row =>
    cols.map(c => escapeCSV(sanitizeCell(row[c.key]))).join(','),
  );

  return [header, ...dataRows].join('\r\n');
}
