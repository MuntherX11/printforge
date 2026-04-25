'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import dynamic from 'next/dynamic';
const SpoolLabelScanner = dynamic(
  () => import('@/components/spool-label-scanner').then(m => ({ default: m.SpoolLabelScanner })),
  { ssr: false },
);
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { EmptyState } from '@/components/ui/empty-state';
import { Plus, Package, AlertTriangle, Upload, MapPin, Download, ScanLine } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function InventoryPage() {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [scannedFields, setScannedFields] = useState<any>(null);
  const [showRawOcr, setShowRawOcr] = useState(false);
  const [creating, setCreating] = useState(false);

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

  function handleScanResult(fields: any) {
    setScannedFields(fields);
    setShowRawOcr(false);
  }

  function updateField(key: string, value: string) {
    setScannedFields((prev: any) => ({ ...prev, [key]: value }));
  }

  async function handleConfirmCreate() {
    if (!scannedFields) return;
    setCreating(true);
    try {
      const matName = scannedFields.brand
        ? `${scannedFields.brand} ${scannedFields.materialType || 'PLA'}`
        : scannedFields.materialType || 'PLA';
      const matType = scannedFields.materialType || 'PLA';
      const matColor = scannedFields.color || '';

      // Check if a matching material already exists
      let material = materials.find(
        (m) =>
          m.type?.toUpperCase() === matType.toUpperCase() &&
          m.color?.toLowerCase() === matColor.toLowerCase() &&
          (!scannedFields.brand || m.brand?.toLowerCase() === scannedFields.brand.toLowerCase()),
      );

      if (!material) {
        material = await api.post('/materials', {
          name: matName,
          type: matType,
          color: matColor,
          brand: scannedFields.brand || '',
          costPerGram: 0,
          density: 1.24,
        });
      }

      const initialWeight = scannedFields.weight ? parseFloat(scannedFields.weight) : 1000;

      await api.post('/spools', {
        materialId: material.id,
        initialWeight,
        currentWeight: initialWeight,
      });

      setScannedFields(null);
      loadMaterials();
    } catch (err: any) {
      toast('error', 'Failed to create spool: ' + (err.message || 'Unknown error'));
    } finally {
      setCreating(false);
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
          <Button variant="outline" onClick={() => setShowScanner(true)}>
            <ScanLine className="h-4 w-4 mr-2" /> Scan Label
          </Button>
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
            <EmptyState
              icon={<Package className="h-12 w-12" />}
              title="No materials added yet"
              description="Add your first material spool to start tracking inventory"
            />
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

      <SpoolLabelScanner
        open={showScanner}
        onClose={() => setShowScanner(false)}
        onResult={handleScanResult}
      />

      <Dialog open={!!scannedFields} onClose={() => setScannedFields(null)} title="Review Scanned Label">
        {scannedFields && (
          <div className="space-y-4">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Review and edit any fields before creating the spool. Missing fields can be filled in manually.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Brand"
                value={scannedFields.brand || ''}
                onChange={(e) => updateField('brand', e.target.value)}
                placeholder="e.g. eSUN"
                list="known-brands"
              />
              <datalist id="known-brands">
                {['eSUN', 'Bambu', 'Polymaker', 'Hatchbox', 'Overture', 'Sunlu', 'Creality', 'Prusament', 'PolyTerra', 'PolyLite', 'Anycubic', 'Elegoo'].map(b => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              <Input
                label="Type"
                value={scannedFields.materialType || ''}
                onChange={(e) => updateField('materialType', e.target.value)}
                placeholder="PLA"
              />
              <Input
                label="Color"
                value={scannedFields.color || ''}
                onChange={(e) => updateField('color', e.target.value)}
                placeholder="e.g. Black"
              />
              <Input
                label="Diameter (mm)"
                value={scannedFields.diameter || ''}
                onChange={(e) => updateField('diameter', e.target.value)}
                placeholder="1.75"
              />
              <Input
                label="Weight (g)"
                value={scannedFields.weight || ''}
                onChange={(e) => updateField('weight', e.target.value)}
                placeholder="1000"
              />
              <Input
                label="Print Temp (°C)"
                value={scannedFields.printTemp || ''}
                onChange={(e) => updateField('printTemp', e.target.value)}
                placeholder="210-230"
              />
            </div>
            {scannedFields.rawText && (
              <div className="text-xs">
                <button
                  type="button"
                  onClick={() => setShowRawOcr((s) => !s)}
                  className="text-brand-600 dark:text-brand-400 hover:underline"
                >
                  {showRawOcr ? 'Hide' : 'Show'} raw OCR text
                </button>
                {showRawOcr && (
                  <pre className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-gray-700 dark:text-gray-300">
                    {scannedFields.rawText}
                  </pre>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setScannedFields(null)}>Cancel</Button>
              <Button onClick={handleConfirmCreate} disabled={creating}>
                {creating ? 'Creating...' : 'Confirm & Create'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
