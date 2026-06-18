'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ArrowLeft, Clock, Package } from 'lucide-react';

function formatTime(minutes?: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}

interface Variant {
  id: string;
  name: string;
  sku?: string;
  basePrice: number;
  estimatedMinutes?: number;
  estimatedGrams?: number;
}

interface Product {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  basePrice: number;
  estimatedMinutes?: number;
  estimatedGrams?: number;
  variants: Variant[];
}

export default function CustomerProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedVariant, setSelectedVariant] = useState<Variant | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [ordered, setOrdered] = useState(false);

  useEffect(() => {
    if (!params?.id) return;
    api.get<any>(`/products/customer/${params.id}`)
      .then(r => {
        const p = r?.data ?? r;
        setProduct(p);
        if (p?.variants?.length > 0) setSelectedVariant(p.variants[0]);
      })
      .catch(() => router.push('/dashboard/shop'))
      .finally(() => setLoading(false));
  }, [params?.id]);

  const price = selectedVariant ? selectedVariant.basePrice : product?.basePrice ?? 0;
  const totalPrice = price * quantity;
  const priceReady = price > 0;

  async function handleOrder() {
    if (!product) return;
    setSubmitting(true);
    try {
      const item = selectedVariant
        ? { variantId: selectedVariant.id, quantity }
        : { productId: product.id, quantity };
      await api.post('/orders/customer', { items: [item] });
      setOrdered(true);
      toast('success', 'Order placed — we\'ll confirm it shortly!');
    } catch (err: any) {
      toast('error', err.message || 'Failed to place order. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 max-w-2xl animate-pulse">
        <div className="h-5 bg-gray-200 dark:bg-gray-700 rounded w-24" />
        <div className="aspect-video bg-gray-200 dark:bg-gray-700 rounded-lg" />
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
        <div className="h-48 bg-gray-200 dark:bg-gray-700 rounded-lg" />
      </div>
    );
  }

  if (!product) return null;

  return (
    <div className="space-y-6 max-w-2xl">
      <button
        onClick={() => router.push('/dashboard/shop')}
        className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Shop
      </button>

      {/* Product image */}
      <div className="aspect-video bg-gray-100 dark:bg-gray-800 rounded-lg overflow-hidden">
        {product.imageUrl ? (
          <Image
            src={product.imageUrl}
            alt={product.name}
            width={700}
            height={394}
            className="w-full h-full object-cover"
            unoptimized
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
            <Package className="w-16 h-16" />
          </div>
        )}
      </div>

      {/* Product info */}
      <div>
        <h1 className="text-2xl font-bold dark:text-gray-100">{product.name}</h1>
        {product.description && (
          <p className="text-gray-600 dark:text-gray-400 mt-2 leading-relaxed">{product.description}</p>
        )}
        {(product.estimatedMinutes || product.estimatedGrams) && (
          <div className="flex gap-4 mt-3 text-sm text-gray-500 dark:text-gray-400">
            {product.estimatedMinutes && (
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" />{formatTime(product.estimatedMinutes)} print time
              </span>
            )}
            {product.estimatedGrams && (
              <span className="flex items-center gap-1.5">
                <Package className="h-4 w-4" />{Math.round(product.estimatedGrams)}g material
              </span>
            )}
          </div>
        )}
      </div>

      {/* Order card */}
      <Card>
        <CardContent className="p-4 space-y-5">
          {/* Variant chips */}
          {product.variants.length > 0 && (
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Select option</p>
              <div className="flex flex-wrap gap-2">
                {product.variants.map(variant => (
                  <button
                    key={variant.id}
                    onClick={() => setSelectedVariant(variant)}
                    className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${
                      selectedVariant?.id === variant.id
                        ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950/30 dark:text-brand-300'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    {variant.name}
                    {variant.basePrice > 0 && (
                      <span className="ml-1.5 text-xs opacity-70">{variant.basePrice.toFixed(3)}</span>
                    )}
                  </button>
                ))}
              </div>
              {selectedVariant?.estimatedMinutes && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 flex items-center gap-1">
                  <Clock className="h-3 w-3" />{formatTime(selectedVariant.estimatedMinutes)} for this option
                </p>
              )}
            </div>
          )}

          {/* Quantity */}
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Quantity</p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setQuantity(q => Math.max(1, q - 1))}
                className="w-8 h-8 rounded-md border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                −
              </button>
              <span className="w-8 text-center font-semibold dark:text-gray-200">{quantity}</span>
              <button
                onClick={() => setQuantity(q => Math.min(50, q + 1))}
                className="w-8 h-8 rounded-md border border-gray-300 dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                +
              </button>
            </div>
          </div>

          {/* Price + CTA */}
          <div className="border-t dark:border-gray-700 pt-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-600 dark:text-gray-400 text-sm">Total</span>
              <span className="text-2xl font-bold text-brand-600 dark:text-brand-400">
                {priceReady ? `${totalPrice.toFixed(3)} OMR` : '—'}
              </span>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Estimated lead time: 1–3 business days. We'll confirm your order before printing.
            </p>

            {ordered ? (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg px-4 py-3 text-sm text-green-700 dark:text-green-400">
                Order placed!{' '}
                <button
                  onClick={() => router.push('/dashboard/orders')}
                  className="underline font-medium"
                >
                  View in My Orders
                </button>
              </div>
            ) : !priceReady ? (
              <div className="space-y-2">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Price not available for this option — use Quick Quote or chat with us.
                </p>
                <Button variant="outline" className="w-full" onClick={() => router.push('/dashboard/quick-quote')}>
                  Get a Custom Quote
                </Button>
              </div>
            ) : (
              <Button className="w-full" onClick={handleOrder} disabled={submitting}>
                {submitting ? 'Placing Order…' : 'Request Order'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
