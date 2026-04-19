'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { useEffect } from 'react';
import { Calculator } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function EstimatePage() {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [materials, setMaterials] = useState<any[]>([]);
  const [printers, setPrinters] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<any[]>('/materials').then(setMaterials),
      api.get<any[]>('/printers').then(setPrinters),
    ]).catch(console.error);
  }, []);

  async function handleEstimate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    const form = new FormData(e.currentTarget);

    try {
      const estimate = await api.post('/costing/estimate', {
        gramsUsed: parseFloat(form.get('gramsUsed') as string),
        printMinutes: parseFloat(form.get('printMinutes') as string),
        materialId: form.get('materialId'),
        printerId: form.get('printerId') || undefined,
        colorChanges: parseInt(form.get('colorChanges') as string) || 0,
      });
      setResult(estimate);
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Quick Cost Estimate</h1>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleEstimate} className="space-y-4">
            <Select
              name="materialId"
              label="Material"
              options={[{ value: '', label: 'Select material...' }, ...materials.map(m => ({ value: m.id, label: m.name }))]}
              required
            />
            <Select
              name="printerId"
              label="Printer (optional)"
              options={[{ value: '', label: 'Default rate' }, ...printers.map(p => ({ value: p.id, label: `${p.name} (${formatCurrency(p.hourlyRate)}/hr)` }))]}
            />
            <div className="grid grid-cols-3 gap-4">
              <Input name="gramsUsed" label="Filament (grams)" type="number" step="0.1" required />
              <Input name="printMinutes" label="Print Time (min)" type="number" step="1" required />
              <Input name="colorChanges" label="Color Changes" type="number" defaultValue="0" min="0" />
            </div>
            <Button type="submit" disabled={loading} className="w-full">
              <Calculator className="h-4 w-4 mr-2" />
              {loading ? 'Calculating...' : 'Calculate Estimate'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader><CardTitle>Cost Breakdown</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Material Cost</span>
                <span className="font-medium">{formatCurrency(result.materialCost)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Machine Cost</span>
                <span className="font-medium">{formatCurrency(result.machineCost)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Waste Cost</span>
                <span className="font-medium">{formatCurrency(result.wasteCost)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Overhead</span>
                <span className="font-medium">{formatCurrency(result.overheadCost)}</span>
              </div>
              <div className="flex justify-between text-sm border-t pt-2">
                <span className="font-medium">Total Cost</span>
                <span className="font-bold">{formatCurrency(result.totalCost)}</span>
              </div>
              <div className="flex justify-between text-sm border-t pt-2">
                <span className="font-medium">Suggested Price ({result.markupMultiplier}x markup)</span>
                <span className="font-bold text-lg text-brand-600">{formatCurrency(result.suggestedPrice)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
