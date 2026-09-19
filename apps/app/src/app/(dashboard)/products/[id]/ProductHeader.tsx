'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Edit2, Factory, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { plural } from '@/lib/product-format';
import type { ProductDetail } from '@/lib/types/api';
import { EditProductDialog } from './EditProductDialog';
import { ProductActionsMenu } from './ProductActionsMenu';

interface Props {
  product: ProductDetail;
  /** Cover photo URL: the first loaded photo, else the product's cover. */
  coverUrl: string | null;
  photoCount: number | null;
  canEdit: boolean;
  isAdmin: boolean;
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

/** Section A (spec §5.2): photo, name, status, options, SKU, description, actions. */
export function ProductHeader({ product, coverUrl, photoCount, canEdit, isAdmin, onChanged, onNewJob }: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const options = optionBadge(product);

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
          {coverUrl ? (
            // Logged-in photo route (G5): the browser must send the session cookie,
            // so next/image's server-side optimiser can't fetch it.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt={`${product.name} cover photo`} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-400 dark:text-gray-500" aria-label="No photo">
              <Package className="h-7 w-7" aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 break-words">{product.name}</h1>
            <Badge variant={product.isActive ? 'success' : 'default'}>{product.isActive ? 'Active' : 'Inactive'}</Badge>
            {options && <Badge variant="info">{options}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {product.sku ? <span className="font-mono">{product.sku}</span> : 'No SKU'}
          </p>
          {product.description && (
            <p className="mt-1 max-w-3xl whitespace-pre-line text-sm text-gray-600 dark:text-gray-300">{product.description}</p>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {onNewJob ? (
            <Button onClick={onNewJob}>
              <Factory className="h-4 w-4 mr-2" aria-hidden="true" /> New job
            </Button>
          ) : (
            <Link
              href="/production/new"
              className="inline-flex min-h-[40px] items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600"
            >
              <Factory className="h-4 w-4 mr-2" aria-hidden="true" /> New job
            </Link>
          )}
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Edit2 className="h-4 w-4 mr-2" aria-hidden="true" /> Edit
          </Button>
          <ProductActionsMenu product={product} isAdmin={isAdmin} photoCount={photoCount} onChanged={onChanged} />
          <EditProductDialog product={product} open={editOpen} onClose={() => setEditOpen(false)} onSaved={onChanged} />
        </div>
      )}
    </div>
  );
}
