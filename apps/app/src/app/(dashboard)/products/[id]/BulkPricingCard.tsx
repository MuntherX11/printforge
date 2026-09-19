'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { bandLabel, formatAmount, formatPct } from '@/lib/product-format';
import type { BulkFloor, PriceTierRow, ProductDetail } from '@/lib/types/api';
import { errorText } from './options-ui';
import { STANDARD_KEY } from './options-model';
import { scopeLabel, scopeOptions } from './bom-model';
import {
  basisLine, checkTiers, draftsOf, marginTone, newDraft, sameTiers, sortDrafts, tiersBody, type TierDraft,
} from './bulk-pricing-model';

interface Props {
  product: ProductDetail;
  costVersion: string | null;
  canEdit: boolean;
  onSaved: () => void;
}

const COPY = 'Staff-only. Applied automatically on New Order and New Quote lines. The quantity counts every line of this size on the order, whatever the colour (for example 15 Red + 10 Black = 25). Different sizes never count together. Customers never see tiers; the customer shop always charges the list price. Staff can still type a different line price — they\'ll see a warning below cost.';
const TONE = { below: 'text-red-600 dark:text-red-400', thin: 'text-amber-700 dark:text-amber-300', ok: 'text-green-700 dark:text-green-400' };
const cellInput = 'h-8 w-24 rounded-md border bg-white px-2 text-sm tabular-nums dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/** Section H (spec §5.2 H): fixed unit prices per quantity band, per size; margins warn, never block. */
export function BulkPricingCard({ product, costVersion, canEdit, onSaved }: Props) {
  const { toast } = useToast();
  const fmt = useFormatCurrency();
  const [sizeKey, setSizeKey] = useState(STANDARD_KEY);
  const saved: PriceTierRow[] = useMemo(
    () => (sizeKey === STANDARD_KEY ? product.priceTiers : product.sizes.find(s => s.id === sizeKey)?.priceTiers ?? []),
    [product, sizeKey],
  );
  const savedKey = JSON.stringify(saved.map(t => [t.minQty, t.unitPrice]));
  const [rows, setRows] = useState<TierDraft[]>(() => draftsOf(saved));
  const [floor, setFloor] = useState<{ data: BulkFloor | null; error: string | null }>({ data: null, error: null });
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(draftsOf(saved)); }, [sizeKey, savedKey]);
  useEffect(() => { if (!product.sizes.some(s => s.id === sizeKey)) setSizeKey(STANDARD_KEY); }, [product.sizes, sizeKey]);

  const listPrice = floor.data?.size.listPrice ?? null;
  const checks = checkTiers(rows, listPrice, fmt);
  const body = tiersBody(checks);
  const dirty = !body || !sameTiers(body, saved);
  const qtys = [...new Set(checks.map(c => c.minQty).filter((q): q is number => q !== null))].sort((a, b) => a - b);
  const qtyKey = qtys.slice(0, 20).join(',');

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      const q = new URLSearchParams();
      if (sizeKey !== STANDARD_KEY) q.set('sizeOptionId', sizeKey);
      if (qtyKey) q.set('minQtys', qtyKey);
      api.get<BulkFloor>(`/products/${product.id}/bulk-floor?${q}`)
        .then(data => { if (live) setFloor({ data, error: null }); })
        .catch(err => { if (live) setFloor(f => ({ data: f.data, error: errorText(err, 'Couldn\'t load the cost floor') })); });
    }, 400);
    return () => { live = false; window.clearTimeout(t); };
  }, [product.id, sizeKey, qtyKey, costVersion, retry]);

  const update = (key: number, patch: Partial<TierDraft>) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const save = useCallback(async () => {
    if (!body) return;
    setSaving(true);
    try {
      await api.put(`/products/${product.id}/price-tiers`, { sizeOptionId: sizeKey === STANDARD_KEY ? null : sizeKey, tiers: body });
      toast('success', body.length ? `Saved ${body.length} tier${body.length === 1 ? '' : 's'} for ${scopeLabel(product, sizeKey)}` : 'Bulk pricing cleared');
      onSaved();
    } catch (err) {
      toast('error', errorText(err, 'Couldn\'t save the tiers'));
    } finally {
      setSaving(false);
    }
  }, [body, product, sizeKey, toast, onSaved]);

  const f = floor.data;
  const multiColour = (f?.colours.length ?? 0) > 1;
  const unknown = f?.problems.filter(p => p.code === 'COLOUR_COST_UNKNOWN') ?? [];
  const blocking = f && !f.available ? f.problems.filter(p => p.code !== 'COLOUR_COST_UNKNOWN') : [];
  const thin = f?.thinMarginPct ?? 20;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Bulk pricing (staff only)</CardTitle>
            {product.sizes.length > 0 && (
              <select aria-label="Size" value={sizeKey} onChange={e => setSizeKey(e.target.value)}
                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
                {scopeOptions(product).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
            {canEdit && dirty && <Badge variant="warning">Unsaved changes</Badge>}
          </div>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setRows(rs => [...rs, newDraft()])} disabled={rows.length >= 20}>
              <Plus className="mr-1 h-4 w-4" /> Add tier
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-gray-600 dark:text-gray-400">{COPY}{product.sizes.length > 0 && ' Each size has its own tiers.'}</p>
        {floor.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Couldn&apos;t load the cost floor — <button type="button" className="font-medium underline" onClick={() => setRetry(n => n + 1)}>Retry</button>
          </p>
        )}
        {blocking.map((p, i) => <p key={i} className="text-sm text-red-600 dark:text-red-400">{p.message}</p>)}
        {unknown.map((p, i) => (
          <p key={i} className="text-sm text-amber-700 dark:text-amber-300">{p.message} — set its cost per gram on the Filaments page; it is not in the worst case.</p>
        ))}

        {rows.length === 0 ? (
          <p className="py-3 text-center text-sm text-gray-500 dark:text-gray-400">
            No tiers — every quantity of {scopeLabel(product, sizeKey)} pays the list price{listPrice !== null ? ` (${fmt(listPrice)})` : ''}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="py-2 pr-3">Band</th><th className="pr-3">Min qty</th><th className="pr-3">Price / unit</th>
                  <th className="pr-3">vs list</th><th className="pr-3">Example order</th><th className="pr-3">Cost / unit (worst in band)</th>
                  <th className="pr-3">Profit / unit</th><th className="pr-3">Margin</th><th className="pr-3">Lowest price at {thin} % margin</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const c = checks[i];
                  const next = qtys.find(q => c.minQty !== null && q > c.minQty);
                  const band = c.minQty !== null ? f?.bands.find(b => b.minQty === c.minQty) : undefined;
                  const price = c.unitPrice;
                  const margin = band && price ? ((price - band.worstUnitCost) / price) * 100 : null;
                  return (
                    <tr key={r.key} className="border-b align-top last:border-0 dark:border-gray-800">
                      <td className="py-2 pr-3 whitespace-nowrap">{c.minQty !== null ? bandLabel(c.minQty, next) : '—'}</td>
                      <td className="py-2 pr-3">
                        {canEdit ? (
                          <input aria-label={`Tier ${i + 1} minimum quantity`} inputMode="numeric" value={r.minQty}
                            onChange={e => update(r.key, { minQty: e.target.value })} onBlur={() => setRows(sortDrafts)}
                            className={cn(cellInput, c.errors.minQty ? 'border-red-500' : 'border-gray-300 dark:border-gray-600')} />
                        ) : c.minQty}
                        {canEdit && c.errors.minQty && <p className="text-xs text-red-600 dark:text-red-400">{c.errors.minQty}</p>}
                      </td>
                      <td className="py-2 pr-3">
                        {canEdit ? (
                          <input aria-label={`Tier ${i + 1} price per unit`} inputMode="decimal" value={r.unitPrice}
                            onChange={e => update(r.key, { unitPrice: e.target.value })}
                            className={cn(cellInput, c.errors.unitPrice ? 'border-red-500' : 'border-gray-300 dark:border-gray-600')} />
                        ) : price !== null ? fmt(price) : '—'}
                        {canEdit && c.errors.unitPrice && <p className="text-xs text-red-600 dark:text-red-400">{c.errors.unitPrice}</p>}
                        {c.warnings.map(w => <p key={w} className="text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{price !== null && listPrice ? `${price < listPrice ? '−' : '+'}${Math.abs(Math.round(((price - listPrice) / listPrice) * 100))} %` : '—'}</td>
                      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                        {price !== null && c.minQty !== null ? `${c.minQty} × ${formatAmount(price)} = ${formatAmount(Math.round(c.minQty * price * 1000) / 1000)}` : '—'}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {band ? (
                          <>
                            <span>{fmt(band.worstUnitCost)} at qty {band.worstAtQty}{multiColour ? ` · ${band.worstColour.label}` : ''}</span>
                            {multiColour && <p className="text-xs text-gray-500 dark:text-gray-400">standard colour {fmt(band.standardWorstUnitCost)}</p>}
                            <p className="text-xs text-gray-500 dark:text-gray-400">{basisLine(band)}</p>
                          </>
                        ) : '—'}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{band && price !== null ? fmt(price - band.worstUnitCost) : '—'}</td>
                      <td className={cn('py-2 pr-3 whitespace-nowrap tabular-nums', margin !== null && TONE[marginTone(margin, thin)])}>
                        {margin === null ? '—' : `${formatPct(margin)}${margin < 0 ? ' below cost' : margin < thin ? ' thin' : ''}`}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{band && thin < 100 ? fmt(band.worstUnitCost / (1 - thin / 100)) : '—'}</td>
                      {canEdit && (
                        <td className="py-2">
                          <button type="button" aria-label={`Remove tier ${i + 1}`} onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))}
                            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {canEdit && <Button onClick={() => void save()} disabled={saving || !body || !dirty}>{saving ? 'Saving…' : 'Save tiers'}</Button>}
          {f?.unitCostAtOne != null && (
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              Cost per unit at qty 1 for {f.size.label}, standard colour: {fmt(f.unitCostAtOne)}{sizeKey === STANDARD_KEY ? ' (same as the Pricing card)' : ''}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
