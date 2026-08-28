'use client';

import { useState } from 'react';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  productId: string;
  variantId?: string;
}

export function useLineItems(products: Array<{ id: string; name: string; sku?: string; basePrice: number; priceTiers?: Array<{ minQty: number; unitPrice: number }>; variants?: Array<{ id: string; name: string; sku: string; basePrice?: number | null }> }>) {
  const [items, setItems] = useState<LineItem[]>([
    { description: '', quantity: 1, unitPrice: 0, productId: '', variantId: '' },
  ]);

  function addItem() {
    setItems(prev => [...prev, { description: '', quantity: 1, unitPrice: 0, productId: '', variantId: '' }]);
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  /** Highest tier the line quantity qualifies for, if the product has any. */
  function tieredPrice(productId: string, qty: number): number | null {
    const product = products.find(p => p.id === productId);
    if (!product?.priceTiers?.length) return null;
    const hit = [...product.priceTiers]
      .sort((a, b) => b.minQty - a.minQty)
      .find(t => qty >= t.minQty);
    return hit ? hit.unitPrice : null;
  }

  function updateItem(index: number, field: keyof LineItem, value: string | number) {
    setItems(prev => {
      const next = [...prev];
      (next[index] as any)[field] = value;
      // Bulk tiers follow the quantity automatically — but only for whole
      // products (variants have no tiers), and the price stays editable after,
      // so staff can always override what the tier chose.
      if (field === 'quantity') {
        const item = next[index];
        const product = products.find(p => p.id === item.productId);
        // Only products that HAVE tiers get repriced on quantity change —
        // for everything else a manually typed price must survive qty edits,
        // exactly as before.
        if (item.productId && !item.variantId && product?.priceTiers?.length) {
          const tp = tieredPrice(item.productId, Number(value) || 1);
          next[index] = { ...item, unitPrice: tp ?? product.basePrice };
        }
      }
      return next;
    });
  }

  function handleProductSelect(index: number, productId: string) {
    setItems(prev => {
      const next = [...prev];
      const product = products.find(p => p.id === productId);
      if (product) {
        next[index] = { description: product.name, quantity: 1, unitPrice: product.basePrice, productId, variantId: '' };
      } else {
        next[index] = { ...next[index], productId: '', variantId: '' };
      }
      return next;
    });
  }

  function handleVariantSelect(index: number, variantId: string, productBasePrice: number) {
    setItems(prev => {
      const next = [...prev];
      const item = next[index];
      const product = products.find(p => p.id === item.productId);
      const variant = product?.variants?.find(v => v.id === variantId);
      if (variant) {
        next[index] = {
          ...item,
          variantId,
          description: variant.name,
          unitPrice: variant.basePrice != null ? variant.basePrice : productBasePrice,
        };
      } else {
        // cleared variant — revert to product defaults
        if (product) {
          next[index] = { ...item, variantId: '', description: product.name, unitPrice: productBasePrice };
        } else {
          next[index] = { ...item, variantId: '' };
        }
      }
      return next;
    });
  }

  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

  return { items, setItems, addItem, removeItem, updateItem, handleProductSelect, handleVariantSelect, subtotal };
}
