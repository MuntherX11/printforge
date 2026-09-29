'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Swatch, swatchHex } from '@/components/ui/swatch';
import { useFormatCurrency } from '@/lib/locale-context';
import type { FilamentStockRow, FilamentStockSpool, StockStatus } from '@/lib/types/api';

/** Spool hint lines shown under a filament before collapsing into "+n more". */
const MAX_HINTS = 2;

/** Grams rounded, with a thousands separator: "1,240 g". */
export function formatGrams(grams: number): string {
  return `${Math.round(grams).toLocaleString('en-US')} g`;
}

/** The filament page, opened on the spool a PF-ID search matched when exactly one did. */
export function filamentHref(row: FilamentStockRow, hits?: FilamentStockSpool[]): string {
  const pfid = hits?.length === 1 ? hits[0].printforgeId : null;
  return pfid ? `/inventory/${row.id}?spool=${encodeURIComponent(pfid)}` : `/inventory/${row.id}`;
}

/** "PF-A7X2 · Shelf B · 640 g", with " · inactive" for a retired spool. */
function spoolHint(spool: FilamentStockSpool): string {
  const parts = [spool.printforgeId ?? 'No PF-ID', spool.locationName || 'No location', formatGrams(spool.currentWeight)];
  if (!spool.isActive) parts.push('inactive');
  return parts.join(' · ');
}

function StockBadge({ status }: { status: StockStatus }) {
  if (status === 'out') {
    return <Badge variant="error"><AlertTriangle className="h-3 w-3 mr-1" aria-hidden="true" /> Out of Stock</Badge>;
  }
  if (status === 'low') {
    return <Badge variant="warning"><AlertTriangle className="h-3 w-3 mr-1" aria-hidden="true" /> Low Stock</Badge>;
  }
  return <Badge variant="success">OK</Badge>;
}

/**
 * The line above the table when the whole search is one spool's PF-ID:
 * "Spool PF-A7X2 · eSUN PLA Red · 640 g · Shelf B" with two links.
 */
export function PfidShortcut({ row, spool, onBeforeNavigate }: {
  row: FilamentStockRow;
  spool: FilamentStockSpool;
  onBeforeNavigate: () => void;
}) {
  const pfid = spool.printforgeId ?? '';
  const filament = [row.brand, row.type, row.color].filter(Boolean).join(' ') || row.name;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
      <span>
        <span className="font-mono font-medium">Spool {pfid}</span>
        {!spool.isActive && ', inactive'}
        {` · ${filament} · ${formatGrams(spool.currentWeight)} · ${spool.locationName || 'No location'}`}
      </span>
      <Link
        href={filamentHref(row, [spool])}
        onClick={onBeforeNavigate}
        className="font-medium text-brand-600 dark:text-brand-400 hover:underline"
      >
        Open filament →
      </Link>
      <Link
        href={`/inventory/spool/${encodeURIComponent(pfid)}`}
        onClick={onBeforeNavigate}
        className="text-brand-600 dark:text-brand-400 hover:underline"
      >
        Spool page
      </Link>
    </div>
  );
}

interface FilamentsTableProps {
  /** The rows of the current page, already filtered and sorted. */
  rows: FilamentStockRow[];
  /** materialId → spools matched by a PF-ID search. */
  spoolHits: Record<string, FilamentStockSpool[]>;
  /** Runs before opening a filament, so the list URL is current when the user presses Back. */
  onBeforeNavigate: () => void;
}

/** The Filaments list table: the same 7 columns as before, the less important ones hidden on small screens. */
export function FilamentsTable({ rows, spoolHits, onBeforeNavigate }: FilamentsTableProps) {
  const router = useRouter();
  const formatCurrency = useFormatCurrency();

  function openRow(e: React.MouseEvent<HTMLTableRowElement>, href: string) {
    // The link, and any other control in the row, handles its own click.
    if (e.target instanceof Element && e.target.closest('a, button, input, select')) return;
    onBeforeNavigate();
    router.push(href);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Color</TableHead>
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead className="hidden md:table-cell">Brand</TableHead>
          <TableHead className="hidden lg:table-cell">Spool Price</TableHead>
          <TableHead className="hidden lg:table-cell">Active Spools</TableHead>
          <TableHead>Total Stock (g)</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => {
          const hits = spoolHits[m.id] ?? [];
          const href = filamentHref(m, hits);
          const label = m.color || m.name;
          return (
            <TableRow key={m.id} className="cursor-pointer" onClick={(e) => openRow(e, href)}>
              {/* Colour leads: on the shelf a spool is identified by its
                  colour first, then material type, then brand. */}
              <TableCell>
                <div className="flex items-start gap-2">
                  <span className="pt-[3px]">
                    <Swatch hex={swatchHex(m.colorHex)} title={label} />
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={href}
                      onClick={onBeforeNavigate}
                      className="font-medium text-brand-600 dark:text-brand-400 hover:underline"
                    >
                      {label}
                    </Link>
                    {m.color && m.name !== m.color && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">{m.name}</p>
                    )}
                    <p className="text-xs text-gray-500 dark:text-gray-400 md:hidden">
                      {[m.type, m.brand].filter(Boolean).join(' · ')}
                    </p>
                    {hits.slice(0, MAX_HINTS).map((s) => (
                      <p key={s.id} className="font-mono text-xs text-gray-500 dark:text-gray-400">{spoolHint(s)}</p>
                    ))}
                    {hits.length > MAX_HINTS && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">+{hits.length - MAX_HINTS} more</p>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell"><Badge>{m.type}</Badge></TableCell>
              <TableCell className="hidden md:table-cell">{m.brand || '-'}</TableCell>
              <TableCell className="hidden lg:table-cell">
                {m.spoolPrice != null
                  ? <>{formatCurrency(m.spoolPrice)}<span className="text-xs text-gray-400 ml-1">/ {m.spoolWeightGrams ?? 1000}g</span></>
                  : <span className="text-xs text-gray-400">{formatCurrency(m.costPerGram)}/g</span>}
              </TableCell>
              <TableCell className="hidden lg:table-cell">{m.activeSpools}</TableCell>
              <TableCell className="font-mono">{Math.round(m.totalStock).toLocaleString('en-US')}g</TableCell>
              <TableCell className="whitespace-nowrap"><StockBadge status={m.stockStatus} /></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
