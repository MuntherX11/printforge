'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Package } from 'lucide-react';

function formatTime(minutes?: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}

interface ProductSummary {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  basePrice: number;
  estimatedMinutes?: number;
  variants: Array<{ id: string; name: string; basePrice: number }>;
}

export default function CustomerShopPage() {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<any>('/products/customer/catalog')
      .then(r => setProducts(Array.isArray(r) ? r : r?.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const minPrice = (product: ProductSummary) => {
    const prices = [
      ...(product.variants.length > 0 ? product.variants.map(v => v.basePrice) : [product.basePrice]),
    ].filter(p => p > 0);
    return prices.length > 0 ? Math.min(...prices) : 0;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold dark:text-gray-100">Shop</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Browse our 3D printed products — select an item to order
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-gray-100 dark:bg-gray-800 rounded-lg h-64 animate-pulse" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-500 dark:text-gray-400">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No products listed yet</p>
            <p className="text-sm mt-1">
              Use <Link href="/dashboard/quick-quote" className="underline text-brand-600 dark:text-brand-400">Quick Quote</Link> to get a price for a custom file.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:gap-4">
          {products.map(product => (
            <Link key={product.id} href={`/dashboard/shop/${product.id}`} className="group block">
              {/* Mobile list-card */}
              <Card className="sm:hidden transition-shadow hover:shadow-md">
                <CardContent className="p-3 flex gap-3">
                  <div className="w-20 h-20 flex-shrink-0 bg-gray-100 dark:bg-gray-800 rounded-md overflow-hidden">
                    {product.imageUrl ? (
                      <Image
                        src={product.imageUrl}
                        alt={product.name}
                        width={80}
                        height={80}
                        className="w-full h-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                        <Package className="w-8 h-8" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors line-clamp-1 text-sm">
                      {product.name}
                    </h2>
                    {product.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
                        {product.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between mt-2 gap-1">
                      <span className="text-sm font-bold text-brand-600 dark:text-brand-400">
                        {product.variants.length > 0 ? 'From ' : ''}{minPrice(product).toFixed(3)} OMR
                      </span>
                      {product.estimatedMinutes && (
                        <span className="text-xs text-gray-400 dark:text-gray-500">{formatTime(product.estimatedMinutes)}</span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Desktop grid card */}
              <Card className="hidden sm:block h-full transition-shadow hover:shadow-md dark:hover:shadow-brand-900/20">
                <div className="aspect-video bg-gray-100 dark:bg-gray-800 rounded-t-lg overflow-hidden">
                  {product.imageUrl ? (
                    <Image
                      src={product.imageUrl}
                      alt={product.name}
                      width={400}
                      height={225}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                      unoptimized
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-gray-600">
                      <Package className="w-12 h-12" />
                    </div>
                  )}
                </div>
                <CardContent className="p-4">
                  <h2 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors line-clamp-1">
                    {product.name}
                  </h2>
                  {product.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
                      {product.description}
                    </p>
                  )}
                  <div className="flex items-center justify-between mt-3 gap-2">
                    <span className="text-base font-bold text-brand-600 dark:text-brand-400 shrink-0">
                      {product.variants.length > 0 ? 'From ' : ''}{minPrice(product).toFixed(3)} OMR
                    </span>
                    <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 shrink-0">
                      {product.variants.length > 1 && (
                        <Badge variant="default">{product.variants.length} options</Badge>
                      )}
                      {product.estimatedMinutes ? <span>{formatTime(product.estimatedMinutes)}</span> : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
