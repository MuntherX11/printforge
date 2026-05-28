'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import NextImage from 'next/image';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import type { ApiProduct, ApiMaterial, ApiPrinter } from '@/lib/types/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { notFound } from 'next/navigation';
import { Plus, Calculator, Trash2, Edit2, Upload, Image as ImageIcon, X, AlertTriangle, CheckCircle, FileCode, Tag, RefreshCw } from 'lucide-react';
import { ThreeMfImportWizard } from './ThreeMfImportWizard';
import { useToast } from '@/components/ui/toast';

export default function ProductDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [product, setProduct] = useState<ApiProduct | null>(null);
  const [materials, setMaterials] = useState<ApiMaterial[]>([]);
  const [printers, setPrinters] = useState<ApiPrinter[]>([]);
  const [images, setImages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddComponent, setShowAddComponent] = useState(false);
  const [showEditProduct, setShowEditProduct] = useState(false);
  const [adding, setAdding] = useState(false);
  const [costResult, setCostResult] = useState<any>(null);
  const [calculating, setCalculating] = useState(false);
  const [uploadingGcode, setUploadingGcode] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [editingComponentId, setEditingComponentId] = useState<string | null>(null);
  const [editComponentName, setEditComponentName] = useState('');
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [savingComponent, setSavingComponent] = useState(false);
  const [showDeleteProduct, setShowDeleteProduct] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [showDeleteComponent, setShowDeleteComponent] = useState<string | null>(null);
  const [deletingComponent, setDeletingComponent] = useState<string | null>(null);
  const [showDeleteImage, setShowDeleteImage] = useState<string | null>(null);
  const [deletingImage, setDeletingImage] = useState<string | null>(null);
  const [showThreeMfWizard, setShowThreeMfWizard] = useState(false);
  const [threeMfFile, setThreeMfFile] = useState<File | null>(null);
  const [threeMfAnalysis, setThreeMfAnalysis] = useState<any>(null);
  const [analyzingThreeMf, setAnalyzingThreeMf] = useState(false);

  // Variants
  const [showAddVariant, setShowAddVariant] = useState(false);
  const [showEditVariant, setShowEditVariant] = useState<any>(null);
  const [showDeleteVariant, setShowDeleteVariant] = useState<string | null>(null);
  const [savingVariant, setSavingVariant] = useState(false);
  const [deletingVariant, setDeletingVariant] = useState(false);
  const [calculatingVariant, setCalculatingVariant] = useState<string | null>(null);
  const [variantCostResult, setVariantCostResult] = useState<{ id: string; result: any } | null>(null);
  const [uploadingVariantGcode, setUploadingVariantGcode] = useState<string | null>(null);

  const load = () => {
    Promise.all([
      api.get<ApiProduct>(`/products/${id}`),
      api.get<{ data: ApiMaterial[] } | ApiMaterial[]>('/materials?limit=500').then((r: any) => Array.isArray(r) ? r : (r?.data ?? [])),
      api.get<ApiPrinter[]>('/printers'),
      api.get<{ id: string; fileName: string }[]>(`/attachments?entityType=product&entityId=${id}`).catch(() => [] as { id: string; fileName: string }[]),
    ]).then(([p, m, pr, imgs]) => {
      setProduct(p);
      setMaterials(m);
      setPrinters(pr);
      setImages(imgs);
    }).catch((err: unknown) => {
      toast('error', (err as Error)?.message || 'Failed to load product details');
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  async function handleAddComponent(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdding(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post(`/products/${id}/components`, {
        materialId: form.get('materialId') as string,
        description: form.get('description') as string,
        gramsUsed: parseFloat(form.get('gramsUsed') as string),
        printMinutes: parseFloat(form.get('printMinutes') as string) || 0,
        quantity: parseInt(form.get('quantity') as string) || 1,
      });
      setShowAddComponent(false);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDeleteComponent(componentId: string) {
    setDeletingComponent(componentId);
    try {
      await api.delete(`/products/components/${componentId}`);
      setShowDeleteComponent(null);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setDeletingComponent(null);
    }
  }

  async function handleCalculateCost() {
    setCalculating(true);
    setCostResult(null);
    try {
      const result = await api.post(`/products/${id}/calculate`);
      setCostResult(result);
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setCalculating(false);
    }
  }

  async function handleUpdateProduct(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.patch(`/products/${id}`, {
        name: form.get('name') as string,
        description: form.get('description') as string || undefined,
        sku: form.get('sku') as string || undefined,
        colorChanges: parseInt(form.get('colorChanges') as string) || 0,
        defaultPrinterId: (form.get('defaultPrinterId') as string) || null,
        isActive: form.get('isActive') === 'true',
      });
      setShowEditProduct(false);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    }
  }

  async function handleGcodeUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    setUploadingGcode(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }
      const res = await fetch(`/api/products/${id}/onboard-gcode`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || body?.message || `Upload failed (${res.status})`);
      }
      load();
    } catch (err: unknown) {
      // Reload anyway — the backend may have processed before the response failed
      load();
      if ((err as Error).message !== 'Failed to fetch') {
        toast('error', (err as Error).message);
      }
    } finally {
      setUploadingGcode(false);
      e.target.value = '';
    }
  }

  async function handle3MfSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAnalyzingThreeMf(true);
    setThreeMfFile(file);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/file-parser/analyze', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Analysis failed (${res.status})`);
      }
      const data = await res.json();
      setThreeMfAnalysis(data.analysis);
      setShowThreeMfWizard(true);
    } catch (err: unknown) {
      toast('error', (err as Error).message || 'Failed to read 3MF file');
      setThreeMfFile(null);
    } finally {
      setAnalyzingThreeMf(false);
      e.target.value = '';
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    setUploadingImages(true);
    try {
      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
      }
      const res = await fetch(`/api/products/${id}/images`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Upload failed');
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setUploadingImages(false);
      e.target.value = '';
    }
  }

  async function handleUpdateComponentName(componentId: string) {
    if (!editComponentName.trim()) return;
    setSavingComponent(true);
    try {
      await api.patch(`/products/${id}/components/${componentId}`, { description: editComponentName.trim() });
      setEditingComponentId(null);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setSavingComponent(false);
    }
  }

  async function handleUpdateComponentMaterial(componentId: string, materialId: string) {
    setSavingComponent(true);
    try {
      await api.patch(`/products/${id}/components/${componentId}`, { materialId });
      setEditingMaterialId(null);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setSavingComponent(false);
    }
  }

  async function handleDeleteImage(attachmentId: string) {
    setDeletingImage(attachmentId);
    try {
      await api.delete(`/products/${id}/images/${attachmentId}`);
      setShowDeleteImage(null);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setDeletingImage(null);
    }
  }

  async function handleDeleteProduct() {
    setDeletingProduct(true);
    try {
      await api.delete(`/products/${id}`);
      router.push('/products');
    } catch (err: unknown) {
      toast('error', (err as Error).message || 'Delete failed');
      setDeletingProduct(false);
    }
  }

  async function handleCalculateVariant(variantId: string) {
    setCalculatingVariant(variantId);
    setVariantCostResult(null);
    try {
      const result = await api.post(`/products/${id}/variants/${variantId}/calculate`);
      setVariantCostResult({ id: variantId, result });
      load(); // refresh so new basePrice shows in the table
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setCalculatingVariant(null);
    }
  }

  async function handleAddVariant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSavingVariant(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post(`/products/${id}/variants`, {
        name: form.get('name') as string,
        sku: form.get('sku') as string,
        basePrice: form.get('basePrice') ? parseFloat(form.get('basePrice') as string) : undefined,
        estimatedMinutes: form.get('estimatedMinutes') ? parseFloat(form.get('estimatedMinutes') as string) : undefined,
        estimatedGrams: form.get('estimatedGrams') ? parseFloat(form.get('estimatedGrams') as string) : undefined,
        isActive: form.get('isActive') !== 'false',
      });
      setShowAddVariant(false);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setSavingVariant(false);
    }
  }

  async function handleUpdateVariant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!showEditVariant) return;
    setSavingVariant(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.patch(`/products/${id}/variants/${showEditVariant.id}`, {
        name: form.get('name') as string,
        sku: form.get('sku') as string,
        basePrice: form.get('basePrice') ? parseFloat(form.get('basePrice') as string) : null,
        estimatedMinutes: form.get('estimatedMinutes') ? parseFloat(form.get('estimatedMinutes') as string) : null,
        estimatedGrams: form.get('estimatedGrams') ? parseFloat(form.get('estimatedGrams') as string) : null,
        isActive: form.get('isActive') !== 'false',
      });
      setShowEditVariant(null);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setSavingVariant(false);
    }
  }

  async function handleVariantGcodeUpload(variantId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingVariantGcode(variantId);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/products/${id}/variants/${variantId}/onboard-gcode`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || body?.message || `Upload failed (${res.status})`);
      }
      toast('success', 'Grams, minutes and price updated from gcode');
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setUploadingVariantGcode(null);
      e.target.value = '';
    }
  }

  async function handleDeleteVariant() {
    if (!showDeleteVariant) return;
    setDeletingVariant(true);
    try {
      await api.delete(`/products/${id}/variants/${showDeleteVariant}`);
      setShowDeleteVariant(null);
      load();
    } catch (err: unknown) {
      toast('error', (err as Error).message);
    } finally {
      setDeletingVariant(false);
    }
  }

  if (loading) return <Loading />;
  if (!product) return notFound();

  const materialOptions = materials.map(m => ({ value: m.id, label: `${m.name} (${m.type}${m.color ? ' - ' + m.color : ''})` }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{product.name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {product.sku && <span className="font-mono">{product.sku} | </span>}
            {product.description || 'No description'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/20" onClick={() => setShowDeleteProduct(true)}>
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </Button>
          <Button variant="outline" onClick={() => setShowEditProduct(true)}>
            <Edit2 className="h-4 w-4 mr-2" /> Edit
          </Button>
          <Button onClick={handleCalculateCost} disabled={calculating}>
            <Calculator className="h-4 w-4 mr-2" /> {calculating ? 'Calculating...' : 'Calculate Cost'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <dl className="flex-1 grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
          <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Components</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{product.components?.length || 0}</dd></div>
          <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Est. Grams</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{Math.round(product.estimatedGrams)}g</dd></div>
          <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Est. Minutes</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{Math.round(product.estimatedMinutes)}min</dd></div>
          <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Color Changes</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{product.colorChanges || 0}</dd></div>
        </dl>
        <Card className="sm:w-48 flex-shrink-0">
          <CardContent className="p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-medium text-[11px]">Default Printer</p>
            <select
              className="mt-1.5 w-full text-sm border rounded px-2 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              value={product.defaultPrinterId || ''}
              onChange={async (e) => {
                const val = e.target.value || null;
                try {
                  await api.patch(`/products/${id}`, { defaultPrinterId: val });
                  load();
                } catch (err: unknown) { toast('error', (err as Error).message); }
              }}
            >
              <option value="">None</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </CardContent>
        </Card>
      </div>

      {(product.components?.length ?? 0) > 0 && (() => {
        const allReady = product.components!.every((c) => c.hasEnoughStock);
        const shortages = product.components!.filter((c) => !c.hasEnoughStock);
        return (
          <Card className={allReady ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20' : 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'}>
            <CardContent className="p-4 flex items-center gap-3">
              {allReady ? (
                <>
                  <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-300">All materials in stock — ready to produce</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
                    {shortages.length} component{shortages.length > 1 ? 's' : ''} low on stock:{' '}
                    {shortages.map((c: any) => `${c.material?.name || 'Unknown'} (${c.totalStock}g / ${Math.round(c.gramsNeeded)}g)`).join(', ')}
                  </span>
                </>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {costResult && (
        <Card className="border-brand-200 bg-brand-50 dark:border-brand-900 dark:bg-brand-950/20">
          <CardHeader><CardTitle>Cost Breakdown</CardTitle></CardHeader>
          <CardContent className="p-0">
            <dl className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-brand-100 dark:divide-gray-800">
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Material Cost</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(costResult.materialCost)}</dd></div>
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Machine Cost</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(costResult.machineCost)}</dd></div>
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Electricity</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(costResult.electricityCost || 0)}</dd></div>
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Waste + Overhead</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(costResult.wasteCost + costResult.overheadCost)}</dd></div>
            </dl>
            <dl className="grid grid-cols-3 divide-x divide-brand-100 dark:divide-gray-800 border-t border-brand-100 dark:border-gray-800">
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Total Cost</dt><dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(costResult.totalCost)}</dd></div>
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Suggested Price</dt><dd className="text-sm font-semibold tabular-nums text-brand-600 dark:text-brand-400">{formatCurrency(costResult.suggestedPrice)}</dd></div>
              <div className="px-4 py-3 flex flex-col gap-0.5"><dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Markup</dt><dd className="text-sm font-semibold tabular-nums text-green-700 dark:text-green-400">{costResult.markupMultiplier}×</dd></div>
            </dl>
            {costResult.components?.length > 0 && (
              <div className="px-4 py-3 border-t border-brand-100 dark:border-gray-800">
                <p className="text-sm font-medium mb-2 dark:text-gray-200">Per-Component Costs</p>
                {costResult.components.map((c: any, i: number) => (
                  <div key={i} className="flex justify-between text-sm py-1 dark:text-gray-300">
                    <span>{c.description} ({c.materialName})</span>
                    <span className="font-mono">{formatCurrency(c.componentCost)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Components (BOM)</CardTitle>
          <Button size="sm" onClick={() => setShowAddComponent(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add Component
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {(!product.components || product.components.length === 0) ? (
            <div className="py-8 text-center text-gray-500">No components yet. Add materials that make up this product.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Material</TableHead>
                  <TableHead>Grams</TableHead>
                  <TableHead>Print Time</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Material Stock</TableHead>
                  <TableHead>On Hand</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.components
                  .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
                  .map((c: any, i: number) => (
                  <TableRow key={c.id}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell className="font-medium">
                      {editingComponentId === c.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editComponentName}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditComponentName(e.target.value)}
                            className="h-7 text-sm"
                            onKeyDown={(e: React.KeyboardEvent) => {
                              if (e.key === 'Enter') handleUpdateComponentName(c.id);
                              if (e.key === 'Escape') setEditingComponentId(null);
                            }}
                            autoFocus
                          />
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => handleUpdateComponentName(c.id)} disabled={savingComponent}>
                            Save
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setEditingComponentId(null)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span>{c.description}</span>
                          <button
                            onClick={() => { setEditingComponentId(c.id); setEditComponentName(c.description); }}
                            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 ml-1"
                            title="Rename component"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.isMultiColor && c.materials?.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {c.materials.map((cm: any) => (
                            <Badge key={cm.id} className="bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200 text-xs">
                              {cm.material?.name || 'Unknown'} ({Math.round(cm.gramsUsed)}g)
                            </Badge>
                          ))}
                        </div>
                      ) : editingMaterialId === c.id ? (
                        <div className="flex items-center gap-1">
                          <select
                            className="h-7 text-sm border rounded px-1 bg-white dark:bg-gray-800 dark:border-gray-600"
                            defaultValue={c.materialId}
                            onChange={(e) => handleUpdateComponentMaterial(c.id, e.target.value)}
                            autoFocus
                            onBlur={() => setEditingMaterialId(null)}
                          >
                            {materials.map((m: any) => (
                              <option key={m.id} value={m.id}>{m.name} ({m.type}{m.color ? ' - ' + m.color : ''})</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <span
                          onClick={() => setEditingMaterialId(c.id)}
                          title="Click to change material"
                          className="cursor-pointer"
                        >
                          <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600">
                            {c.material?.name || 'Unknown'}
                          </Badge>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{c.gramsUsed}g</TableCell>
                    <TableCell className="font-mono">{c.printMinutes}min</TableCell>
                    <TableCell>{c.quantity}</TableCell>
                    <TableCell>
                      {c.isMultiColor && c.materials?.length > 0 ? (
                        <div className="space-y-0.5">
                          {c.materials.map((cm: any) => (
                            <div key={cm.id} className="flex items-center gap-1">
                              {cm.hasEnoughStock ? (
                                <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                              ) : (
                                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                              )}
                              <span className={`text-xs font-mono ${cm.hasEnoughStock ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                                {cm.totalStock}g / {Math.round(cm.gramsNeeded)}g
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : c.totalStock != null ? (
                        <div className="flex items-center gap-1">
                          {c.hasEnoughStock ? (
                            <CheckCircle className="h-4 w-4 text-green-500" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                          )}
                          <span className={`text-xs font-mono ${c.hasEnoughStock ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {c.totalStock}g / {Math.round(c.gramsNeeded)}g
                          </span>
                        </div>
                      ) : '-'}
                    </TableCell>
                    <TableCell>
                      <input
                        type="number"
                        min="0"
                        className="w-16 h-7 text-sm text-center border rounded bg-white dark:bg-gray-800 dark:border-gray-600 font-mono"
                        defaultValue={c.stockOnHand || 0}
                        onBlur={async (e) => {
                          const val = parseInt(e.target.value) || 0;
                          if (val === (c.stockOnHand || 0)) return;
                          try {
                            await api.patch(`/products/${id}/components/${c.id}`, { stockOnHand: val });
                            load();
                          } catch (err: unknown) { toast('error', (err as Error).message); }
                        }}
                        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <button onClick={() => setShowDeleteComponent(c.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Slicer File Onboarding */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Import from Slicer</CardTitle>
          <div className="flex gap-2">
            <label className="cursor-pointer">
              <input type="file" accept=".3mf" className="hidden" onChange={handle3MfSelect} disabled={analyzingThreeMf || uploadingGcode} />
              <span className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 cursor-pointer disabled:opacity-50 transition-colors duration-150">
                <FileCode className="h-4 w-4" /> {analyzingThreeMf ? 'Reading...' : 'Import 3MF (OrcaSlicer)'}
              </span>
            </label>
            <label className="cursor-pointer">
              <input type="file" accept=".gcode,.gco,.g" multiple className="hidden" onChange={handleGcodeUpload} disabled={uploadingGcode || analyzingThreeMf} />
              <span className="inline-flex items-center gap-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer transition-colors duration-150">
                <Upload className="h-4 w-4" /> {uploadingGcode ? 'Processing...' : 'Upload G-code'}
              </span>
            </label>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Import a <strong>.3mf</strong> project file from OrcaSlicer to auto-create components per plate — with thumbnails, weight, and print time. Or upload individual <strong>.gcode</strong> files directly.
          </p>
        </CardContent>
      </Card>

      {/* Product Images */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Product Images</CardTitle>
          <label className="cursor-pointer">
            <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageUpload} disabled={uploadingImages} />
            <span className="inline-flex items-center gap-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer">
              <ImageIcon className="h-4 w-4" /> {uploadingImages ? 'Uploading...' : 'Add Images'}
            </span>
          </label>
        </CardHeader>
        <CardContent>
          {images.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">No images yet.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {images.map((img: any) => (
                <div key={img.id} className="relative group">
                  <NextImage
                    src={`/api/attachments/${img.id}/file`}
                    alt={img.fileName}
                    width={200}
                    height={128}
                    loading="lazy"
                    className="w-full h-32 object-cover rounded-md border dark:border-gray-700"
                    unoptimized
                  />
                  <button
                    onClick={() => setShowDeleteImage(img.id)}
                    className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{img.fileName}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Variants */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Variants</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Same product, different sizes or colours — each gets its own SKU</p>
          </div>
          <Button size="sm" onClick={() => setShowAddVariant(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add Variant
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {(!product.variants || product.variants.length === 0) ? (
            <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 flex flex-col items-center gap-2">
              <Tag className="h-5 w-5" />
              No variants yet. Add a variant to offer this product in different sizes or colours.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Minutes</TableHead>
                  <TableHead>Grams</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead title="Set Est. Grams + Est. Minutes, then click Calculate to auto-price">Auto-price</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.variants.map((v: any) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {v.basePrice != null ? formatCurrency(v.basePrice) : <span className="text-gray-400 italic">inherited</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {v.estimatedMinutes != null ? `${v.estimatedMinutes}min` : <span className="text-gray-400 italic">inherited</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {v.estimatedGrams != null ? `${v.estimatedGrams}g` : <span className="text-gray-400 italic">inherited</span>}
                    </TableCell>
                    <TableCell>
                      <Badge className={v.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}>
                        {v.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {v.estimatedGrams != null && v.estimatedMinutes != null ? (
                        <button
                          onClick={() => handleCalculateVariant(v.id)}
                          disabled={calculatingVariant === v.id}
                          title="Calculate price from grams + minutes"
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-900/20 dark:text-brand-400 dark:hover:bg-brand-900/40 disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3 w-3 ${calculatingVariant === v.id ? 'animate-spin' : ''}`} />
                          {calculatingVariant === v.id ? 'Calculating…' : 'Calculate'}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400 italic" title="Set Est. Grams and Est. Minutes to enable auto-pricing">needs grams+min</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <label title="Upload gcode to auto-set grams, minutes and price" className={`cursor-pointer text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 ${uploadingVariantGcode === v.id ? 'opacity-50 pointer-events-none' : ''}`}>
                          <input
                            type="file"
                            accept=".gcode,.gco,.g"
                            className="hidden"
                            onChange={(e) => handleVariantGcodeUpload(v.id, e)}
                            disabled={uploadingVariantGcode === v.id}
                          />
                          {uploadingVariantGcode === v.id
                            ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            : <Upload className="h-3.5 w-3.5" />}
                        </label>
                        <button onClick={() => setShowEditVariant(v)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" title="Edit">
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setShowDeleteVariant(v.id)} className="text-red-400 hover:text-red-600" title="Delete">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Variant dialog */}
      <Dialog open={showAddVariant} onClose={() => setShowAddVariant(false)} title="Add Variant">
        <form onSubmit={handleAddVariant} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input name="name" label="Variant Name" placeholder="e.g. Large — Red" required />
            <Input name="sku" label="SKU" placeholder="e.g. PROD-L-RED" required />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Set Est. Grams and Est. Minutes for this size — then use the <strong>Calculate</strong> button in the table to auto-price it. Leave price blank until you calculate.</p>
          <div className="grid grid-cols-3 gap-4">
            <Input name="basePrice" label="Price (OMR)" type="number" step="0.001" min="0" placeholder={product.basePrice ? product.basePrice.toFixed(3) : ''} />
            <Input name="estimatedMinutes" label="Est. Minutes" type="number" step="1" min="0" placeholder={product.estimatedMinutes ? String(Math.round(product.estimatedMinutes)) : ''} />
            <Input name="estimatedGrams" label="Est. Grams" type="number" step="0.1" min="0" placeholder={product.estimatedGrams ? String(Math.round(product.estimatedGrams)) : ''} />
          </div>
          <Select name="isActive" label="Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} defaultValue="true" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddVariant(false)}>Cancel</Button>
            <Button type="submit" disabled={savingVariant}>{savingVariant ? 'Saving...' : 'Add Variant'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Edit Variant dialog */}
      <Dialog open={!!showEditVariant} onClose={() => setShowEditVariant(null)} title="Edit Variant">
        {showEditVariant && (
          <form onSubmit={handleUpdateVariant} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input name="name" label="Variant Name" defaultValue={showEditVariant.name} required />
              <Input name="sku" label="SKU" defaultValue={showEditVariant.sku} required />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Set Est. Grams and Est. Minutes for this size — then use the <strong>Calculate</strong> button in the table to auto-price it. Leave price blank until you calculate.</p>
            <div className="grid grid-cols-3 gap-4">
              <Input name="basePrice" label="Price (OMR)" type="number" step="0.001" min="0" defaultValue={showEditVariant.basePrice ?? ''} placeholder={product.basePrice ? product.basePrice.toFixed(3) : ''} />
              <Input name="estimatedMinutes" label="Est. Minutes" type="number" step="1" min="0" defaultValue={showEditVariant.estimatedMinutes ?? ''} placeholder={product.estimatedMinutes ? String(Math.round(product.estimatedMinutes)) : ''} />
              <Input name="estimatedGrams" label="Est. Grams" type="number" step="0.1" min="0" defaultValue={showEditVariant.estimatedGrams ?? ''} placeholder={product.estimatedGrams ? String(Math.round(product.estimatedGrams)) : ''} />
            </div>
            <Select name="isActive" label="Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} defaultValue={showEditVariant.isActive ? 'true' : 'false'} />
            <div className="flex gap-3 justify-end">
              <Button type="button" variant="outline" onClick={() => setShowEditVariant(null)}>Cancel</Button>
              <Button type="submit" disabled={savingVariant}>{savingVariant ? 'Saving...' : 'Save Changes'}</Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Delete Variant dialog */}
      <Dialog open={!!showDeleteVariant} onClose={() => setShowDeleteVariant(null)} title="Delete Variant">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">Are you sure you want to delete this variant? This cannot be undone.</p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeleteVariant(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteVariant} disabled={deletingVariant}>
              {deletingVariant ? 'Deleting...' : 'Delete Variant'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={showAddComponent} onClose={() => setShowAddComponent(false)} title="Add Component">
        <form onSubmit={handleAddComponent} className="space-y-4">
          <Input name="description" label="Description" placeholder="e.g. Main body" required />
          <Select name="materialId" label="Material" options={materialOptions} required />
          <div className="grid grid-cols-3 gap-4">
            <Input name="gramsUsed" label="Grams Used" type="number" step="0.1" required />
            <Input name="printMinutes" label="Print Minutes" type="number" step="1" defaultValue="0" />
            <Input name="quantity" label="Quantity" type="number" defaultValue="1" />
          </div>
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddComponent(false)}>Cancel</Button>
            <Button type="submit" disabled={adding}>{adding ? 'Adding...' : 'Add Component'}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={showEditProduct} onClose={() => setShowEditProduct(false)} title="Edit Product">
        <form onSubmit={handleUpdateProduct} className="space-y-4">
          <Input name="name" label="Name" defaultValue={product.name} required />
          <Input name="description" label="Description" defaultValue={product.description || ''} />
          <div className="grid grid-cols-2 gap-4">
            <Input name="sku" label="SKU" defaultValue={product.sku || ''} />
            <Input name="colorChanges" label="Color Changes" type="number" defaultValue={product.colorChanges || 0} />
          </div>
          <Select
            name="defaultPrinterId"
            label="Default Printer"
            options={[{ value: '', label: 'None' }, ...printers.map((p) => ({ value: p.id, label: p.name }))]}
            defaultValue={product.defaultPrinterId || ''}
          />
          <Select name="isActive" label="Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} defaultValue={product.isActive ? 'true' : 'false'} />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowEditProduct(false)}>Cancel</Button>
            <Button type="submit">Save Changes</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={showDeleteProduct} onClose={() => setShowDeleteProduct(false)} title="Delete Product">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to delete this product and all its components? This action cannot be undone.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeleteProduct(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteProduct} disabled={deletingProduct}>
              {deletingProduct ? 'Deleting...' : 'Delete Product'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!showDeleteComponent} onClose={() => setShowDeleteComponent(null)} title="Remove Component">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Remove this component from the product?
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeleteComponent(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => showDeleteComponent && handleDeleteComponent(showDeleteComponent)} disabled={!!deletingComponent}>
              {deletingComponent ? 'Removing...' : 'Remove Component'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={!!showDeleteImage} onClose={() => setShowDeleteImage(null)} title="Delete Image">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Permanently remove this image?
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDeleteImage(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => showDeleteImage && handleDeleteImage(showDeleteImage)} disabled={!!deletingImage}>
              {deletingImage ? 'Deleting...' : 'Delete Image'}
            </Button>
          </div>
        </div>
      </Dialog>
      <ThreeMfImportWizard
        open={showThreeMfWizard}
        onClose={() => { setShowThreeMfWizard(false); setThreeMfFile(null); setThreeMfAnalysis(null); }}
        analysis={threeMfAnalysis}
        file={threeMfFile}
        productId={id as string}
        onSuccess={() => { setShowThreeMfWizard(false); setThreeMfFile(null); setThreeMfAnalysis(null); load(); }}
      />
    </div>
  );
}
