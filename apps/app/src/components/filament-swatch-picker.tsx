'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export interface Swatch {
  id: number;
  brand: string;
  colour: string;
  type: string;
  family?: string | null;
  hex: string;
}

/** Sentinel for the "Other" option — no real brand or colour can collide with it. */
const OTHER = '__other__';

/**
 * PrintForge tracks fewer filament types than the catalogue lists
 * ("PLA Matte", "Pro PLA+", "PETG-HS"…). Map onto the nearest one we model,
 * checking longer names first so PETG is never read as PLA by prefix.
 */
export function toMaterialType(catalogueType: string): string {
  const t = (catalogueType || '').toUpperCase();
  return ['PETG', 'NYLON', 'RESIN', 'ASA', 'TPU', 'ABS', 'PLA'].find((k) => t.includes(k)) ?? 'OTHER';
}

interface Props {
  /** Selected material type — both lists derive from it. */
  materialType: string;
  brand: string;
  colour: string;
  /** Read only, to avoid re-reporting a hex already set. Never rendered. */
  hex: string;
  onChange: (next: { brand?: string; colour?: string; hex?: string }) => void;
}

/**
 * Brand and colour as dropdowns driven by the filament catalogue.
 *
 * Both lists follow the selected material type: brands are those that make a
 * filament in it, and colours narrow again once a brand is chosen. Picking a
 * colour captures its hex, which is what makes "closest colour" work when the
 * filament is out of stock.
 *
 * Either list can fall through to "Other", which reveals a text field beneath
 * it. Anything the catalogue has never heard of is still enterable, and if the
 * catalogue is unreachable both lists collapse to just that option, so the form
 * always works.
 */
export function FilamentBrandColour({ materialType, brand, colour, hex, onChange }: Props) {
  const [swatches, setSwatches] = useState<Swatch[]>([]);
  const [brandOther, setBrandOther] = useState(false);
  const [colourOther, setColourOther] = useState(false);

  // Whole catalogue once, then filtered client-side: the type/brand/colour
  // lists all derive from the same rows, and re-querying per keystroke of the
  // type dropdown would be slower than holding ~2k rows in memory.
  useEffect(() => {
    api.get<any>('/filament-catalog?limit=5000')
      .then((r) => setSwatches(r?.results || []))
      .catch(() => setSwatches([]));
  }, []);

  const forType = swatches.filter((s) => toMaterialType(s.type) === materialType);

  const brands = Array.from(new Set(forType.map((s) => s.brand))).sort((a, b) => a.localeCompare(b));

  // One entry per colour name — a brand often lists the same colour across
  // several sub-types (PLA, PLA+, PLA Matte) that all map to one type of ours.
  const colours = Array.from(
    forType
      .filter((s) => !brand || brandOther || s.brand === brand)
      .reduce((m, s) => (m.has(s.colour) ? m : m.set(s.colour, s)), new Map<string, Swatch>())
      .values(),
  ).sort((a, b) => a.colour.localeCompare(b.colour));

  const matchHex = (value: string) =>
    colours.find((c) => c.colour.toLowerCase() === value.trim().toLowerCase())?.hex ?? '';

  // Changing type or brand can make the same colour name resolve to a different
  // swatch, or to none at all.
  useEffect(() => {
    if (colourOther || !colour.trim()) return;
    const next = matchHex(colour);
    if (next !== hex) onChange({ hex: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colours.map((c) => `${c.colour}:${c.hex}`).join('|'), colour, colourOther]);

  // A colour that isn't offered for the new type/brand can't stay selected.
  useEffect(() => {
    if (colourOther || !colour.trim()) return;
    if (colours.length > 0 && !colours.some((c) => c.colour === colour)) {
      onChange({ colour: '', hex: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialType, brand]);

  const brandValue = brandOther ? OTHER : brand;
  const colourValue = colourOther ? OTHER : colour;

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Color"
          value={colourValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER) { setColourOther(true); onChange({ colour: '', hex: '' }); return; }
            setColourOther(false);
            onChange({ colour: v, hex: matchHex(v) });
          }}
          options={[
            { value: '', label: 'Select color…' },
            ...colours.map((c) => ({ value: c.colour, label: c.colour })),
            { value: OTHER, label: 'Other…' },
          ]}
        />
        <Select
          label="Brand"
          value={brandValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER) { setBrandOther(true); onChange({ brand: '' }); return; }
            setBrandOther(false);
            // Colours are brand-specific, so the old one no longer applies.
            onChange({ brand: v, colour: '', hex: '' });
            setColourOther(false);
          }}
          options={[
            { value: '', label: 'Select brand…' },
            ...brands.map((b) => ({ value: b, label: b })),
            { value: OTHER, label: 'Other…' },
          ]}
        />
      </div>

      {(colourOther || brandOther) && (
        <div className="grid grid-cols-2 gap-4">
          {colourOther ? (
            <Input
              label="Color name" placeholder="e.g. Fire Engine Red"
              value={colour} onChange={(e) => onChange({ colour: e.target.value, hex: '' })}
            />
          ) : <div />}
          {brandOther ? (
            <Input
              label="Brand name" placeholder="e.g. eSUN"
              value={brand} onChange={(e) => onChange({ brand: e.target.value })}
            />
          ) : <div />}
        </div>
      )}
    </>
  );
}
