'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Swatch, swatchHex } from '@/components/ui/swatch';
import { useToast } from '@/components/ui/toast';
import { toMaterialType } from '@/components/filament-swatch-picker';
import type { ScannedFields } from '@/components/spool-label-scanner';
import { api } from '@/lib/api';
import type { ApiMaterial, ApiSpool, FilamentStockRow } from '@/lib/types/api';
import {
  MATERIAL_TYPE_OPTIONS,
  catalogueBrandSpelling,
  findScanMatches,
  normText,
  type MaterialTypeValue,
} from '@printforge/types';

/** Net grams of a new spool when the label gives no usable weight. */
const DEFAULT_SPOOL_GRAMS = 1000;

const TYPE_OPTIONS = MATERIAL_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

/** Everything the review grid edits, in its order. */
interface Draft {
  brand: string;
  type: MaterialTypeValue;
  color: string;
  diameter: string;
  weight: string;
  printTemp: string;
}

/** A filament this dialog created, so a retry after a failed spool step reuses it. */
interface CreatedFilament {
  id: string;
  name: string;
  key: string;
}

/** The scanned type as one we track: 'PLA+' is PLA, 'ESUN' or 'PA' is Other; PLA when blank. */
function initialType(scanned?: string): MaterialTypeValue {
  if (!scanned?.trim()) return 'PLA';
  const t = toMaterialType(scanned);
  return MATERIAL_TYPE_OPTIONS.find((o) => o.value === t)?.value ?? 'OTHER';
}

function draftFrom(fields: ScannedFields): Draft {
  return {
    brand: fields.brand ?? '',
    type: initialType(fields.materialType),
    color: fields.color ?? '',
    diameter: fields.diameter ?? '',
    weight: fields.weight ?? '',
    printTemp: fields.printTemp ?? '',
  };
}

/** Trim and collapse inner spaces, keeping the case. */
const tidy = (value: string) => value.trim().replace(/\s+/g, ' ');

/** Grams for the new spool: the label's weight when above 0, otherwise 1000 g. */
function spoolGrams(weight: string): number {
  const w = parseFloat(weight);
  return Number.isFinite(w) && w > 0 ? w : DEFAULT_SPOOL_GRAMS;
}

/** "eSUN · PLA · Red", leaving out empty parts. */
function filamentLabel(row: FilamentStockRow): string {
  return [row.brand, row.type, row.color].filter(Boolean).join(' · ') || row.name;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Unknown error';
}

interface ScanReviewDialogProps {
  /** The scanned label; null keeps the dialog closed. */
  fields: ScannedFields | null;
  /** Every filament from GET /materials/stock, or null until the list has loaded. */
  rows: FilamentStockRow[] | null;
  /** True when the list has never loaded and the last attempt failed. */
  loadFailed: boolean;
  onClose(): void;
  /** Reloads the list in the background (after success and after a failure). */
  onChanged(): void;
  /** Clears the failure and loads the list again. */
  onRetry(): void;
}

/**
 * "Review Scanned Label": edit what the scanner read, see which filament the
 * spool will join (searched over every filament), then add the spool, creating
 * the filament first when none matches.
 */
export function ScanReviewDialog({ fields, ...rest }: ScanReviewDialogProps) {
  return (
    <Dialog open={!!fields} onClose={rest.onClose} title="Review Scanned Label">
      {/* The Dialog unmounts its children when closed, so every scan starts fresh. */}
      {fields && <ScanReviewForm fields={fields} {...rest} />}
    </Dialog>
  );
}

function ScanReviewForm({ fields, rows, loadFailed, onClose, onChanged, onRetry }: ScanReviewDialogProps & { fields: ScannedFields }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(fields));
  const [brands, setBrands] = useState<string[]>([]);
  const [showRawOcr, setShowRawOcr] = useState(false);
  const [pickedId, setPickedId] = useState('');
  const [creating, setCreating] = useState(false);
  const brandEdited = useRef(false);
  const created = useRef<CreatedFilament | null>(null);

  // Brands for the datalist (enabled catalogue brands plus brands already in
  // use), fetched once per open. The scanned brand takes the listed spelling
  // unless it has been edited meanwhile.
  useEffect(() => {
    let live = true;
    api.get<string[]>('/filament-catalog/brands')
      .then((list) => {
        if (!live) return;
        const clean = Array.isArray(list) ? list.filter((b): b is string => typeof b === 'string') : [];
        setBrands(clean);
        if (!brandEdited.current) setDraft((d) => ({ ...d, brand: catalogueBrandSpelling(d.brand, clean) }));
      })
      .catch(() => {
        if (live) setBrands([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // Opened before the list finished loading: ask for it (clearing an earlier
  // failure), so the match can run.
  useEffect(() => {
    if (rows === null) onRetry();
    // Once per open; a later null is the page's own load still in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matches = useMemo(
    () => (rows ? findScanMatches(rows, { brand: draft.brand, type: draft.type, color: draft.color }) : null),
    [rows, draft.brand, draft.type, draft.color],
  );
  const target = matches?.find((m) => m.id === pickedId) ?? matches?.[0] ?? null;
  const grams = spoolGrams(draft.weight);
  const gramsText = grams.toLocaleString('en-US');
  const brand = tidy(draft.brand);
  const color = tidy(draft.color);
  const newName = [brand, draft.type, color].filter(Boolean).join(' ');
  const identityKey = `${normText(brand)}|${draft.type}|${normText(color)}`;

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function confirm() {
    if (creating || matches === null) return;
    setCreating(true);
    try {
      let material: { id: string; name: string } | null = target;
      if (!material && created.current?.key === identityKey) material = created.current;
      if (!material) {
        const made = await api.post<ApiMaterial>('/materials', {
          name: newName,
          type: draft.type,
          color,
          brand,
          costPerGram: 0,
          density: 1.24,
        });
        created.current = { id: made.id, name: made.name, key: identityKey };
        material = made;
      }
      const spool = await api.post<ApiSpool>('/spools', {
        materialId: material.id,
        initialWeight: grams,
        currentWeight: grams,
      });
      toast('success', `Added ${spool.printforgeId ?? 'a spool'} to ${material.name}`);
      onClose();
      onChanged();
    } catch (err: unknown) {
      toast('error', 'Failed to create spool: ' + errorText(err));
      // The reload lets a retry find a filament created before the failure.
      onChanged();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Review and edit any fields before creating the spool. Missing fields can be filled in manually.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Brand"
          value={draft.brand}
          onChange={(e) => {
            brandEdited.current = true;
            setField('brand', e.target.value);
          }}
          placeholder="e.g. eSUN"
          list="scan-known-brands"
        />
        <datalist id="scan-known-brands">
          {brands.map((b) => <option key={b} value={b} />)}
        </datalist>
        <Select
          label="Type"
          value={draft.type}
          onChange={(e) => setField('type', MATERIAL_TYPE_OPTIONS.find((o) => o.value === e.target.value)?.value ?? 'OTHER')}
          options={TYPE_OPTIONS}
        />
        <Input label="Color" value={draft.color} onChange={(e) => setField('color', e.target.value)} placeholder="e.g. Black" />
        <Input label="Diameter (mm)" value={draft.diameter} onChange={(e) => setField('diameter', e.target.value)} placeholder="1.75" />
        <Input label="Weight (g)" value={draft.weight} onChange={(e) => setField('weight', e.target.value)} placeholder="1000" />
        <Input label="Print Temp (°C)" value={draft.printTemp} onChange={(e) => setField('printTemp', e.target.value)} placeholder="210-230" />
      </div>

      <div aria-live="polite" className="text-sm">
        {matches === null ? (
          loadFailed ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-gray-700 dark:text-gray-300">Couldn&apos;t check existing filaments</p>
              <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">Checking existing filaments…</p>
          )
        ) : matches.length === 1 ? (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-gray-700 dark:text-gray-300">
            <span>Adds a {gramsText} g spool to:</span>
            <Swatch hex={swatchHex(matches[0].colorHex)} title={matches[0].color || matches[0].name} />
            <span className="font-medium">{filamentLabel(matches[0])}</span>
          </p>
        ) : matches.length > 1 ? (
          <Select
            label={`Matches ${matches.length} filaments — add to:`}
            value={target?.id ?? ''}
            onChange={(e) => setPickedId(e.target.value)}
            options={matches.map((m) => ({ value: m.id, label: `${filamentLabel(m)} — ${m.name}` }))}
          />
        ) : (
          <p className="text-amber-700 dark:text-amber-300">
            Creates new filament “{newName}”, then adds a {gramsText} g spool. Spool price starts at 0 — set it on the filament page.
          </p>
        )}
      </div>

      {fields.rawText && (
        <div className="text-xs">
          <button
            type="button"
            onClick={() => setShowRawOcr((s) => !s)}
            className="text-brand-600 dark:text-brand-400 hover:underline"
          >
            {showRawOcr ? 'Hide' : 'Show'} raw OCR text
          </button>
          {showRawOcr && (
            <pre className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-gray-700 dark:text-gray-300">
              {fields.rawText}
            </pre>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={confirm} disabled={creating || matches === null}>
          {creating ? 'Creating...' : 'Confirm & Create'}
        </Button>
      </div>
    </div>
  );
}
