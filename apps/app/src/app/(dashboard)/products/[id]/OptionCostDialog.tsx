'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatPct } from '@/lib/product-format';
import { cn } from '@/lib/utils';
import type { ApiPairCost, CellCost, OptionCost, ProductCostPayload } from '@/lib/types/api';
import { CostBreakdownTable } from './CostBreakdownTable';
import { errorText } from './options-ui';

export type CostTarget =
  | { kind: 'SIZE'; sizeOptionId: string | null; label: string }
  | { kind: 'COLOUR'; colourOptionId: string; label: string };

interface Props {
  productId: string;
  target: CostTarget | null;
  cost: ProductCostPayload | null;
  onClose: () => void;
}

/**
 * The `Cost` action of both tables (spec §5.2 C). A size shows its
 * CostBreakdownTable (standard colour). A colour shows its one per-pair table:
 * size | cost | price | margin, excluded sizes greyed; a row opens the P16
 * pair breakdown.
 */
export function OptionCostDialog({ productId, target, cost, onClose }: Props) {
  const formatCurrency = useFormatCurrency();
  const [pair, setPair] = useState<{ cell: CellCost; cost: OptionCost | null; error: string | null } | null>(null);

  useEffect(() => { setPair(null); }, [target]);

  if (!target) return null;

  async function openPair(cell: CellCost) {
    setPair({ cell, cost: null, error: null });
    const q = new URLSearchParams({ sizeOptionId: cell.sizeOptionId ?? 'standard', colourOptionId: cell.colourOptionId ?? 'standard' });
    try {
      const r = await api.get<ApiPairCost>(`/products/${productId}/cost?${q.toString()}`);
      setPair(p => (p && p.cell === cell ? { ...p, cost: r.pair } : p));
    } catch (err) {
      setPair(p => (p && p.cell === cell ? { ...p, error: errorText(err, "Couldn't load the cost") } : p));
    }
  }

  let body: React.ReactNode;
  if (!cost) {
    body = <p className="text-sm text-gray-500 dark:text-gray-400">The cost isn&apos;t loaded yet.</p>;
  } else if (target.kind === 'SIZE') {
    const oc = cost.sizes.find(s => s.sizeOptionId === target.sizeOptionId && s.colourOptionId === null);
    body = oc ? <CostBreakdownTable cost={oc} /> : <p className="text-sm text-gray-500">No cost for this size.</p>;
  } else if (pair) {
    body = (
      <div className="space-y-3">
        <Button type="button" size="sm" variant="ghost" onClick={() => setPair(null)}>← All sizes</Button>
        {pair.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{pair.error}</p>}
        {!pair.error && !pair.cost && <Loading />}
        {pair.cost && <CostBreakdownTable cost={pair.cost} />}
      </div>
    );
  } else {
    const rows = cost.cells.filter(c => c.colourOptionId === target.colourOptionId);
    body = (
      <div className="space-y-2">
        <p className="text-xs text-gray-500 dark:text-gray-400">The price is the size&apos;s price; the colour only changes the cost. Click a row for its breakdown.</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Size</TableHead>
              <TableHead className="text-right">Cost / unit</TableHead>
              <TableHead className="text-right">Price / unit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(c => (
              <TableRow
                key={`${c.sizeOptionId ?? 'standard'}`}
                className={cn('cursor-pointer', (c.excluded || !c.active) && 'text-gray-400 dark:text-gray-500')}
                onClick={() => void openPair(c)}
              >
                <TableCell>
                  <button type="button" className="text-left hover:underline" onClick={e => { e.stopPropagation(); void openPair(c); }}>
                    {c.sizeLabel}
                  </button>
                  {c.excluded && <span className="ml-2 text-xs">not made in this size</span>}
                  {!c.excluded && !c.active && <span className="ml-2 text-xs">inactive</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.costPerUnit != null ? formatCurrency(c.costPerUnit) : '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{c.price != null ? formatCurrency(c.price) : 'Not set'}</TableCell>
                <TableCell className="text-right tabular-nums">{c.marginPct != null ? formatPct(c.marginPct) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  const title = target.kind === 'SIZE'
    ? `Cost — ${target.label}`
    : pair ? `Cost — ${pair.cell.sizeLabel} · ${target.label}` : `Cost — ${target.label} per size`;

  return (
    <Dialog open onClose={onClose} title={title} className="max-h-[90vh] max-w-3xl overflow-y-auto">
      {body}
    </Dialog>
  );
}
