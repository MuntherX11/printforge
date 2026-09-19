'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatAmount, formatGrams, formatMinutes, formatRate } from '@/lib/product-format';
import type { OptionCost } from '@/lib/types/api';

interface Line {
  key: string;
  label: string;
  detail: string;
  amount: number;
  strong?: boolean;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function purgeDetail(c: OptionCost): string {
  if (c.purge.basis === 'SLICER_INCLUDED') return 'included in slicer weights';
  if (c.purge.basis === 'COLOUR_CHANGES') {
    return `${c.purge.changesPerUnit} changes × ${formatGrams(c.purge.gramsPerChange)} = ${formatGrams(c.purge.grams)}`;
  }
  return 'no colour changes';
}

function markupSource(c: OptionCost): string {
  return c.markup.source === 'PRINTER' ? `from printer ${c.markup.printerName ?? ''}`.trim() : 'from Settings';
}

/**
 * One pair's cost, per unit (spec §5.2 B). The component table sums exactly to
 * the printed subtotal (material + machine + electricity + purge + overhead),
 * because the server allocates the rounding residue to the largest line.
 */
export function CostBreakdownTable({ cost }: { cost: OptionCost }) {
  const formatCurrency = useFormatCurrency();
  const pu = cost.perUnit;

  if (!pu) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        <p className="font-medium">The cost of {cost.label} can&apos;t be calculated:</p>
        <ul className="mt-1 list-disc pl-5">
          {cost.problems.map((p, i) => <li key={`${p.code}-${i}`}>{p.message}</li>)}
        </ul>
      </div>
    );
  }

  const m = cost.machine;
  const lines: Line[] = [
    ...cost.materials.map(mat => ({
      key: `mat-${mat.materialId}`,
      label: 'Material',
      detail: `${mat.name} · ${formatGrams(mat.grams)} × ${formatRate(mat.costPerGram)}/g = ${formatAmount(mat.cost)}`,
      amount: mat.cost,
    })),
    { key: 'machine', label: 'Machine', detail: `${formatMinutes(m.minutesPerUnit)} × ${formatRate(m.hourlyRate)}/h (${m.rateSource === 'PRINTER' ? 'printer rate' : 'Settings rate'})`, amount: pu.machine },
    { key: 'electricity', label: 'Electricity', detail: `${m.wattage} W × ${formatRate(m.electricityRatePerKwh)}/kWh`, amount: pu.electricity },
    { key: 'waste', label: 'Purge waste', detail: purgeDetail(cost), amount: pu.waste },
    { key: 'overhead', label: 'Overhead', detail: `${cost.overheadPercent} % of the above`, amount: pu.overhead },
    ...cost.parts.map(p => ({
      key: `part-${p.partId}`,
      label: 'Parts',
      detail: `${p.name} · ${p.quantity} pcs × ${formatRate(p.unitCost)}`,
      amount: p.lineCost,
    })),
    { key: 'total', label: 'Total cost', detail: 'per unit', amount: pu.total, strong: true },
  ];
  const componentSum = round3(cost.components.reduce((s, c) => s + c.cost, 0));
  const price = cost.storedPrice;

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Cost per unit</TableHead>
            <TableHead>How it is worked out</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map(l => (
            <TableRow key={l.key}>
              <TableCell className={l.strong ? 'font-semibold dark:text-gray-100' : 'dark:text-gray-200'}>{l.label}</TableCell>
              <TableCell className="text-gray-600 dark:text-gray-400">{l.detail}</TableCell>
              <TableCell className={`text-right tabular-nums ${l.strong ? 'font-semibold dark:text-gray-100' : 'dark:text-gray-200'}`}>
                {formatCurrency(l.amount)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="dark:text-gray-200">Markup</TableCell>
            <TableCell className="text-gray-600 dark:text-gray-400">{markupSource(cost)}</TableCell>
            <TableCell className="text-right tabular-nums dark:text-gray-200">{cost.markup.multiplier}×</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="font-semibold dark:text-gray-100">Price</TableCell>
            <TableCell className="text-gray-600 dark:text-gray-400">
              {cost.computedPrice !== null && !cost.priceUpToDate
                ? `stored price — the current calculation is ${formatAmount(cost.computedPrice)}`
                : cost.computedPrice !== null ? 'cost × markup, per unit' : 'the size\'s price (colour doesn\'t change it)'}
            </TableCell>
            <TableCell className="text-right tabular-nums font-semibold dark:text-gray-100">
              {price === null ? 'Not set' : formatCurrency(price)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {cost.components.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Component</TableHead>
              <TableHead className="text-right">Units per product</TableHead>
              <TableHead className="text-right">g / unit</TableHead>
              <TableHead className="text-right">min / unit</TableHead>
              <TableHead className="text-right">Cost per product</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cost.components.map(c => (
              <TableRow key={c.componentId}>
                <TableCell className="dark:text-gray-200">{c.description}</TableCell>
                <TableCell className="text-right tabular-nums dark:text-gray-200">{c.quantity}</TableCell>
                <TableCell className="text-right tabular-nums dark:text-gray-200">{formatGrams(c.gramsPerUnit)}</TableCell>
                <TableCell className="text-right tabular-nums dark:text-gray-200">{formatMinutes(c.minutesPerUnit)}</TableCell>
                <TableCell className="text-right tabular-nums dark:text-gray-200">{formatCurrency(c.cost)}</TableCell>
              </TableRow>
            ))}
            <TableRow>
              <td colSpan={4} className="px-4 py-3 align-middle font-medium dark:text-gray-100">
                Printed components (material, machine, electricity, purge and overhead)
              </td>
              <TableCell className="text-right tabular-nums font-medium dark:text-gray-100">{formatCurrency(componentSum)}</TableCell>
            </TableRow>
            {pu.parts > 0 && (
              <TableRow>
                <td colSpan={4} className="px-4 py-3 align-middle text-gray-600 dark:text-gray-400">+ Parts &amp; hardware</td>
                <TableCell className="text-right tabular-nums text-gray-600 dark:text-gray-400">{formatCurrency(pu.parts)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
