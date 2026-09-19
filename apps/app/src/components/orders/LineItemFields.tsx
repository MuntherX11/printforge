'use client';

/**
 * One editable order/quote line (New Order, New Quote; spec §5.3): product,
 * then the size and colour pickers in the cell where the old option select
 * was, `+ colour`, and the description / quantity / price / total row with
 * the price hint under the price. Layout as before the release.
 */
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ColourSelect, SizeSelect, STANDARD } from '@/components/products/OptionPickers';
import { LinePriceHint, hintFromPreview } from '@/components/pricing/LinePriceHint';
import type { useLineItems, LineItem } from '@/hooks/use-line-items';

type Lines = ReturnType<typeof useLineItems>;

interface Props {
  item: LineItem;
  index: number;
  lines: Lines;
  productOptions: Array<{ value: string; label: string }>;
  showProductSelect: boolean;
  canRemove: boolean;
  /** Focus the quantity of a line (after `+ colour`). */
  onFocusLine: (key: string) => void;
}

export const lineQtyId = (key: string) => `line-qty-${key}`;

/** Focus a line's quantity once it has rendered (after `+ colour`). */
export function focusLineQty(key: string) {
  setTimeout(() => document.getElementById(lineQtyId(key))?.focus(), 0);
}

export function LineItemFields({ item, index: i, lines, productOptions, showProductSelect, canRemove, onFocusLine }: Props) {
  const opts = item.productId ? lines.pickerOptions(item.productId) : null;
  const sizeKey = item.sizeOptionId ?? STANDARD;
  const colourKey = item.colourOptionId ?? STANDARD;
  const colourWarnings = (item.pricing?.warningCodes ?? [])
    .map((code, k) => (code.startsWith('COLOUR_') ? item.pricing!.warnings[k] : null))
    .filter((w): w is string => !!w);

  return (
    <div className="space-y-2 border-b dark:border-gray-700 pb-3">
      {showProductSelect && (
        <Select
          options={productOptions}
          value={item.productId}
          onChange={e => lines.handleProductSelect(i, e.target.value)}
        />
      )}
      {opts && (opts.hasSizes || opts.hasColours) && (
        <div>
          <div className="flex flex-wrap items-end gap-3">
            {opts.hasSizes && (
              <div className="min-w-[10rem] flex-1">
                <SizeSelect options={opts} value={sizeKey} onChange={k => lines.setSize(i, k)} />
              </div>
            )}
            {opts.hasColours && (
              <>
                <div className="min-w-[10rem] flex-1">
                  <ColourSelect options={opts} sizeKey={sizeKey} value={colourKey} onChange={k => lines.setColour(i, k)} note={item.note} />
                </div>
                <button
                  type="button"
                  onClick={() => { const key = lines.addColourLine(i); if (key) onFocusLine(key); }}
                  className="py-2.5 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  + colour
                </button>
              </>
            )}
          </div>
          {colourWarnings.map(w => (
            <p key={w} className="mt-1 text-xs text-red-600 dark:text-red-400">{w}</p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3 items-start">
        <div className="flex-1 min-w-[10rem]">
          <Input
            placeholder="Description"
            aria-label="Description"
            value={item.description}
            onChange={e => lines.setDescription(i, e.target.value)}
            required
          />
        </div>
        <div className="w-20">
          <Input
            id={lineQtyId(item.key)}
            type="number"
            min="1"
            aria-label="Quantity"
            value={item.quantity === 0 ? '' : item.quantity}
            onChange={e => lines.setQuantity(i, parseInt(e.target.value, 10))}
          />
        </div>
        <div className="w-28">
          <Input
            type="number"
            step="0.001"
            min="0"
            aria-label="Unit price (OMR)"
            value={item.unitPrice}
            onChange={e => lines.setUnitPrice(i, parseFloat(e.target.value) || 0)}
          />
          {item.productId && (
            <LinePriceHint
              info={hintFromPreview(item.pricing)}
              hasSizes={opts?.hasSizes}
              onReset={() => lines.resetPrice(i)}
            />
          )}
        </div>
        <div className="w-24 text-right text-sm font-medium py-2 dark:text-gray-200">
          {(item.quantity * item.unitPrice).toFixed(3)}
        </div>
        {canRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={() => lines.removeItem(i)} aria-label={`Remove item ${i + 1}`}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        )}
      </div>
      {item.productId && item.priceOverride && (
        <Input
          placeholder="Reason for the manual price (optional)"
          aria-label="Reason for the manual price"
          maxLength={200}
          value={item.overrideReason}
          onChange={e => lines.setOverrideReason(i, e.target.value)}
          className="h-8 text-xs"
        />
      )}
    </div>
  );
}
