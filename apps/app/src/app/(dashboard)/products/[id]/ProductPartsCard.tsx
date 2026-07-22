'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, Trash2, Nut, AlertTriangle } from 'lucide-react';

interface Part {
  id: string;
  name: string;
  sku?: string | null;
  unitCost: number;
  stockQty: number;
  reorderPoint: number;
}

interface ProductPartLine {
  id: string;
  partId: string;
  quantity: number;
  part: Part;
}

/**
 * Non-printed parts on a product's BOM (NFC tags, heat inserts, keyrings…).
 * These are per-unit costs added on top of filament + machine time.
 */
export function ProductPartsCard({ productId }: { productId: string }) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();

  const [lines, setLines] = useState<ProductPartLine[]>([]);
  const [catalog, setCatalog] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [partId, setPartId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api.get<ProductPartLine[]>(`/products/${productId}/parts`)
      .then(r => setLines(Array.isArray(r) ? r : []))
      .catch(() => setLines([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    api.get<Part[]>('/parts')
      .then(r => setCatalog(Array.isArray(r) ? r : []))
      .catch(() => setCatalog([]));
  }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!partId) return toast('error', 'Pick a part');
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) return toast('error', 'Quantity must be at least 1');
    setSaving(true);
    try {
      await api.post(`/products/${productId}/parts`, { partId, quantity: qty });
      toast('success', 'Part added to BOM');
      setShowAdd(false);
      setPartId('');
      setQuantity('1');
      load();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to add part');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(line: ProductPartLine) {
    setBusyId(line.id);
    try {
      await api.delete(`/products/${productId}/parts/${line.partId}`);
      setLines(prev => prev.filter(l => l.id !== line.id));
    } catch (err: any) {
      toast('error', err?.message || 'Failed to remove part');
    } finally {
      setBusyId(null);
    }
  }

  const partsCost = lines.reduce((sum, l) => sum + l.part.unitCost * l.quantity, 0);
  // Parts already on the BOM shouldn't appear again in the picker
  const available = catalog.filter(p => !lines.some(l => l.partId === p.id));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Nut className="h-4 w-4" /> Parts &amp; Hardware
        </CardTitle>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add Part
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="py-8 text-center text-sm text-gray-500">Loading…</div>
        ) : lines.length === 0 ? (
          <div className="py-8 text-center text-gray-500 dark:text-gray-400">
            <p className="text-sm">No parts on this product.</p>
            <p className="text-xs mt-1">
              Add bought-in hardware (NFC tags, inserts, keyrings) from the{' '}
              <Link href="/parts" className="text-brand-600 dark:text-brand-400 hover:underline">Parts</Link> catalog.
            </p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Part</TableHead>
                  <TableHead>Qty / unit</TableHead>
                  <TableHead>Unit Cost</TableHead>
                  <TableHead>Line Cost</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map(line => {
                  const isLow = line.part.reorderPoint > 0 && line.part.stockQty <= line.part.reorderPoint;
                  return (
                    <TableRow key={line.id}>
                      <TableCell>
                        <div className="font-medium dark:text-gray-100">{line.part.name}</div>
                        {line.part.sku && <div className="text-xs text-gray-400 font-mono">{line.part.sku}</div>}
                      </TableCell>
                      <TableCell className="tabular-nums">{line.quantity}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(line.part.unitCost)}</TableCell>
                      <TableCell className="tabular-nums font-medium">
                        {formatCurrency(line.part.unitCost * line.quantity)}
                      </TableCell>
                      <TableCell>
                        <span className={`tabular-nums ${isLow ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                          {line.part.stockQty}
                        </span>
                        {isLow && <AlertTriangle className="inline h-3.5 w-3.5 ml-1 text-red-500" aria-label="Low stock" />}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="destructive" size="sm" disabled={busyId === line.id} onClick={() => handleRemove(line)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="flex justify-between items-center px-4 py-3 border-t dark:border-gray-700 text-sm">
              <span className="text-gray-500 dark:text-gray-400">Parts cost per unit</span>
              <span className="font-semibold tabular-nums dark:text-gray-100">{formatCurrency(partsCost)}</span>
            </div>
            <p className="px-4 pb-3 text-xs text-gray-400">
              Included in the product cost. Stock is deducted automatically when a production job for this product completes.
            </p>
          </>
        )}
      </CardContent>

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add Part to BOM">
        {catalog.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No parts in the catalog yet. Create one on the{' '}
            <Link href="/parts" className="text-brand-600 dark:text-brand-400 hover:underline">Parts</Link> page first.
          </p>
        ) : (
          <form onSubmit={handleAdd} className="space-y-4">
            <Select
              label="Part"
              value={partId}
              onChange={e => setPartId(e.target.value)}
              options={[
                { value: '', label: '— select a part —' },
                ...available.map(p => ({
                  value: p.id,
                  label: `${p.name}${p.sku ? ` (${p.sku})` : ''} — ${p.unitCost.toFixed(3)} / pc, ${p.stockQty} in stock`,
                })),
              ]}
            />
            {available.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Every part in the catalog is already on this BOM.
              </p>
            )}
            <Input
              label="Quantity per product unit"
              type="number"
              min="1"
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
            />
            <div className="flex gap-3 justify-end pt-2">
              <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button type="submit" disabled={saving || !partId}>{saving ? 'Adding…' : 'Add Part'}</Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
