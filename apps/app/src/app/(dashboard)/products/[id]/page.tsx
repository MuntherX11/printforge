'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, Calculator, Trash2, Edit2, Upload, Image as ImageIcon, X } from 'lucide-react';

export default function ProductDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [product, setProduct] = useState<any>(null);
  const [materials, setMaterials] = useState<any[]>([]);
  const [images, setImages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddComponent, setShowAddComponent] = useState(false);
  const [showEditProduct, setShowEditProduct] = useState(false);
  const [adding, setAdding] = useState(false);
  const [costResult, setCostResult] = useState<any>(null);
  const [calculating, setCalculating] = useState(false);
  const [uploadingGcode, setUploadingGcode] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);

  const load = () => {
    Promise.all([
      api.get(`/products/${id}`),
      api.get<any[]>('/materials'),
      api.get<any[]>(`/attachments?entityType=product&entityId=${id}`).catch(() => []),
    ]).then(([p, m, imgs]) => {
      setProduct(p);
      setMaterials(m);
      setImages(imgs);
    }).catch(console.error).finally(() => setLoading(false));
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
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDeleteComponent(componentId: string) {
    if (!confirm('Remove this component?')) return;
    try {
      await api.delete(`/products/components/${componentId}`);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleCalculateCost() {
    setCalculating(true);
    setCostResult(null);
    try {
      const result = await api.post(`/products/${id}/calculate`);
      setCostResult(result);
    } catch (err: any) {
      alert(err.message);
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
        isActive: form.get('isActive') === 'true',
      });
      setShowEditProduct(false);
      load();
    } catch (err: any) {
      alert(err.message);
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
      if (!res.ok) throw new Error('Upload failed');
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUploadingGcode(false);
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
    } catch (err: any) {
      alert(err.message);
    } finally {
      setUploadingImages(false);
      e.target.value = '';
    }
  }

  async function handleDeleteImage(attachmentId: string) {
    if (!confirm('Remove this image?')) return;
    try {
      await api.delete(`/products/${id}/images/${attachmentId}`);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (loading) return <Loading />;
  if (!product) return <div className="text-center py-12 text-gray-500 dark:text-gray-400">Product not found</div>;

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
          <Button variant="outline" onClick={() => setShowEditProduct(true)}>
            <Edit2 className="h-4 w-4 mr-2" /> Edit
          </Button>
          <Button onClick={handleCalculateCost} disabled={calculating}>
            <Calculator className="h-4 w-4 mr-2" /> {calculating ? 'Calculating...' : 'Calculate Cost'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Components</p><p className="text-lg font-bold">{product.components?.length || 0}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Est. Grams</p><p className="text-lg font-bold">{Math.round(product.estimatedGrams)}g</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Est. Minutes</p><p className="text-lg font-bold">{Math.round(product.estimatedMinutes)}min</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Base Price</p><p className="text-lg font-bold">{formatCurrency(product.basePrice)}</p></CardContent></Card>
      </div>

      {costResult && (
        <Card className="border-brand-200 bg-brand-50">
          <CardHeader><CardTitle>Cost Breakdown</CardTitle></CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-4 mb-4">
              <div><p className="text-xs text-gray-500">Material Cost</p><p className="text-lg font-bold">{formatCurrency(costResult.materialCost)}</p></div>
              <div><p className="text-xs text-gray-500">Machine Cost</p><p className="text-lg font-bold">{formatCurrency(costResult.machineCost)}</p></div>
              <div><p className="text-xs text-gray-500">Electricity</p><p className="text-lg font-bold">{formatCurrency(costResult.electricityCost || 0)}</p></div>
              <div><p className="text-xs text-gray-500">Waste + Overhead</p><p className="text-lg font-bold">{formatCurrency(costResult.wasteCost + costResult.overheadCost)}</p></div>
            </div>
            <div className="grid gap-4 md:grid-cols-3 border-t pt-4">
              <div><p className="text-xs text-gray-500">Total Cost</p><p className="text-xl font-bold">{formatCurrency(costResult.totalCost)}</p></div>
              <div><p className="text-xs text-gray-500">Suggested Price</p><p className="text-xl font-bold text-brand-600">{formatCurrency(costResult.suggestedPrice)}</p></div>
              <div><p className="text-xs text-gray-500">Markup</p><p className="text-xl font-bold text-green-600">{costResult.markupMultiplier}x</p></div>
            </div>
            {costResult.components?.length > 0 && (
              <div className="mt-4 border-t pt-4">
                <p className="text-sm font-medium mb-2">Per-Component Costs</p>
                {costResult.components.map((c: any, i: number) => (
                  <div key={i} className="flex justify-between text-sm py-1">
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
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.components
                  .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
                  .map((c: any, i: number) => (
                  <TableRow key={c.id}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell className="font-medium">{c.description}</TableCell>
                    <TableCell>
                      <Badge className="bg-gray-100 text-gray-700">
                        {c.material?.name || 'Unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono">{c.gramsUsed}g</TableCell>
                    <TableCell className="font-mono">{c.printMinutes}min</TableCell>
                    <TableCell>{c.quantity}</TableCell>
                    <TableCell>
                      <button onClick={() => handleDeleteComponent(c.id)} className="text-red-400 hover:text-red-600">
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

      {/* Gcode Onboarding */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Quick Onboard from Gcode</CardTitle>
          <label className="cursor-pointer">
            <input type="file" accept=".gcode,.gco,.g" multiple className="hidden" onChange={handleGcodeUpload} disabled={uploadingGcode} />
            <span className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 cursor-pointer">
              <Upload className="h-4 w-4" /> {uploadingGcode ? 'Processing...' : 'Upload Gcode Files'}
            </span>
          </label>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Upload one or more .gcode files to auto-create components with material, weight, and print time.
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
                  <img
                    src={`/api/attachments/${img.id}/file`}
                    alt={img.fileName}
                    className="w-full h-32 object-cover rounded-md border dark:border-gray-700"
                  />
                  <button
                    onClick={() => handleDeleteImage(img.id)}
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
          <Select name="isActive" label="Status" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} defaultValue={product.isActive ? 'true' : 'false'} />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowEditProduct(false)}>Cancel</Button>
            <Button type="submit">Save Changes</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
