'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Minus, Nut, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import type { ApiPart, ApiProductPartLine } from '@/lib/types/api';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  productId: string;
  canEdit: boolean;
  /** A parts change reprices the product: the page reloads product and cost. */
  onChanged: () => void;
}

const MAX_QTY = 1000;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Section I (spec §5.2): bought-in parts per product unit, included in the price. */
export function ProductPartsCard({ productId, canEdit, onChanged }: Props) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();

  const [lines, setLines] = useState<ApiProductPartLine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ApiPart[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [partId, setPartId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [addError, setAddError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyPartId, setBusyPartId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ApiProductPartLine | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api.get<ApiProductPartLine[]>(`/products/${productId}/parts`)
      .then(r => setLines(Array.isArray(r) ? r : []))
      .catch(err => setLoadError(errorText(err, 'Couldn\'t load parts')));
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  function openAdd() {
    setPartId('');
    setQuantity('1');
    setAddError(null);
    setShowAdd(true);
    if (!catalog) {
      api.get<ApiPart[]>('/parts')
        .then(r => setCatalog(Array.isArray(r) ? r : []))
        .catch(err => { setCatalog([]); setAddError(errorText(err, 'Couldn\'t load the parts catalog')); });
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const qty = Number(quantity);
    if (!partId) { setAddError('Pick a part'); return; }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      setAddError('Quantity must be a whole number from 1 to 1000');
      return;
    }
    setSaving(true);
    setAddError(null);
    try {
      await api.post(`/products/${productId}/parts`, { partId, quantity: qty });
      setShowAdd(false);
      load();
      onChanged();
    } catch (err) {
      setAddError(errorText(err, 'Couldn\'t add the part'));
    } finally {
      setSaving(false);
    }
  }

  async function setQty(line: ApiProductPartLine, qty: number) {
    if (qty < 1 || qty > MAX_QTY) return;
    setBusyPartId(line.partId);
    try {
      await api.post(`/products/${productId}/parts`, { partId: line.partId, quantity: qty });
      load();
      onChanged();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t change the quantity'));
    } finally {
      setBusyPartId(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setBusyPartId(removing.partId);
    setRemoveError(null);
    try {
      await api.delete(`/products/${productId}/parts/${removing.partId}`);
      setRemoving(null);
      load();
      onChanged();
    } catch (err) {
      setRemoveError(errorText(err, 'Couldn\'t remove the part'));
    } finally {
      setBusyPartId(null);
    }
  }

  const partsCost = (lines ?? []).reduce((sum, l) => sum + l.part.unitCost * l.quantity, 0);
  // Inactive parts can't be added (P21), and parts already on the list aren't offered again.
  const available = (catalog ?? []).filter(p => p.isActive && !(lines ?? []).some(l => l.partId === p.id));

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">
        Couldn&apos;t load parts — {loadError}.{' '}
        <button type="button" className="underline" onClick={load}>Retry</button>
      </p>
    );
  } else if (!lines) {
    body = <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  } else if (lines.length === 0) {
    body = (
      <div className="py-8 text-center text-gray-500 dark:text-gray-400">
        <p className="text-sm">No parts on this product.</p>
        <p className="mt-1 text-xs">
          Bought-in hardware (NFC tags, inserts, keyrings) comes from the{' '}
          <Link href="/parts" className="text-brand-600 hover:underline dark:text-brand-400">Parts</Link> catalog.
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead>Per product unit</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Line cost</TableHead>
              <TableHead>Stock</TableHead>
              {canEdit && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map(line => {
              const isLow = line.part.reorderPoint > 0 && line.part.stockQty <= line.part.reorderPoint;
              const busy = busyPartId === line.partId;
              return (
                <TableRow key={line.id}>
                  <TableCell>
                    <div className="font-medium dark:text-gray-100">{line.part.name}</div>
                    {line.part.sku && <div className="font-mono text-xs text-gray-400">{line.part.sku}</div>}
                    {!line.part.isActive && <div className="text-xs text-amber-600 dark:text-amber-400">Inactive in the catalog</div>}
                  </TableCell>
                  <TableCell>
                    {canEdit ? (
                      <div className="inline-flex items-center gap-1">
                        <Button variant="outline" size="sm" className="px-2" aria-label={`One fewer ${line.part.name}`}
                          disabled={busy || line.quantity <= 1} onClick={() => void setQty(line, line.quantity - 1)}>
                          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <span className="w-14 text-center tabular-nums">{line.quantity} pcs</span>
                        <Button variant="outline" size="sm" className="px-2" aria-label={`One more ${line.part.name}`}
                          disabled={busy || line.quantity >= MAX_QTY} onClick={() => void setQty(line, line.quantity + 1)}>
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    ) : (
                      <span className="tabular-nums">{line.quantity} pcs</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(line.part.unitCost)} / pc</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(line.part.unitCost * line.quantity)}</TableCell>
                  <TableCell>
                    <span className={`tabular-nums ${isLow ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                      {line.part.stockQty} pcs in stock
                    </span>
                    {isLow && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-red-500" aria-label="Low stock" />}
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" disabled={busy} aria-label={`Remove ${line.part.name}`}
                        onClick={() => { setRemoveError(null); setRemoving(line); }}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm dark:border-gray-700">
          <span className="text-gray-500 dark:text-gray-400">Parts cost per product unit</span>
          <span className="font-semibold tabular-nums dark:text-gray-100">{formatCurrency(partsCost)}</span>
        </div>
      </>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 dark:text-gray-100">
          <Nut className="h-4 w-4" aria-hidden="true" /> Parts &amp; hardware
        </CardTitle>
        {canEdit && (
          <Button size="sm" onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Add part
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {body}
        <p className="px-4 pb-3 pt-2 text-xs text-gray-500 dark:text-gray-400">
          Included in the product price (recalculated automatically). Stock is deducted when a job started from this page
          or from Production → Build Stock completes. Jobs created from an order&apos;s production plan do not deduct parts yet.
        </p>
      </CardContent>

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add part">
        {catalog && catalog.length === 0 && !addError ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No parts in the catalog yet. Create one on the{' '}
            <Link href="/parts" className="text-brand-600 hover:underline dark:text-brand-400">Parts</Link> page first.
          </p>
        ) : (
          <form onSubmit={handleAdd} className="space-y-4" noValidate>
            <Select
              label="Part"
              value={partId}
              onChange={e => setPartId(e.target.value)}
              options={[
                { value: '', label: catalog ? '— select a part —' : 'Loading parts…' },
                ...available.map(p => ({
                  value: p.id,
                  label: `${p.name}${p.sku ? ` (${p.sku})` : ''} — ${formatCurrency(p.unitCost)} / pc, ${p.stockQty} pcs in stock`,
                })),
              ]}
            />
            {catalog && catalog.length > 0 && available.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">Every active part in the catalog is already on this product.</p>
            )}
            <Input label="Pieces per product unit" type="number" min={1} max={MAX_QTY} step={1}
              value={quantity} onChange={e => setQuantity(e.target.value)} />
            {addError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{addError}</p>}
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving || !partId}>{saving ? 'Adding…' : 'Add part'}</Button>
            </div>
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        title="Remove part?"
        message={removing ? `Remove ${removing.part.name} (${removing.quantity} pcs per unit) from this product? The price is recalculated.` : ''}
        confirmLabel="Remove"
        destructive
        busy={removing !== null && busyPartId === removing.partId}
        error={removeError}
        onConfirm={() => void confirmRemove()}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}
