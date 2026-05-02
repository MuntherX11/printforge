'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Plus, Box, Upload } from 'lucide-react';

export default function ProductsPage() {
  const formatCurrency = useFormatCurrency();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchProducts = useCallback(() => {
    setLoading(true);
    setData(null);
    api.get<any>(`/products?page=${page}&limit=25`).then(setData).catch(console.error).finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const handleImportClick = () => {
    setImportResult(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!e.target.files) return;
    // Reset so the same file can be re-selected after an error
    e.target.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setImporting(true);
    setImportResult(null);
    try {
      const result = await api.postForm<{ created: number; updated: number; errors: string[] }>(
        '/products/upload-bom',
        formData,
      );
      setImportResult(result);
      if (result.created > 0 || result.updated > 0) {
        fetchProducts();
      }
    } catch (err: any) {
      setImportResult({ created: 0, updated: 0, errors: [err?.message ?? 'Import failed'] });
    } finally {
      setImporting(false);
    }
  };

  if (loading) return <Loading />;

  const products: any[] = data?.data || data || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Products</h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button variant="outline" onClick={handleImportClick} disabled={importing}>
            <Upload className="h-4 w-4 mr-2" />
            {importing ? 'Importing...' : 'Import Excel'}
          </Button>
          <Link href="/products/new">
            <Button><Plus className="h-4 w-4 mr-2" /> Add Product</Button>
          </Link>
        </div>
      </div>

      {importResult && (
        <div className={`rounded-md px-4 py-3 text-sm ${importResult.errors.length > 0 ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'}`}>
          {importResult.errors.length === 0 || importResult.created > 0 || importResult.updated > 0 ? (
            <p className="font-medium">
              Imported: {importResult.created} created, {importResult.updated} updated
              {importResult.errors.length > 0 ? ` (${importResult.errors.length} row error${importResult.errors.length > 1 ? 's' : ''})` : ''}
            </p>
          ) : null}
          {importResult.errors.length > 0 && (
            <ul className="mt-1 list-disc list-inside space-y-0.5">
              {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {products.length === 0 ? (
            <EmptyState
              icon={<Box className="h-12 w-12" />}
              title="No products added yet"
              description="Create your first product to link it to orders and production jobs"
              action={<Link href="/products/new"><Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Product</Button></Link>}
            />
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
      <Pagination page={page} totalPages={data?.totalPages ?? 1} onPageChange={setPage} />
    </div>
  );
}
