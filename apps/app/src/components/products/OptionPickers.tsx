'use client';

/**
 * Shared size and colour pickers (spec §5.3): plain `select`s in the form
 * style, a size first and then the colours offered on that size. Neither has
 * an empty entry. Defaults and the size-change rule are §3.1 rule 10
 * (`useOptionPair`). Build the options with `pickerOptionsFromDetail` (product
 * page) or `pickerOptionsFromActive` (P2 rows, order/quote/job forms).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select } from '@/components/ui/select';
import {
  changeSize, colourText, coloursForSize, defaultPair, pairIds, pairValid,
  type PairKeys, type PickerOptions,
} from './option-picker-model';

export * from './option-picker-model';

interface SizeSelectProps {
  options: PickerOptions;
  value: string;
  onChange: (sizeKey: string) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}

/** Renders only when the product has active sizes. */
export function SizeSelect({ options, value, onChange, label = 'Size', disabled, id }: SizeSelectProps) {
  if (!options.hasSizes) return null;
  return (
    <Select
      id={id}
      label={label}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      options={options.sizes.map(s => ({ value: s.key, label: s.label }))}
    />
  );
}

interface ColourSelectProps {
  options: PickerOptions;
  /** The selected size's key (`'standard'` without sizes). */
  sizeKey: string;
  value: string;
  onChange: (colourKey: string) => void;
  /** The rule 10 note after a size change, e.g. `Gold isn't made in Large`. */
  note?: string | null;
  label?: string;
  disabled?: boolean;
  id?: string;
}

/** Renders only when the product has active colours; lists the colours offered on `sizeKey`. */
export function ColourSelect({ options, sizeKey, value, onChange, note, label = 'Colour', disabled, id }: ColourSelectProps) {
  if (!options.hasColours) return null;
  return (
    <div>
      <Select
        id={id}
        label={label}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        options={coloursForSize(options, sizeKey).map(c => ({ value: c.key, label: colourText(c, sizeKey) }))}
      />
      {note && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{note}</p>}
    </div>
  );
}

export interface OptionPairState extends PairKeys {
  sizeOptionId: string | null;
  colourOptionId: string | null;
  note: string | null;
  setSizeKey: (key: string) => void;
  setColourKey: (key: string) => void;
  /** Replace both (e.g. a prefill); falls back to the defaults when the pair isn't offered. */
  setPair: (pair: PairKeys) => void;
}

/**
 * The selected pair with the rule 10 behaviour: defaults on a new product,
 * the colour kept on a size change when it is offered there (else the first
 * offered colour and a note), and a reset when the current pair disappears.
 */
export function useOptionPair(options: PickerOptions, initial?: PairKeys | null): OptionPairState {
  const [state, setState] = useState<{ productId: string; pair: PairKeys; note: string | null }>(() => ({
    productId: options.productId,
    pair: initial && pairValid(options, initial) ? initial : defaultPair(options),
    note: null,
  }));

  // A product change resets both pickers; a reload that removed the pair falls back to the defaults.
  useEffect(() => {
    setState(s => {
      if (s.productId === options.productId && pairValid(options, s.pair)) return s;
      return { productId: options.productId, pair: defaultPair(options), note: null };
    });
  }, [options]);

  const setSizeKey = useCallback((sizeKey: string) => {
    setState(s => {
      const r = changeSize(options, s.pair, sizeKey);
      return { ...s, pair: r.pair, note: r.note };
    });
  }, [options]);

  const setColourKey = useCallback((colourKey: string) => {
    setState(s => ({ ...s, pair: { ...s.pair, colourKey }, note: null }));
  }, []);

  const setPair = useCallback((pair: PairKeys) => {
    setState({ productId: options.productId, pair: pairValid(options, pair) ? pair : defaultPair(options), note: null });
  }, [options]);

  const ids = useMemo(() => pairIds(state.pair), [state.pair]);
  return { ...state.pair, ...ids, note: state.note, setSizeKey, setColourKey, setPair };
}
