'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFormatCurrency } from '@/lib/locale-context';
import type { ColourOptionDetail, ProductCostPayload, ProductDetail } from '@/lib/types/api';
import { LinkButton, Swatch, Toggle } from './options-ui';
import {
  STANDARD_KEY, formatDelta, orderedColours, orderedSizes, sizeLabelOf, standardColourLabel, standardFilaments, worstDelta,
} from './options-model';

interface Props {
  product: ProductDetail;
  cost: ProductCostPayload | null;
  canEdit: boolean;
  isAdmin: boolean;
  busyId: string | null;
  savingStandard: boolean;
  onFilaments: (colour: ColourOptionDetail) => void;
  onCost: (colour: ColourOptionDetail) => void;
  onEdit: (colour: ColourOptionDetail) => void;
  onMove: (colour: ColourOptionDetail, dir: -1 | 1) => void;
  onSetActive: (colour: ColourOptionDetail, isActive: boolean) => void;
  onDelete: (colour: ColourOptionDetail) => void;
  onStandardSellable: (sell: boolean) => void;
}

/** Setup cell lines of one colour (spec §5.2 C part 2). */
function setupLines(product: ProductDetail, c: ColourOptionDetail): Array<{ text: string; tone: 'ok' | 'warn' | 'muted' | 'error' }> {
  const lines: Array<{ text: string; tone: 'ok' | 'warn' | 'muted' | 'error' }> = [];
  const slots = product.colourSlots.length;
  const notSetUp = c.setup.warnings.some(w => w.code === 'COLOUR_OPTION_NOT_SET_UP');
  if (notSetUp) lines.push({ text: 'Not in the shop until filaments are set', tone: 'warn' });
  else lines.push({ text: `${c.assignments.length} of ${slots} ${slots === 1 ? 'slot' : 'slots'} set`, tone: 'ok' });
  const other = c.setup.warnings.find(w => w.code !== 'COLOUR_OPTION_NOT_SET_UP');
  if (other) lines.push({ text: other.message, tone: 'muted' });

  const madeKeys = [STANDARD_KEY, ...orderedSizes(product).filter(s => s.isActive).map(s => s.id)].filter(k => !c.excludedSizeKeys.includes(k));
  if (!notSetUp) {
    for (const k of madeKeys) {
      if (c.customerSizeKeys.includes(k)) continue;
      const unlinked = k === STANDARD_KEY ? product.unlinkedSlots.length : product.sizes.find(s => s.id === k)?.unlinkedSlots.length ?? 0;
      if (unlinked > 0) {
        lines.push({ text: `Not in the shop on ${sizeLabelOf(product, k)} — ${unlinked} ${unlinked === 1 ? 'part' : 'parts'} not linked`, tone: 'error' });
      }
    }
  }
  if (c.excludedSizeKeys.length > 0 && product.sizes.length > 0) {
    lines.push({ text: `Made in ${madeKeys.map(k => sizeLabelOf(product, k)).join(', ') || 'no active size'} only`, tone: 'muted' });
  }
  return lines;
}

const TONE = {
  ok: 'text-gray-700 dark:text-gray-300',
  warn: 'text-amber-700 dark:text-amber-300',
  muted: 'text-gray-500 dark:text-gray-400',
  error: 'text-red-600 dark:text-red-400',
};

/** Section C part 2 (spec §5.2 C): the standard colour first, then every colour. No price column. */
export function ColoursTable(props: Props) {
  const { product, cost, canEdit, isAdmin, busyId } = props;
  const formatCurrency = useFormatCurrency();
  const colours = orderedColours(product);
  const slots = [...product.colourSlots].sort((a, b) => a.sortOrder - b.sortOrder);
  const stdLabel = standardColourLabel(product);
  const mixedWarning = product.warnings.find(w => w.code === 'SLOT_STANDARD_MIXED');
  const stdSwatches = slots.length
    ? slots.flatMap(s => s.standardMaterials.map(m => ({ key: `${s.id}-${m.id}`, hex: m.colorHex, title: `${s.name}: ${m.name}` })))
    : standardFilaments(product).map(m => ({ key: m.id, hex: m.colorHex, title: m.name }));

  return (
    <div>
      <p className="px-4 pb-2 text-xs text-gray-500 dark:text-gray-400">Colours don&apos;t change the price — the price is set by the size.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Colour</TableHead>
            <TableHead>Swatches</TableHead>
            <TableHead>Cost vs standard</TableHead>
            <TableHead>Setup</TableHead>
            <TableHead>Status</TableHead>
            {canEdit && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <span className="font-medium text-gray-900 dark:text-gray-100">{stdLabel}</span>
              <span className="ml-1 text-xs text-gray-500">(standard, as sliced)</span>
              {!product.standardColourLabel && <p className="text-xs text-blue-700 dark:text-blue-300">Name it (e.g. Black) — Edit product</p>}
            </TableCell>
            <TableCell>
              <span className="flex flex-wrap gap-1">{stdSwatches.map(s => <Swatch key={s.key} hex={s.hex} title={s.title} />)}</span>
            </TableCell>
            <TableCell className="text-gray-500 dark:text-gray-400">—</TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                {canEdit && (
                  <Toggle
                    checked={product.standardColourSellable === true}
                    label={`Sell ${stdLabel} to customers`}
                    disabled={props.savingStandard || product.standardColourMixed}
                    onChange={props.onStandardSellable}
                  />
                )}
                <span className="text-xs text-gray-600 dark:text-gray-400">
                  {canEdit ? 'Sell to customers — ' : ''}
                  {product.standardColourSellableToCustomers ? 'Shown in the shop' : 'Staff can always order it'}
                </span>
              </div>
              {product.standardColourMixed && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {mixedWarning?.message ?? 'A colour slot is sliced in different filaments on different sizes'} — make {stdLabel} a colour, or re-slice.
                </p>
              )}
            </TableCell>
            <TableCell><Badge variant="success">Active</Badge></TableCell>
            {canEdit && <TableCell />}
          </TableRow>

          {colours.map((c, i) => {
            const delta = cost ? worstDelta(product, cost.cells, c.id) : null;
            const busy = busyId === c.id;
            return (
              <TableRow key={c.id} className={c.isActive ? undefined : 'opacity-70'}>
                <TableCell>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{c.name}</span>
                  {c.sku && <span className="ml-2 font-mono text-xs text-gray-500">{c.sku}</span>}
                  {c.legacyPrice != null && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">Had its own price {formatCurrency(c.legacyPrice)} — now uses the size price</p>
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {slots.map(s => {
                      const a = c.assignments.find(x => x.colourSlotId === s.id);
                      return a
                        ? <Swatch key={s.id} hex={a.material.colorHex} title={`${s.name}: ${a.material.name}`} />
                        : <Swatch key={s.id} hollow title={`${s.name}: as sliced`} />;
                    })}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {delta ? (
                    <>
                      <span className={delta.pct > 0.05 ? 'text-amber-700 dark:text-amber-300' : undefined}>{formatDelta(delta.pct)}</span>
                      {product.sizes.length > 0 && Math.abs(delta.pct) >= 0.05 && (
                        <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">(worst: {delta.sizeLabel})</span>
                      )}
                    </>
                  ) : '—'}
                </TableCell>
                <TableCell>
                  {setupLines(product, c).map(l => <p key={l.text} className={`text-xs ${TONE[l.tone]}`}>{l.text}</p>)}
                </TableCell>
                <TableCell><Badge variant={c.isActive ? 'success' : 'default'}>{c.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
                {canEdit && (
                  <TableCell className="whitespace-nowrap text-right">
                    <LinkButton onClick={() => props.onFilaments(c)}>Filaments</LinkButton>
                    <LinkButton onClick={() => props.onCost(c)}>Cost</LinkButton>
                    <LinkButton onClick={() => props.onEdit(c)}>Edit</LinkButton>
                    <LinkButton title={`Move ${c.name} up`} disabled={busy || i === 0} onClick={() => props.onMove(c, -1)}><ArrowUp className="h-3.5 w-3.5" /></LinkButton>
                    <LinkButton title={`Move ${c.name} down`} disabled={busy || i === colours.length - 1} onClick={() => props.onMove(c, 1)}><ArrowDown className="h-3.5 w-3.5" /></LinkButton>
                    <LinkButton disabled={busy} onClick={() => props.onSetActive(c, !c.isActive)}>{c.isActive ? 'Deactivate' : 'Activate'}</LinkButton>
                    {isAdmin && <LinkButton tone="danger" disabled={busy} onClick={() => props.onDelete(c)}>Delete</LinkButton>}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
