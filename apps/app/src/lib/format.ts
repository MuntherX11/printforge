export function formatTime(minutes?: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}
