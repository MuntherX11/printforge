'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { plural } from '@/lib/product-format';
import type { ApiProductHistory, ProductDetail } from '@/lib/types/api';

interface Props {
  product: ProductDetail;
  /** Number of photos, when loaded (for the "will be deleted" list). */
  photoCount: number | null;
  open: boolean;
  onClose: () => void;
  /** After a deactivate from this dialog; the page reloads. */
  onDeactivated: () => void;
}

function historyText(name: string, h: ApiProductHistory): string {
  return `"${name}" has ${plural(h.orderLines, 'order line')}, ${plural(h.quoteLines, 'quote line')} and ${plural(h.jobs, 'job')} — deactivate it instead.`;
}

function deletionList(product: ProductDetail, photoCount: number | null): string[] {
  const components = product.components.length + product.sizes.reduce((s, z) => s + z.components.length, 0);
  const layouts = [...product.components, ...product.sizes.flatMap(z => z.components)]
    .reduce((s, c) => s + c.plateLayouts.length, 0);
  const tiers = product.priceTiers.length + product.sizes.reduce((s, z) => s + z.priceTiers.length, 0);
  const items: string[] = [];
  if (components > 0) items.push(`${plural(components, 'printed component')}, with their slicer files and printed stock`);
  if (layouts > 0) items.push(plural(layouts, 'plate layout'));
  if (product.sizes.length > 0) items.push(plural(product.sizes.length, 'size'));
  if (product.colours.length > 0) items.push(plural(product.colours.length, 'colour'));
  if (product.colourSlots.length > 0) items.push(plural(product.colourSlots.length, 'colour slot'));
  if (tiers > 0) items.push(plural(tiers, 'bulk price tier'));
  if (photoCount && photoCount > 0) items.push(plural(photoCount, 'photo'));
  items.push('its parts & hardware list (the parts themselves stay in the catalog)');
  return items;
}

/**
 * Delete vs deactivate (spec §3.10, §5.1). A product with orders, quotes or
 * jobs can only be deactivated, because deleting it would break those records.
 */
export function DeleteProductDialog({ product, photoCount, open, onClose, onDeactivated }: Props) {
  const router = useRouter();
  const [history, setHistory] = useState<ApiProductHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'deactivate' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadHistory() {
    setHistory(null);
    setLoadError(null);
    api.get<ApiProductHistory>(`/products/${product.id}/history`)
      .then(setHistory)
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Couldn\'t check the history'));
  }

  useEffect(() => {
    if (open) { setError(null); loadHistory(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product.id]);

  async function deactivate() {
    setBusy('deactivate');
    setError(null);
    try {
      await api.patch(`/products/${product.id}`, { isActive: false });
      onDeactivated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deactivate failed');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    setError(null);
    try {
      await api.delete(`/products/${product.id}`);
      router.push('/products');
    } catch (err) {
      // 409: history appeared since the check — show the server's text and re-check.
      setError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(null);
      loadHistory();
    }
  }

  const close = busy ? () => undefined : onClose;
  const hasHistory = history ? !history.canDelete : false;

  return (
    <Dialog open={open} onClose={close} title={`Delete "${product.name}"?`}>
      <div className="space-y-4 text-sm text-gray-600 dark:text-gray-300">
        {!history && !loadError && <p>Checking orders, quotes and jobs…</p>}
        {loadError && (
          <p className="text-red-600 dark:text-red-400">
            {loadError}{' '}
            <button type="button" className="underline" onClick={loadHistory}>Retry</button>
          </p>
        )}

        {history && hasHistory && (
          <>
            <p className="font-medium text-gray-900 dark:text-gray-100">{historyText(product.name, history)}</p>
            <p>
              Deleting it would break those records. Deactivating hides it from the shop and every picker,
              and keeps its orders, quotes and jobs intact. You can activate it again later.
            </p>
            {!product.isActive && <p>It is already inactive.</p>}
          </>
        )}

        {history && !hasHistory && (
          <>
            <p>It has no orders, quotes or jobs. Deleting it permanently removes:</p>
            <ul className="list-disc pl-5 space-y-1">
              {deletionList(product, photoCount).map(item => <li key={item}>{item}</li>)}
            </ul>
            <p>This can&apos;t be undone. Deactivating instead hides it and keeps everything.</p>
          </>
        )}

        {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Button>
          {history && product.isActive && (
            <Button
              type="button"
              variant={hasHistory ? 'primary' : 'outline'}
              onClick={deactivate}
              disabled={!!busy}
            >
              {busy === 'deactivate' ? 'Deactivating…' : 'Deactivate'}
            </Button>
          )}
          {history && !hasHistory && (
            <Button type="button" variant="destructive" onClick={remove} disabled={!!busy}>
              {busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
