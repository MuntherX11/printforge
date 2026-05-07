'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

interface ThreeMfQuotePanelProps {
  materials: any[];
  printers: any[];
  customers: any[];
  formatCurrency: (amount: number) => string;
}

export function ThreeMfQuotePanel({ materials, printers, formatCurrency }: ThreeMfQuotePanelProps) {
  const [colors, setColors] = useState<Array<{
    colorIndex: number; materialId: string; gramsUsed: string; colorHex: string; colorName: string;
  }>>([
    { colorIndex: 0, materialId: '', gramsUsed: '', colorHex: '#FFFFFF', colorName: 'Color 1' },
  ]);
  const [printMinutes, setPrintMinutes] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [multiResult, setMultiResult] = useState<any>(null);
  const [error, setError] = useState('');

  // ── Derived ───────────────────────────────────────────────────────────────

  const matOptions = materials.map(m => ({
    value: m.id,
    label: `${m.name}${m.color ? ` (${m.color})` : ''}`,
  }));
  const printerOptions = [
    { value: '', label: 'Select printer...' },
    ...printers.map(p => ({ value: p.id, label: p.name })),
  ];

  // ── Handlers ──────────────────────────────────────────────────────────────

  function addColor() {
    setColors(prev => [...prev, {
      colorIndex: prev.length,
      materialId: '',
      gramsUsed: '',
      colorHex: '#000000',
      colorName: `Color ${prev.length + 1}`,
    }]);
  }

  function removeColor(idx: number) {
    setColors(prev => prev.filter((_, i) => i !== idx).map((c, i) => ({ ...c, colorIndex: i })));
  }

  function updateColor(idx: number, field: string, value: string) {
    setColors(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  }

  async function handleMultiColorEstimate() {
    setError('');
    setMultiResult(null);
    const validColors = colors.filter(c => c.materialId && c.gramsUsed);
    if (validColors.length < 2) {
      setError('Add at least 2 colors with material and grams');
      return;
    }
    setAnalyzing(true);
    try {
      const data = await api.post('/costing/estimate-multicolor', {
        colors: validColors.map(c => ({
          colorIndex: c.colorIndex,
          materialId: c.materialId,
          gramsUsed: parseFloat(c.gramsUsed),
          colorHex: c.colorHex,
          colorName: c.colorName,
        })),
        printMinutes: parseFloat(printMinutes) || 0,
        printerId: printerId || undefined,
      });
      setMultiResult(data);
    } catch (err: any) {
      setError(err.message || 'Estimate failed');
    } finally {
      setAnalyzing(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Color Materials</h3>
            <Button variant="outline" size="sm" onClick={addColor}>+ Add Color</Button>
          </div>

          {colors.map((c, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-1">
                <label className="block text-xs text-gray-500 mb-1">Color</label>
                <input
                  type="color"
                  value={c.colorHex}
                  onChange={e => updateColor(idx, 'colorHex', e.target.value)}
                  className="w-full h-9 rounded border cursor-pointer"
                />
              </div>
              <div className="col-span-2">
                <Input label="Name" value={c.colorName} onChange={e => updateColor(idx, 'colorName', e.target.value)} />
              </div>
              <div className="col-span-5">
                <Select
                  label="Material"
                  value={c.materialId}
                  onChange={e => updateColor(idx, 'materialId', e.target.value)}
                  options={[{ value: '', label: 'Select...' }, ...matOptions]}
                />
              </div>
              <div className="col-span-3">
                <Input label="Grams" type="number" step="0.1" value={c.gramsUsed} onChange={e => updateColor(idx, 'gramsUsed', e.target.value)} />
              </div>
              <div className="col-span-1">
                {colors.length > 1 && (
                  <Button variant="outline" size="sm" onClick={() => removeColor(idx)} className="text-red-500 w-full">×</Button>
                )}
              </div>
            </div>
          ))}

          <div className="grid grid-cols-2 gap-4">
            <Input label="Print Minutes" type="number" value={printMinutes} onChange={e => setPrintMinutes(e.target.value)} />
            <Select
              label="Printer"
              name="printerId"
              value={printerId}
              onChange={e => setPrinterId(e.target.value)}
              options={printerOptions}
            />
          </div>

          <Button onClick={handleMultiColorEstimate} disabled={analyzing} className="w-full">
            {analyzing ? 'Calculating...' : 'Calculate Multi-Color Cost'}
          </Button>
        </CardContent>
      </Card>

      {multiResult && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-3">Per-Color Breakdown</h3>
              <div className="space-y-2">
                {multiResult.colorDetails?.map((d: any) => (
                  <div key={d.colorIndex} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{d.colorName}</span>
                      <span className="text-gray-400">({d.materialName})</span>
                    </div>
                    <div className="text-right">
                      <span className="text-gray-500">{d.gramsUsed}g × {d.costPerGram.toFixed(3)}</span>
                      <span className="ml-2 font-medium">{formatCurrency(d.materialCost)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {multiResult.purgeTransitions?.length > 0 && (
                <>
                  <h4 className="font-medium mt-4 mb-2 text-sm text-gray-600">Purge Transitions</h4>
                  <div className="space-y-1">
                    {multiResult.purgeTransitions.map((t: any, i: number) => (
                      <div key={i} className="flex justify-between text-xs text-gray-500">
                        <span>Color {t.fromColorIndex} → {t.toColorIndex}</span>
                        <span>{t.purgeGrams}g = {formatCurrency(t.purgeCost)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-sm mt-2 pt-2 border-t">
                    <span className="text-gray-500">Total Purge</span>
                    <span>{multiResult.totalPurgeGrams}g</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-3">Cost Summary</h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-gray-500">Material</dt><dd>{formatCurrency(multiResult.materialCost)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Machine</dt><dd>{formatCurrency(multiResult.machineCost)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Electricity</dt><dd>{formatCurrency(multiResult.electricityCost || 0)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Purge Waste</dt><dd>{formatCurrency(multiResult.wasteCost)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Overhead</dt><dd>{formatCurrency(multiResult.overheadCost)}</dd></div>
                <div className="flex justify-between border-t pt-2 font-medium"><dt>Total Cost</dt><dd>{formatCurrency(multiResult.totalCost)}</dd></div>
                <div className="flex justify-between text-brand-600 font-semibold text-base"><dt>Suggested Price</dt><dd>{formatCurrency(multiResult.suggestedPrice)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Markup</dt><dd>{multiResult.markupMultiplier}x</dd></div>
              </dl>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
