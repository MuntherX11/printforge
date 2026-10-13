import Link from 'next/link';

/** A job made from a plate that also prints other jobs (v2.19.0): they are one physical print. */
export interface SharedPlateJob {
  id: string;
  name: string;
}

/**
 * One quiet line under a job: "Shared plate — also prints: A, B". Renders
 * nothing unless the job shares its plate. `links` makes the names links to
 * those jobs (not inside a row that is itself a link).
 */
export function SharedPlateNote({ sharedWith, links, className }: {
  sharedWith?: ReadonlyArray<SharedPlateJob> | null;
  links?: boolean;
  className?: string;
}) {
  const others = Array.isArray(sharedWith) ? sharedWith.filter(j => j && typeof j.id === 'string' && typeof j.name === 'string') : [];
  if (others.length === 0) return null;
  return (
    <p className={`text-xs text-gray-500 dark:text-gray-400 ${className ?? ''}`}>
      Shared plate — also prints:{' '}
      {others.map((j, i) => (
        <span key={j.id}>
          {i > 0 && ', '}
          {links ? <Link href={`/production/${j.id}`} className="hover:underline">{j.name}</Link> : j.name}
        </span>
      ))}
    </p>
  );
}
