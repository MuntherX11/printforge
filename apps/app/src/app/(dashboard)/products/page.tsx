'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, Box } from 'lucide-react';

export default function ProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<any[]>('/products').then(setProducts).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Products</h1>
        <Link href="/products/new">
          <Button><Plus className="h-4 w-4 mr-2" /> Add Product</Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {products.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              <Box className="h-12 w-12 mx-auto mb-3 text-gray-400" />
              <p>No products added yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16"></TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Components</TableHead>
                  <TableHead>Est. Grams</TableHead>
                  <TableHead>Est. Minutes</TableHead>
                  <TableHead>Base Price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="w-16">
                      {p.imageUrl ? (
                        <img src={`/api/uploads/${p.imageUrl}`} alt={p.name} className="h-10 w-10 rounded object-cover" />
                      ) : (
                        <div className="h-10 w-10 rounded bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                          <Box className="h-5 w-5 text-gray-400" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link href={`/products/${p.id}`} className="font-medium text-brand-600 hover:underline">
                        {p.name}
                      </Link>
                      {p.description && <p className="text-xs text-gray-500">{p.description}</p>}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{p.sku || '-'}</TableCell>
                    <TableCell>{p._count?.components || 0}</TableCell>
                    <TableCell className="font-mono">{Math.round(p.estimatedGrams)}g</TableCell>
                    <TableCell className="font-mono">{Math.round(p.estimatedMinutes)}min</TableCell>
                    <TableCell>{formatCurrency(p.basePrice)}</TableCell>
                    <TableCell>
                      <Badge className={p.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
