'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { ProductDetail } from '@/lib/types/api';
import { DeleteProductDialog } from './DeleteProductDialog';

interface Props {
  product: ProductDetail;
  isAdmin: boolean;
  photoCount: number | null;
  /** After activate/deactivate; the page reloads. */
  onChanged: () => void;
}

/** "More ▾" disclosure menu: Activate/Deactivate, Delete… (admin only). Rendered only for editors. */
export function ProductActionsMenu({ product, isAdmin, photoCount, onChanged }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function toggleActive() {
    setOpen(false);
    setBusy(true);
    const next = !product.isActive;
    try {
      await api.patch(`/products/${product.id}`, { isActive: next });
      toast('success', next ? 'Product activated' : 'Product deactivated — hidden from the shop and pickers');
      onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  const itemClass =
    'block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-800';

  return (
    <div ref={wrapRef} className="relative">
      <Button
        variant="outline"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={busy}
        onClick={() => setOpen(o => !o)}
      >
        More <ChevronDown className="h-4 w-4 ml-1" aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <button type="button" role="menuitem" className={`${itemClass} text-gray-700 dark:text-gray-200`} onClick={toggleActive}>
            {product.isActive ? 'Deactivate' : 'Activate'}
          </button>
          {isAdmin && (
            <button
              type="button"
              role="menuitem"
              className={`${itemClass} text-red-600 dark:text-red-400`}
              onClick={() => { setOpen(false); setShowDelete(true); }}
            >
              Delete…
            </button>
          )}
        </div>
      )}
      {isAdmin && (
        <DeleteProductDialog
          product={product}
          photoCount={photoCount}
          open={showDelete}
          onClose={() => setShowDelete(false)}
          onDeactivated={onChanged}
        />
      )}
    </div>
  );
}
