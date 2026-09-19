'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ApiKeepStandard, ApiOptionKindsResult, ProductDetail } from '@/lib/types/api';
import { KeepStandardStep, errorText } from './options-ui';
import {
  keepStandardDefault, orderedColours, orderedSizes, standardFilaments, suggestedColourLabel, type KindChange, type OptionKind,
} from './options-model';

interface Props {
  product: ProductDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface Row {
  id: string;
  name: string;
  current: OptionKind;
  isActive: boolean;
  allowed: boolean;
  blockers: string[];
  rewrites: number;
  suggestColour: boolean;
}

function rowsOf(p: ProductDetail): Row[] {
  return [
    ...orderedSizes(p).map(s => ({
      id: s.id, name: s.name, current: 'SIZE' as OptionKind, isActive: s.isActive,
      allowed: s.kindChange.allowed, blockers: s.kindChange.blockers, rewrites: 0,
      suggestColour: s.notSetUp && s.likelyColour,
    })),
    ...orderedColours(p).map(c => ({
      id: c.id, name: c.name, current: 'COLOUR' as OptionKind, isActive: c.isActive,
      allowed: c.kindChange.allowed, blockers: c.kindChange.blockers, rewrites: c.kindChange.rewrites,
      suggestColour: false,
    })),
  ];
}

/** Preselection: current kind, except `Colour` for not-set-up sizes whose name looks like a colour. */
function initialKinds(rows: Row[]): Record<string, OptionKind> {
  return Object.fromEntries(rows.map(r => [r.id, r.allowed && r.suggestColour ? 'COLOUR' : r.current]));
}

/**
 * O7 batch reclassification (spec §5.2 C "Kind classification"): one
 * `Size | Colour` control per option; blocked rows disabled with their blocker
 * text; a required `Keep selling …` step when the batch creates the first
 * colour or size while that axis is undecided (§3.1 rule 7).
 */
export function ClassifyOptionsDialog({ product, open, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const rows = useMemo(() => rowsOf(product), [product]);
  const [kinds, setKinds] = useState<Record<string, OptionKind>>(() => initialKinds(rows));
  const [colourKeep, setColourKeep] = useState<ApiKeepStandard>({ label: '', sellInShop: true });
  const [sizeKeep, setSizeKeep] = useState<ApiKeepStandard>({ label: '', sellInShop: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changes: KindChange[] = rows.filter(r => kinds[r.id] && kinds[r.id] !== r.current).map(r => ({ variantId: r.id, kind: kinds[r.id] }));
  const defaults = keepStandardDefault(product, changes);
  const changeKey = changes.map(c => `${c.variantId}:${c.kind}`).join('|');

  useEffect(() => {
    if (!open) return;
    setKinds(initialKinds(rows));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-default the ticks whenever the set of changes changes (the owner can still override them).
  useEffect(() => {
    if (!open) return;
    setColourKeep({ label: suggestedColourLabel(product), sellInShop: defaults.colour.sellInShop });
    setSizeKeep({ label: product.baseOptionLabel ?? '', sellInShop: defaults.size.sellInShop });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, changeKey]);

  async function save() {
    if (!changes.length) { setError('Nothing to change — pick Size or Colour for at least one option'); return; }
    const keepStandard: { colour?: ApiKeepStandard; size?: ApiKeepStandard } = {};
    if (defaults.colour.required) keepStandard.colour = { label: colourKeep.label.trim(), sellInShop: colourKeep.sellInShop };
    if (defaults.size.required) keepStandard.size = { label: sizeKeep.label.trim(), sellInShop: sizeKeep.sellInShop };
    for (const k of Object.values(keepStandard)) {
      if (k.label.length < 1 || k.label.length > 40) { setError('Enter a name (1 to 40 characters) in the Keep selling step'); return; }
    }
    setSaving(true);
    setError(null);
    try {
      const r = await api.put<ApiOptionKindsResult>(`/products/${product.id}/option-kinds`, {
        changes,
        ...(Object.keys(keepStandard).length ? { keepStandard } : {}),
      });
      toast('success', `${changes.length} ${changes.length === 1 ? 'option' : 'options'} reclassified`);
      const notes = r.warnings.filter(w => ['LEGACY_PRICE_IGNORED', 'LINES_RECLASSIFIED', 'COLOUR_HIDDEN_UNTIL_SET_UP'].includes(w.code));
      if (notes.length) toast('warning', notes.map(w => w.message).join(' · '));
      onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Reclassification failed'));
    } finally {
      setSaving(false);
    }
  }

  const filamentNames = standardFilaments(product).map(m => m.name).join(', ');
  const bought = defaults.colour.boughtAsColours;

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} title="Classify options" className="max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Options made before sizes and colours were separate are all sizes. Mark the ones that are really colours:
          a colour prints the same files in other filaments and uses its size&apos;s price.
        </p>
        <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-md border dark:divide-gray-700 dark:border-gray-700">
          {rows.map(r => {
            const chosen = kinds[r.id] ?? r.current;
            const switched = chosen !== r.current;
            return (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {r.name}{!r.isActive && <span className="ml-1 text-xs font-normal text-gray-500">(inactive)</span>}
                  </p>
                  {!r.allowed && r.blockers.map(b => <p key={b} className="text-xs text-red-600 dark:text-red-400">{b}</p>)}
                  {r.allowed && r.suggestColour && !switched && r.current === 'SIZE' && (
                    <p className="text-xs text-blue-700 dark:text-blue-300">Looks like a colour</p>
                  )}
                  {switched && chosen === 'COLOUR' && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">Not in the shop until its filaments are set</p>
                  )}
                  {switched && r.rewrites > 0 && (
                    <p className="text-xs text-gray-600 dark:text-gray-400">{r.rewrites} orders, quotes or jobs made since the update will move to this colour</p>
                  )}
                </div>
                <div role="radiogroup" aria-label={`Kind of ${r.name}`} className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
                  {(['SIZE', 'COLOUR'] as OptionKind[]).map(k => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={chosen === k}
                      disabled={!r.allowed || saving}
                      onClick={() => setKinds(s => ({ ...s, [r.id]: k }))}
                      className={cn(
                        'px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        chosen === k ? 'bg-brand-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
                      )}
                    >
                      {k === 'SIZE' ? 'Size' : 'Colour'}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>

        {defaults.colour.required && (
          <KeepStandardStep
            intro={bought.length && !defaults.colour.sellInShop
              ? `Customers bought ${bought.join(', ')} — they return to the shop when their filaments are set. Also sell the as-sliced colour (${filamentNames}) as:`
              : `Customers buy this today in ${filamentNames || 'the filaments it was sliced with'}. Keep selling it as:`}
            label={colourKeep.label}
            sellInShop={colourKeep.sellInShop}
            placeholder="e.g. Black"
            note={colourKeep.sellInShop ? undefined : 'Unticked: customers pick one of the colours; staff can always order the as-sliced colour.'}
            onLabel={v => setColourKeep(k => ({ ...k, label: v }))}
            onSell={v => setColourKeep(k => ({ ...k, sellInShop: v }))}
          />
        )}
        {defaults.size.required && (
          <KeepStandardStep
            intro="Customers buy this product today. Keep selling the current one as:"
            label={sizeKeep.label}
            sellInShop={sizeKeep.sellInShop}
            placeholder="e.g. Regular"
            onLabel={v => setSizeKeep(k => ({ ...k, label: v }))}
            onSell={v => setSizeKeep(k => ({ ...k, sellInShop: v }))}
          />
        )}

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex items-center justify-end gap-3 pt-1">
          <span className="mr-auto text-xs text-gray-500 dark:text-gray-400">{changes.length} {changes.length === 1 ? 'change' : 'changes'}</span>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={() => void save()} disabled={saving || changes.length === 0}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Dialog>
  );
}
