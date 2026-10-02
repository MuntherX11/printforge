'use client';

import { useEffect, useId, useState } from 'react';
import { approxColourHex } from '@printforge/types';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Swatch } from '@/components/ui/swatch';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/**
 * A filament's colour dot, set by staff (v2.17.3). One field, two places:
 * the Filaments list (click a row's dot) and the Edit Material dialog.
 * Values are bare upper-case hex ('91202B') or '' for no colour; the server
 * stores '' as null. An approximate dot drawn from the colour name is never
 * written back.
 */

const HEX6 = /^#?[0-9A-Fa-f]{6}$/;
const MAX_SUGGESTIONS = 6;

/** '#a1b2c3' / 'A1B2C3' → 'A1B2C3'; anything else → null. */
export function bareHex(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  return HEX6.test(v) ? v.replace(/^#/, '').toUpperCase() : null;
}

interface CatalogueRow { id: number; brand: string; colour: string; type: string; hex: string }
interface Suggestion { hex: string; title: string }

/** Up to six catalogue colours: same brand + colour name first, then the colour name in any brand, then the nearest. */
function useSuggestions(brand: string, colour: string, near: string | null): Suggestion[] {
  const [list, setList] = useState<Suggestion[]>([]);
  useEffect(() => {
    let live = true;
    const name = colour.trim();
    const search = (params: Record<string, string>) =>
      api.get<{ results?: CatalogueRow[] }>(`/filament-catalog?${new URLSearchParams(params)}`).then((r) => r?.results ?? []);
    const requests: Array<() => Promise<CatalogueRow[]>> = [];
    if (name && brand.trim()) requests.push(() => search({ q: name, brand: brand.trim(), limit: String(MAX_SUGGESTIONS) }));
    if (name) requests.push(() => search({ q: name, limit: '12' }));
    if (near) {
      requests.push(() => api.get<Array<{ swatch: CatalogueRow }>>(`/filament-catalog/nearest?hex=${near}&limit=${MAX_SUGGESTIONS}`)
        .then((r) => (r ?? []).map((x) => x.swatch)));
    }
    // A short pause, so typing a colour name doesn't send a request per key.
    const timer = window.setTimeout(() => {
      Promise.all(requests.map((get) => get().catch((): CatalogueRow[] => []))).then((lists) => {
        if (live) setList(firstSix(lists.flat()));
      });
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [brand, colour, near]);
  return list;
}

/** The first six distinct hexes, in order. */
function firstSix(rows: CatalogueRow[]): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const row of rows) {
    const hex = bareHex(row.hex);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ hex, title: `${row.brand} ${row.colour} (${row.type}) #${hex}` });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

interface FieldProps {
  /** Bare hex or '' (no colour). */
  value: string;
  onChange: (hex: string) => void;
  /** The filament's brand and colour name, for the suggestions. */
  brand: string;
  colour: string;
}

/** Colour picker + hex text + catalogue suggestions + Clear. */
export function ColourDotField({ value, onChange, brand, colour }: FieldProps) {
  const id = useId();
  const [text, setText] = useState(value ? `#${value}` : '');
  useEffect(() => { setText(value ? `#${value}` : ''); }, [value]);
  const approx = approxColourHex(colour);
  // Nearest to the colour the field opened with (or the name's), so picking one doesn't reshuffle the list.
  const [opened] = useState(value);
  const suggestions = useSuggestions(brand, colour, opened || approx);
  const textBad = text.trim() !== '' && !bareHex(text);

  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-hex`} className="text-sm font-medium text-gray-700 dark:text-gray-300">Colour dot</label>
      <div className="flex flex-wrap items-center gap-2">
        <input type="color" aria-label="Pick a colour" value={`#${value || approx || 'FFFFFF'}`.toLowerCase()}
          onChange={(e) => onChange(bareHex(e.target.value) ?? '')}
          className="h-10 w-12 cursor-pointer rounded-md border border-gray-300 bg-white p-1 dark:border-gray-600 dark:bg-gray-800" />
        <input id={`${id}-hex`} type="text" inputMode="text" autoComplete="off" spellCheck={false} maxLength={7}
          placeholder="#RRGGBB" value={text}
          onChange={(e) => {
            setText(e.target.value);
            const hex = bareHex(e.target.value);
            if (hex) onChange(hex);
            else if (e.target.value.trim() === '') onChange('');
          }}
          aria-invalid={textBad || undefined}
          className="h-10 w-28 rounded-md border border-gray-300 bg-white px-3 font-mono text-sm uppercase dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
        {value && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange('')}>Clear</Button>
        )}
      </div>
      {textBad && <p className="text-xs text-red-600 dark:text-red-400">Six hex digits, e.g. #91202B</p>}
      {!value && <p className="text-xs text-gray-500 dark:text-gray-400">No colour set{approx ? ' — the dot shows an approximate one' : ''}.</p>}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500 dark:text-gray-400">Close matches:</span>
          {suggestions.map((s) => (
            <button key={s.hex} type="button" title={s.title} aria-label={s.title} onClick={() => onChange(s.hex)}
              className={`h-6 w-6 rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${s.hex === value ? 'ring-2 ring-brand-500' : 'border-black/10 dark:border-white/20'}`}
              style={{ backgroundColor: `#${s.hex}` }} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface DotMaterial {
  id: string;
  name: string;
  brand: string | null;
  color: string | null;
  colorHex: string | null;
}

/**
 * The Filaments list's dot. Staff click it to set the colour; everyone else
 * sees the dot only.
 */
export function FilamentColourDot({ material, title, canEdit, onSaved }: {
  material: DotMaterial;
  title: string;
  canEdit: boolean;
  onSaved: (colorHex: string | null) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState('');
  const [saving, setSaving] = useState(false);
  const name = material.color || material.name;
  const dot = <Swatch hex={material.colorHex} name={name} title={title}
    approxTitle={canEdit ? 'Approximate — click to set the exact colour' : undefined} decorative={canEdit} />;
  if (!canEdit) return dot;

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/materials/${material.id}`, { colorHex: hex || null });
      onSaved(hex || null);
      setOpen(false);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : "Couldn't save the colour");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" aria-label={`Set colour of ${title}`}
        onClick={() => { setHex(bareHex(material.colorHex) ?? ''); setOpen(true); }}
        className="inline-flex rounded-full p-1 -m-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        {dot}
      </button>
      {/* The row opens the filament on click; clicks in the dialog stay here. */}
      <div onClick={(e) => e.stopPropagation()} className="cursor-auto">
        <Dialog open={open} onClose={() => setOpen(false)} title={`Colour of ${title}`} className="max-w-sm">
          <div className="space-y-4">
            <ColourDotField value={hex} onChange={setHex} brand={material.brand ?? ''} colour={name} />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </Dialog>
      </div>
    </>
  );
}
