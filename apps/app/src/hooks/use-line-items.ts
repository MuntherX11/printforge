'use client';

import { useState } from 'react';

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  productId: string;
}

export function useLineItems(products: Array<{ id: string; name: string; sku?: string; basePrice: number }>) {
  const [items, setItems] = useState<LineItem[]>([
    { description: '', quantity: 1, unitPrice: 0, productId: '' },
  ]);

  function addItem() {
    setItems(prev => [...prev, { description: '', quantity: 1, unitPrice: 0, productId: '' }]);
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  function updateItem(index: number, field: keyof LineItem, value: string | number) {
    setItems(prev => {
      const next = [...prev];
      (next[index] as any)[field] = value;
      return next;
    });
  }

  function handleProductSelect(index: number, productId: string) {
    setItems(prev => {
      const next = [...prev];
      const product = products.find(p => p.id === productId);
      if (product) {
        next[index] = { description: product.name, quantity: 1, unitPrice: product.basePrice, productId };
      } else {
        next[index] = { ...next[index], productId: '' };
      }
      return next;
    });
  }

  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

  return { items, setItems, addItem, removeItem, updateItem, handleProductSelect, subtotal };
}
