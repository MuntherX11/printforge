'use client';

/**
 * Small pieces the product page's sections share now that they are no longer
 * cards: a section heading row, a "show more" text button, a verdict pill and
 * the "How this works" disclosure that holds a section's long explanation.
 */
import { Children } from 'react';
import { cn } from '@/lib/utils';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * A section's heading with its actions on the right. The tabs layout passes a
 * title; the folded layout does not (its row already says it), and then only
 * the actions are drawn.
 */
export function SectionHead({ title, children }: { title?: string; children?: React.ReactNode }) {
  // `false`, `null` and `undefined` from `cond && <Button />` are not children: no empty wrapper for them.
  const hasActions = Children.toArray(children).length > 0;
  if (!title && !hasActions) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {title && <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>}
      {hasActions && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** A text button that shows or hides something below it. */
export function DisclosureButton({ open, onToggle, show, hide, controls }: {
  open: boolean;
  onToggle: () => void;
  /** e.g. "Show filaments and spools" */
  show: string;
  hide: string;
  controls?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn('rounded text-sm font-medium text-brand-600 hover:underline dark:text-brand-400', FOCUS)}
    >
      {open ? hide : show}
    </button>
  );
}

const PILL = {
  ok: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  short: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  blocked: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

/** A verdict in words; the colour only repeats what the words say. Wraps when the text is long. */
export function Pill({ tone, children }: { tone: keyof typeof PILL; children: React.ReactNode }) {
  return <span className={cn('inline-block rounded-xl px-2.5 py-0.5 text-xs font-medium', PILL[tone])}>{children}</span>;
}

/** A section's full explanation, closed until asked for. */
export function HowThisWorks({ children }: { children: React.ReactNode }) {
  return (
    <details className="text-sm text-gray-600 dark:text-gray-400">
      <summary className={cn('w-fit cursor-pointer rounded text-xs font-medium text-brand-600 hover:underline dark:text-brand-400', FOCUS)}>
        How this works
      </summary>
      <div className="mt-1.5 max-w-[70ch] space-y-1.5">{children}</div>
    </details>
  );
}

/** A label and a mono figure on one line: "Price OMR 0.267". */
export function Fact({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      {label && <>{label} </>}
      <span className="font-mono tabular-nums text-gray-900 dark:text-gray-100">{children}</span>
    </span>
  );
}
