'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Edit2, Factory, Package } from 'lucide-react';
import type { ProductPageLayout } from '@printforge/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatGrams, formatMinutes, plural } from '@/lib/product-format';
import { cn } from '@/lib/utils';
import type { ProductDetail } from '@/lib/types/api';
import { EditProductDialog } from './EditProductDialog';
import { ProductActionsMenu } from './ProductActionsMenu';
import { LAYOUT_CHOICES, type HeaderFacts } from './product-layout';
import { Fact } from './section-ui';

interface Props {
  product: ProductDetail;
  /** Cover photo URL: the first loaded photo, else the product's cover. */
  coverUrl: string | null;
  photoCount: number | null;
  /** Price, cost, margin, grams and minutes of one unit (headerFacts). */
  facts: HeaderFacts;
  canEdit: boolean;
  isAdmin: boolean;
  /** The signed-in user's layout of this page, and the switch that changes it. */
  layout: ProductPageLayout;
  onLayout: (next: ProductPageLayout) => void;
  /** Reload product, cost and photos after a write. */
  onChanged: () => void;
  /**
   * Opens the product-page New job dialog (WP9). Until it exists the button
   * links to Production → New job.
   */
  onNewJob?: () => void;
}

function optionBadge(p: ProductDetail): string | null {
  const sizes = p.sizes.filter(s => s.isActive).length;
  const colours = p.colours.filter(c => c.isActive).length;
  const parts = [
    sizes > 0 ? plural(sizes, 'size') : null,
    colours > 0 ? plural(colours, 'colour') : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** "Tabs | One page": every staff role may change their own layout. */
function LayoutSwitch({ layout, onLayout }: { layout: ProductPageLayout; onLayout: (next: ProductPageLayout) => void }) {
  return (
    <div role="group" aria-label="Page layout" className="inline-flex rounded-md border border-gray-300 dark:border-gray-600">
      {LAYOUT_CHOICES.map((c, i) => {
        const pressed = layout === c.value;
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={pressed}
            title={c.hint}
            onClick={() => onLayout(c.value)}
            className={cn(
              'inline-flex min-h-[36px] items-center gap-1 px-2.5 text-xs transition-colors',
              'focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
              i === 0 ? 'rounded-l-md' : 'rounded-r-md border-l border-gray-300 dark:border-gray-600',
              pressed
                ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                : 'bg-white font-medium text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
            )}
          >
            {pressed && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The page header (spec §5.2 A): photo, name, status, options, the one-line
 * price facts, SKU, description, the layout switch and the actions.
 */
export function ProductHeader({ product, coverUrl, photoCount, facts, canEdit, isAdmin, layout, onLayout, onChanged, onNewJob }: Props) {
  const formatCurrency = useFormatCurrency();
  const [editOpen, setEditOpen] = useState(false);
  const options = optionBadge(product);

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
          {coverUrl ? (
            // Logged-in photo route (G5): the browser must send the session cookie,
            // so next/image's server-side optimiser can't fetch it.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt={`${product.name} cover photo`} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-400 dark:text-gray-500" aria-label="No photo">
              <Package className="h-6 w-6" aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-words text-lg font-semibold tracking-tight text-gray-900 dark:text-gray-100">{product.name}</h1>
            <Badge variant={product.isActive ? 'success' : 'default'}>{product.isActive ? 'Active' : 'Inactive'}</Badge>
            {options && <Badge variant="info">{options}</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-gray-500 dark:text-gray-400">
            <Fact label="Price">{facts.price > 0 ? formatCurrency(facts.price) : 'not set'}</Fact>
            {facts.cost && <Fact label="Cost">{facts.cost}</Fact>}
            {facts.margin && <Fact label="Margin">{facts.margin}</Fact>}
            {facts.gramsPerUnit !== null && facts.minutesPerUnit !== null && (
              <span className="whitespace-nowrap">
                <Fact>{formatGrams(facts.gramsPerUnit)}</Fact> · <Fact>{formatMinutes(facts.minutesPerUnit)}</Fact> a unit
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {product.sku ? <span className="font-mono">{product.sku}</span> : 'No SKU'}
          </p>
          {product.description && (
            <p className="mt-1 max-w-[70ch] whitespace-pre-line text-sm text-gray-600 dark:text-gray-300">{product.description}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <LayoutSwitch layout={layout} onLayout={onLayout} />
        {canEdit && (
          <>
            {onNewJob ? (
              <Button onClick={onNewJob}>
                <Factory className="mr-2 h-4 w-4" aria-hidden="true" /> New job
              </Button>
            ) : (
              <Link
                href="/production/new"
                className="inline-flex min-h-[40px] items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600"
              >
                <Factory className="mr-2 h-4 w-4" aria-hidden="true" /> New job
              </Link>
            )}
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Edit2 className="mr-2 h-4 w-4" aria-hidden="true" /> Edit
            </Button>
            <ProductActionsMenu product={product} isAdmin={isAdmin} photoCount={photoCount} onChanged={onChanged} />
            <EditProductDialog product={product} open={editOpen} onClose={() => setEditOpen(false)} onSaved={onChanged} />
          </>
        )}
      </div>
    </div>
  );
}
