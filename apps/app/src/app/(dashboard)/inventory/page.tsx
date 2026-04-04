'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, Package, AlertTriangle, Upload, MapPin, Download } from 'lucide-react';

export default function InventoryPage() {
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [uploading, setUploading] = useState(false);

  const loadMaterials = () => api.get<any[]>('/materials').then(setMaterials).catch(console.error).finally(() => setLoading(false));

  useEffect(() => { loadMaterials(); }, []);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const result = await api.upload('/materials/bulk-upload', file, {});
      setUploadResult(result);
      loadMaterials();
    } catch (err: any) {
      setUploadResult({ errors: [err.message] });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Filaments</h1>
        <div className="flex gap-2">
          <Link href="/inventory/locations">
            <Button variant="outline"><MapPin className="h-4 w-4 mr-2" /> Locations</Button>
          </Link>
          <Button
            variant="outline"
            onClick={() => {
              window.open('/api/materials/template', '_blank');
            }}
          >
            <Download className="h-4 w-4 mr-2" /> Template
          </Button>
          <label className="cursor-pointer inline-flex">
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileUpload} disabled={uploading} />
            <span className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 gap-2">
              <Upload className="h-4 w-4" /> {uploading ? 'Uploading...' : 'Excel Import'}
            </span>
          </label>
          <Link href="/inventory/new">
            <Button><Plus className="h-4 w-4 mr-2" /> Add Material</Button>
          </Link>
        </div>
      </div>

      {uploadResult && (
        <div className={`rounded-md p-4 text-sm ${uploadResult.created > 0 ? 'bg-green-50 text-green-800' : 'bg-yellow-50 text-yellow-800'}`}>
          {uploadResult.created > 0 && <p>Created {uploadResult.created} materials.</p>}
          {uploadResult.skipped > 0 && <p>Skipped {uploadResult.skipped} rows.</p>}
          {uploadResult.errors?.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {uploadResult.errors.slice(0, 5).map((e: string, i: number) => <li key={i}>{e}</li>)}
              {uploadResult.errors.length > 5 && <li>...and {uploadResult.errors.length - 5} more</li>}
            </ul>
          )}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {materials.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              <Package className="h-12 w-12 mx-auto mb-3 text-gray-400" />
              <p>No materials added yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Material</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead>Cost/g</TableHead>
                  <TableHead>Active Spools</TableHead>
                  <TableHead>Total Stock (g)</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {materials.map((m) => {
                  const totalStock = (m.spools || []).reduce((sum: number, s: any) => sum + s.currentWeight, 0);
                  const isLow = totalStock < m.reorderPoint;
                  return (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Link href={`/inventory/${m.id}`} className="font-medium text-brand-600 hover:underline">
                          {m.name}
                        </Link>
                        {m.brand && <p className="text-xs text-gray-500">{m.brand}</p>}
                      </TableCell>
                      <TableCell><Badge className="bg-gray-100 text-gray-700">{m.type}</Badge></TableCell>
                      <TableCell>{m.color || '-'}</TableCell>
                      <TableCell>{formatCurrency(m.costPerGram)}/g</TableCell>
                      <TableCell>{m._count?.spools || 0}</TableCell>
                      <TableCell className="font-mono">{Math.round(totalStock)}g</TableCell>
                      <TableCell>
                        {isLow ? (
                          <Badge className="bg-red-100 text-red-700">
                            <AlertTriangle className="h-3 w-3 mr-1" /> Low Stock
                          </Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-700">OK</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
