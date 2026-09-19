'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type {
  ApiMaterial,
  ApiPrinter,
  ApiProductImage,
  OptionCost,
  ProductCostPayload,
  ProductDetail,
} from '@/lib/types/api';

export type ProductLoadStatus = 'loading' | 'ready' | 'notFound' | 'error';

/**
 * Everything the product page and its sections read. Sections added later
 * (WP9b sizes & colours, WP9 BOM / readiness / bulk pricing) take this object
 * or the fields they need, and call `reload()` / `reloadCost()` after writes.
 */
export interface ProductPageData {
  status: ProductLoadStatus;
  /** Load error of GET /products/:id (status 'error'). */
  error: string | null;
  product: ProductDetail | null;
  /** GET /products/:id/cost (P16). null until loaded or when it failed. */
  cost: ProductCostPayload | null;
  costError: string | null;
  /** The standard size on the standard colour (the Pricing card's figures). */
  standardCost: OptionCost | null;
  costVersion: string | null;
  /** GET /products/:id/images (G1). null until loaded or when it failed. */
  images: ApiProductImage[] | null;
  imagesError: string | null;
  canEdit: boolean;
  isAdmin: boolean;
  /** Product, cost and photos again (after any write that can change them). */
  reload: () => Promise<void>;
  /** Product and cost (a price can change with the cost, e.g. after a parts change). */
  reloadCost: () => Promise<void>;
  reloadImages: () => Promise<void>;
  /** Lazily loaded, cached for the page lifetime. */
  loadPrinters: () => Promise<ApiPrinter[]>;
  loadMaterials: () => Promise<ApiMaterial[]>;
}

interface State {
  status: ProductLoadStatus;
  error: string | null;
  product: ProductDetail | null;
  cost: ProductCostPayload | null;
  costError: string | null;
  images: ApiProductImage[] | null;
  imagesError: string | null;
}

const INITIAL: State = {
  status: 'loading',
  error: null,
  product: null,
  cost: null,
  costError: null,
  images: null,
  imagesError: null,
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useProduct(id: string): ProductPageData {
  const { role } = useAuth();
  const [state, setState] = useState<State>(INITIAL);
  // Each fetch kind carries a sequence number so a slow, older response can
  // never overwrite a newer one.
  const seq = useRef({ product: 0, cost: 0, images: 0 });
  const printersRef = useRef<Promise<ApiPrinter[]> | null>(null);
  const materialsRef = useRef<Promise<ApiMaterial[]> | null>(null);

  const fetchProduct = useCallback(async () => {
    const n = ++seq.current.product;
    try {
      const product = await api.get<ProductDetail>(`/products/${id}`);
      if (n !== seq.current.product) return;
      setState(s => ({ ...s, status: 'ready', error: null, product }));
    } catch (err) {
      if (n !== seq.current.product) return;
      const notFound = err instanceof ApiError && err.status === 404;
      // A failed refresh keeps the page that is already shown.
      setState(s => s.product && !notFound
        ? s
        : { ...s, status: notFound ? 'notFound' : 'error', error: messageOf(err, 'Couldn\'t load the product') });
    }
  }, [id]);

  const fetchCost = useCallback(async () => {
    const n = ++seq.current.cost;
    try {
      const cost = await api.get<ProductCostPayload>(`/products/${id}/cost`);
      if (n !== seq.current.cost) return;
      setState(s => ({ ...s, cost, costError: null }));
    } catch (err) {
      if (n !== seq.current.cost) return;
      setState(s => ({ ...s, costError: messageOf(err, 'Couldn\'t load the cost') }));
    }
  }, [id]);

  const fetchImages = useCallback(async () => {
    const n = ++seq.current.images;
    try {
      const images = await api.get<ApiProductImage[]>(`/products/${id}/images`);
      if (n !== seq.current.images) return;
      const sorted = [...(Array.isArray(images) ? images : [])].sort((a, b) => a.sortOrder - b.sortOrder);
      setState(s => ({ ...s, images: sorted, imagesError: null }));
    } catch (err) {
      if (n !== seq.current.images) return;
      setState(s => ({ ...s, imagesError: messageOf(err, 'Couldn\'t load photos') }));
    }
  }, [id]);

  const reload = useCallback(async () => {
    await Promise.all([fetchProduct(), fetchCost(), fetchImages()]);
  }, [fetchProduct, fetchCost, fetchImages]);

  const reloadCost = useCallback(async () => {
    await Promise.all([fetchProduct(), fetchCost()]);
  }, [fetchProduct, fetchCost]);

  useEffect(() => {
    setState(INITIAL);
    void reload();
  }, [reload]);

  const loadPrinters = useCallback(() => {
    if (!printersRef.current) {
      printersRef.current = api.get<ApiPrinter[]>('/printers')
        .then(r => (Array.isArray(r) ? r : []))
        .catch(err => { printersRef.current = null; throw err; });
    }
    return printersRef.current;
  }, []);

  const loadMaterials = useCallback(() => {
    if (!materialsRef.current) {
      materialsRef.current = api.get<ApiMaterial[] | { data: ApiMaterial[] }>('/materials?limit=500')
        .then(r => (Array.isArray(r) ? r : r?.data ?? []))
        .catch(err => { materialsRef.current = null; throw err; });
    }
    return materialsRef.current;
  }, []);

  const standardCost = state.cost?.sizes.find(s => s.sizeOptionId === null && s.colourOptionId === null) ?? null;

  return {
    ...state,
    standardCost,
    costVersion: state.cost?.costVersion ?? null,
    canEdit: role === 'ADMIN' || role === 'OPERATOR',
    isAdmin: role === 'ADMIN',
    reload,
    reloadCost,
    reloadImages: fetchImages,
    loadPrinters,
    loadMaterials,
  };
}
