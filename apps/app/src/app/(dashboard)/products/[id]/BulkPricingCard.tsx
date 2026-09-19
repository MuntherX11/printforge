'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, Trash2, AlertTriangle, TrendingDown } from 'lucide-react';

interface Tier { minQty: number | ''; unitPrice: number | ''; }
interface FloorRow { qty: number; unitCost: number; calibrated: boolean; }

/**
 * Staff-set quantity price breaks, checked live against the true cost floor.
 *
 * The floor comes from /bulk-costs: components with plate calibration amortise
 * setup and colour-change time across the plate; uncalibrated ones are assumed
 * linear, which over-states cost — so a green margin here is trustworthy, and
 * a red one is a real loss, not an estimate artefact.
 */
export function BulkPricingCard({ productId, basePrice, initialTiers, onSaved }: {
  productId: string;
  basePrice: number;
  initialTiers: Array<{ minQty: number; unitPrice: number }>;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();
  const [tiers, setTiers] = useState<Tier[]>(initialTiers.map(t => ({ ...t })));
  const [floors, setFloors] = useState<Record<number, FloorRow>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { setTiers(initialTiers.map(t => ({ ...t }))); }, [JSON.stringify(initialTiers)]);

  // Refresh the floor for the quantities on screen (debounced — it prices a
  // whole BOM per quantity).
  const qtyKey = tiers.map(t => t.minQty).filter(q => q !== '' && Number(q) >= 2).join(',');
  useEffect(() => {
    if (!qtyKey) { setFloors({}); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.get<any>(`/products/${productId}/bulk-costs?qtys=1,${qtyKey}`)
        .then(r => {
          if (cancelled) return;
          const map: Record<number, FloorRow> = {};
          for (const row of r?.results || []) map[row.qty] = row;
          setFloors(map);
        })
        .catch(() => { if (!cancelled) setFloors({}); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [qtyKey, productId]);

  function marginFor(t: Tier): { pct: number; calibrated: boolean } | null {
    if (t.minQty === '' || t.unitPrice === '' || !Number(t.unitPrice)) return null;
    const f = floors[Number(t.minQty)];
    if (!f) return null;
    return { pct: ((Number(t.unitPrice) - f.unitCost) / Number(t.unitPrice)) * 100, calibrated: f.calibrated };
  }

  async function save() {
    setSaving(true);
    try {
      const clean = tiers
        .filter(t => t.minQty !== '' && t.unitPrice !== '')
        .map(t => ({ minQty: Number(t.minQty), unitPrice: Number(t.unitPrice) }));
      await api.put(`/products/${productId}/price-tiers`, { tiers: clean });
      toast('success', clean.length ? `${clean.length} price tier${clean.length === 1 ? '' : 's'} saved` : 'Bulk pricing cleared');
      onSaved();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2"><TrendingDown className="h-4 w-4" /> Bulk Pricing</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setTiers(prev => [...prev, { minQty: '', unitPrice: '' }])}>
            <Plus className="h-4 w-4 mr-1" /> Add Tier
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Applied automatically on the staff order form by line quantity. Customers never see these —
          single price is {formatCurrency(basePrice)}.
        </p>
        {tiers.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">No tiers — every quantity pays {formatCurrency(basePrice)}.</p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[90px_1fr_1fr_36px] gap-2 text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              <span>Min qty</span><span>Price / unit</span><span>Margin vs true cost</span><span />
            </div>
            {tiers.map((t, i) => {
              const m = marginFor(t);
              return (
                <div key={i} className="grid grid-cols-[90px_1fr_1fr_36px] items-center gap-2">
                  <input
                    type="number" min={2} step={1} value={t.minQty}
                    onChange={e => setTiers(prev => prev.map((x, j) => j === i ? { ...x, minQty: e.target.value === '' ? '' : parseInt(e.target.value) } : x))}
                    className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <input
                    type="number" min={0.001} step={0.001} value={t.unitPrice}
                    onChange={e => setTiers(prev => prev.map((x, j) => j === i ? { ...x, unitPrice: e.target.value === '' ? '' : parseFloat(e.target.value) } : x))}
                    className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm tabular-nums dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <span className="text-sm tabular-nums">
                    {m === null ? (
                      <span className="text-gray-400">—</span>
                    ) : m.pct < 0 ? (
                      <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                        <AlertTriangle className="h-3.5 w-3.5" /> {m.pct.toFixed(0)}% — below cost
                      </span>
                    ) : m.pct < 20 ? (
                      <span className="text-amber-600 dark:text-amber-400">{m.pct.toFixed(0)}% — thin</span>
                    ) : (
                      <span className="text-green-600 dark:text-green-400">{m.pct.toFixed(0)}%{m.calibrated ? '' : ' (uncalibrated — real margin is higher)'}</span>
                    )}
                  </span>
                  <button type="button" aria-label="Remove tier"
                    onClick={() => setTiers(prev => prev.filter((_, j) => j !== i))}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Tiers'}</Button>
          {floors[1] && (
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              True cost per unit at qty 1: {formatCurrency(floors[1].unitCost)}
              {!floors[1].calibrated && ' (linear estimate — calibrate component plates for the real curve)'}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
