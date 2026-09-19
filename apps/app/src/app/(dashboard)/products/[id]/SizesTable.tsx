'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormatCurrency } from '@/lib/locale-context';
import { formatGrams, formatMinutes, formatPct, plural } from '@/lib/product-format';
import type { OptionCost, ProductCostPayload, ProductDetail, SizeOptionDetail, UnlinkedSlot } from '@/lib/types/api';
import { LinkButton, Toggle } from './options-ui';
import {
  STANDARD_KEY, activeCellsOfSize, marginRange, orderedSizes, standardSizeLabel, unlinkedLabels, unlinkedSentence,
} from './options-model';

interface Props {
  product: ProductDetail;
  cost: ProductCostPayload | null;
  canEdit: boolean;
  isAdmin: boolean;
  busyId: string | null;
  savingStandard: boolean;
  onConfigure: (sizeKey: string) => void;
  onCost: (size: SizeOptionDetail | null) => void;
  onEdit: (size: SizeOptionDetail) => void;
  onMove: (size: SizeOptionDetail, dir: -1 | 1) => void;
  onSetActive: (size: SizeOptionDetail, isActive: boolean) => void;
  onDelete: (size: SizeOptionDetail) => void;
  onEditLinks: () => void;
  onStandardSellable: (sell: boolean) => void;
}

/** Filament and time per product unit, from the size's cost (standard colour). */
function perUnit(oc: OptionCost | undefined): string {
  if (!oc || oc.components.length === 0) return '—';
  const g = oc.components.reduce((s, c) => s + c.gramsPerUnit * c.quantity, 0);
  const m = oc.components.reduce((s, c) => s + c.minutesPerUnit * c.quantity, 0);
  return `${formatGrams(g)} · ${formatMinutes(m)}`;
}

/** Section C part 1 (spec §5.2 C): the standard size first, then every size. */
export function SizesTable(props: Props) {
  const { product, cost, canEdit, isAdmin, busyId } = props;
  const formatCurrency = useFormatCurrency();
  const sizes = orderedSizes(product);
  const hasColours = product.colours.length > 0;
  const costOf = (id: string | null) => cost?.sizes.find(s => s.sizeOptionId === id && s.colourOptionId === null);

  function priceCell(oc: OptionCost | undefined, legacy: boolean) {
    const stored = oc ? oc.storedPrice : null;
    if (stored == null) {
      return (
        <div>
          <span className="text-gray-400">Not set</span>
          {legacy && <p className="text-xs text-gray-500 dark:text-gray-400">staff orders use the standard price</p>}
        </div>
      );
    }
    return (
      <div>
        <span className="tabular-nums">{formatCurrency(stored)}</span>
        {oc && !oc.priceUpToDate && oc.computedPrice != null && (
          <p className="text-xs text-amber-700 dark:text-amber-300">differs (computed {formatCurrency(oc.computedPrice)})</p>
        )}
      </div>
    );
  }

  function costCells(id: string | null) {
    const oc = costOf(id);
    const range = hasColours && cost ? marginRange(activeCellsOfSize(product, cost.cells, id)) : null;
    return (
      <>
        <TableCell className="text-right tabular-nums">{oc?.perUnit ? formatCurrency(oc.perUnit.total) : '—'}</TableCell>
        <TableCell className="text-right tabular-nums">
          {oc?.marginPct != null ? formatPct(oc.marginPct) : '—'}
          {range && <p className="text-xs text-gray-500 dark:text-gray-400">{formatPct(range.min)}–{formatPct(range.max)} across colours</p>}
        </TableCell>
        <TableCell className="whitespace-nowrap text-gray-600 dark:text-gray-400">{perUnit(oc)}</TableCell>
      </>
    );
  }

  function unlinkedLine(label: string, slots: UnlinkedSlot[]) {
    if (!hasColours || slots.length === 0) return null;
    return (
      <div className="mt-1 text-xs text-red-600 dark:text-red-400">
        {unlinkedSentence(label, unlinkedLabels(product, slots))} — colours aren&apos;t offered on {label} in the shop
        {canEdit && <> <LinkButton onClick={props.onEditLinks}>Edit links</LinkButton></>}
      </div>
    );
  }

  const stdLabel = standardSizeLabel(product);
  const stdComponents = product.components.length;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Size</TableHead>
          <TableHead>SKU</TableHead>
          <TableHead className="text-right">Price / unit</TableHead>
          <TableHead className="text-right">Cost / unit</TableHead>
          <TableHead className="text-right">Margin</TableHead>
          <TableHead>Filament &amp; time per unit</TableHead>
          <TableHead>Setup</TableHead>
          <TableHead>Status</TableHead>
          {canEdit && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>
            <span className="font-medium text-gray-900 dark:text-gray-100">{stdLabel}</span>
            <span className="ml-1 text-xs text-gray-500">(standard)</span>
            {!product.baseOptionLabel && <p className="text-xs text-blue-700 dark:text-blue-300">Name it (e.g. Regular) — Edit product</p>}
          </TableCell>
          <TableCell className="font-mono text-xs">{product.sku ?? '—'}</TableCell>
          <TableCell className="text-right">{priceCell(costOf(null), false)}</TableCell>
          {costCells(null)}
          <TableCell>
            {stdComponents === 0 ? (
              <span className="text-gray-500 dark:text-gray-400">Not sold — no components</span>
            ) : (
              <div className="space-y-1">
                <span className="text-green-700 dark:text-green-400">{plural(stdComponents, 'component')} ✓</span>
                <div className="flex items-center gap-2">
                  {canEdit ? (
                    <Toggle
                      checked={product.baseOptionSellable === true}
                      label={`Sell ${stdLabel} to customers`}
                      disabled={props.savingStandard}
                      onChange={props.onStandardSellable}
                    />
                  ) : null}
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    {canEdit ? 'Sell to customers — ' : ''}
                    {product.baseOptionSellable === true ? 'Shown in the shop' : 'Staff can always order it'}
                  </span>
                </div>
              </div>
            )}
            {unlinkedLine(stdLabel, product.unlinkedSlots)}
          </TableCell>
          <TableCell><Badge variant={product.baseSellable ? 'success' : 'default'}>{product.baseSellable ? 'Sellable' : 'Not sold'}</Badge></TableCell>
          {canEdit && (
            <TableCell className="whitespace-nowrap text-right">
              <LinkButton onClick={() => props.onConfigure(STANDARD_KEY)}>Configure</LinkButton>
              <LinkButton onClick={() => props.onCost(null)}>Cost</LinkButton>
            </TableCell>
          )}
        </TableRow>

        {sizes.map((s, i) => {
          const own = s.components.length;
          const busy = busyId === s.id;
          return (
            <TableRow key={s.id} className={s.isActive ? undefined : 'opacity-70'}>
              <TableCell>
                <span className="font-medium text-gray-900 dark:text-gray-100">{s.name}</span>
                {s.notSetUp && s.likelyColour && <Badge variant="info" className="ml-2">Looks like a colour</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs">{s.sku ?? '—'}</TableCell>
              <TableCell className="text-right">{priceCell(costOf(s.id), s.notSetUp)}</TableCell>
              {costCells(s.id)}
              <TableCell>
                {own > 0
                  ? <span className="text-green-700 dark:text-green-400">{plural(own, 'component')} ✓</span>
                  : <span className="text-red-600 dark:text-red-400">No sliced files — using the standard bill of materials</span>}
                {unlinkedLine(s.name, s.unlinkedSlots)}
              </TableCell>
              <TableCell><Badge variant={s.isActive ? 'success' : 'default'}>{s.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
              {canEdit && (
                <TableCell className="whitespace-nowrap text-right">
                  <LinkButton onClick={() => props.onConfigure(s.id)}>Configure</LinkButton>
                  <LinkButton onClick={() => props.onCost(s)}>Cost</LinkButton>
                  <LinkButton onClick={() => props.onEdit(s)}>Edit</LinkButton>
                  <LinkButton title={`Move ${s.name} up`} disabled={busy || i === 0} onClick={() => props.onMove(s, -1)}><ArrowUp className="h-3.5 w-3.5" /></LinkButton>
                  <LinkButton title={`Move ${s.name} down`} disabled={busy || i === sizes.length - 1} onClick={() => props.onMove(s, 1)}><ArrowDown className="h-3.5 w-3.5" /></LinkButton>
                  <LinkButton disabled={busy} onClick={() => props.onSetActive(s, !s.isActive)}>{s.isActive ? 'Deactivate' : 'Activate'}</LinkButton>
                  {isAdmin && <LinkButton tone="danger" disabled={busy} onClick={() => props.onDelete(s)}>Delete</LinkButton>}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
