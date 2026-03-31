'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { Upload, Calculator, FileText, Box } from 'lucide-react';

export default function QuickQuotePage() {
  const [materials, setMaterials] = useState<any[]>([]);
  const [printers, setPrinters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [materialId, setMaterialId] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [colorChanges, setColorChanges] = useState('0');
  const [infill, setInfill] = useState('20');

  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  // Multi-color state
  const [multiMode, setMultiMode] = useState(false);
  const [colors, setColors] = useState<Array<{
    colorIndex: number; materialId: string; gramsUsed: string; colorHex: string; colorName: string;
  }>>([
    { colorIndex: 0, materialId: '', gramsUsed: '', colorHex: '#FFFFFF', colorName: 'Color 1' },
  ]);
  const [printMinutes, setPrintMinutes] = useState('');
  const [multiResult, setMultiResult] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      api.get<any>('/materials').then(r => r.data || r),
      api.get<any[]>('/printers'),
    ]).then(([mats, prts]) => {
      setMaterials(Array.isArray(mats) ? mats : []);
      setPrinters(prts);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  async function handleAnalyze() {
    if (!file) return;
    setAnalyzing(true);
    setError('');
    setResult(null);

    try {
      const params: Record<string, string> = {};
      if (materialId) params.materialId = materialId;
      if (printerId) params.printerId = printerId;
      if (colorChanges !== '0') params.colorChanges = colorChanges;
      if (infill !== '20') params.infill = infill;

      const data = await api.upload('/file-parser/analyze', file, params);
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
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

  if (loading) return <Loading />;

  const matOptions = materials.map(m => ({ value: m.id, label: `${m.name}${m.color ? ` (${m.color})` : ''}` }));
  const printerOptions = [{ value: '', label: 'None' }, ...printers.map(p => ({ value: p.id, label: p.name }))];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Quick Quote</h1>
        <div className="flex gap-2">
          <Button variant={!multiMode ? 'primary' : 'outline'} onClick={() => setMultiMode(false)}>
            <Upload className="h-4 w-4 mr-2" /> File Upload
          </Button>
          <Button variant={multiMode ? 'primary' : 'outline'} onClick={() => setMultiMode(true)}>
            <Calculator className="h-4 w-4 mr-2" /> Multi-Color
          </Button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {!multiMode ? (
        <>
          {/* File upload mode */}
          <Card>
            <CardContent className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Upload G-code or STL File</label>
                <label className="flex items-center justify-center w-full h-32 px-4 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-brand-400 transition-colors">
                  <input
                    type="file"
                    accept=".gcode,.gco,.g,.stl"
                    className="hidden"
                    onChange={e => setFile(e.target.files?.[0] || null)}
                  />
                  <div className="text-center">
                    {file ? (
                      <>
                        <FileText className="h-8 w-8 mx-auto text-brand-500 mb-2" />
                        <p className="text-sm font-medium">{file.name}</p>
                        <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
                      </>
                    ) : (
                      <>
                        <Upload className="h-8 w-8 mx-auto text-gray-400 mb-2" />
                        <p className="text-sm text-gray-500">Click to upload .gcode or .stl</p>
                      </>
                    )}
                  </div>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Material"
                  name="materialId"
                  value={materialId}
                  onChange={e => setMaterialId(e.target.value)}
                  options={[{ value: '', label: 'Select material...' }, ...matOptions]}
                />
                <Select
                  label="Printer"
                  name="printerId"
                  value={printerId}
                  onChange={e => setPrinterId(e.target.value)}
                  options={printerOptions}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Color Changes"
                  type="number"
                  value={colorChanges}
                  onChange={e => setColorChanges(e.target.value)}
                  min="0"
                />
                <Input
                  label="Infill % (STL only)"
                  type="number"
                  value={infill}
                  onChange={e => setInfill(e.target.value)}
                  min="0"
                  max="100"
                />
              </div>

              <Button onClick={handleAnalyze} disabled={!file || analyzing} className="w-full">
                {analyzing ? 'Analyzing...' : 'Analyze & Quote'}
              </Button>
            </CardContent>
          </Card>

          {/* Results */}
          {result && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardContent className="p-6">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    {result.analysis?.type === 'gcode' ? <FileText className="h-5 w-5" /> : <Box className="h-5 w-5" />}
                    File Analysis
                  </h3>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between"><dt className="text-gray-500">File</dt><dd>{result.filename}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Type</dt><dd className="uppercase">{result.analysis?.type}</dd></div>
                    {result.analysis?.slicer && <div className="flex justify-between"><dt className="text-gray-500">Slicer</dt><dd>{result.analysis.slicer}</dd></div>}
                    {result.analysis?.estimatedTimeSeconds && <div className="flex justify-between"><dt className="text-gray-500">Print Time</dt><dd>{Math.round(result.analysis.estimatedTimeSeconds / 60)} min</dd></div>}
                    {result.analysis?.filamentUsedGrams && <div className="flex justify-between"><dt className="text-gray-500">Filament</dt><dd>{result.analysis.filamentUsedGrams.toFixed(1)}g</dd></div>}
                    {result.analysis?.filamentUsedMm && <div className="flex justify-between"><dt className="text-gray-500">Filament (mm)</dt><dd>{result.analysis.filamentUsedMm.toFixed(0)} mm</dd></div>}
                    {result.analysis?.layerHeight && <div className="flex justify-between"><dt className="text-gray-500">Layer Height</dt><dd>{result.analysis.layerHeight} mm</dd></div>}
                    {result.analysis?.filamentType && <div className="flex justify-between"><dt className="text-gray-500">Filament Type</dt><dd>{result.analysis.filamentType}</dd></div>}
                    {result.analysis?.volumeCm3 && <div className="flex justify-between"><dt className="text-gray-500">Volume</dt><dd>{result.analysis.volumeCm3.toFixed(2)} cm³</dd></div>}
                    {result.analysis?.estimatedGrams && <div className="flex justify-between"><dt className="text-gray-500">Est. Weight</dt><dd>{result.analysis.estimatedGrams.toFixed(1)}g</dd></div>}
                    {result.analysis?.estimatedMinutes && <div className="flex justify-between"><dt className="text-gray-500">Est. Time</dt><dd>{result.analysis.estimatedMinutes} min</dd></div>}
                    {result.analysis?.triangleCount && <div className="flex justify-between"><dt className="text-gray-500">Triangles</dt><dd>{result.analysis.triangleCount.toLocaleString()}</dd></div>}
                    {result.analysis?.boundingBox && <div className="flex justify-between"><dt className="text-gray-500">Bounding Box</dt><dd>{result.analysis.boundingBox.x.toFixed(1)} × {result.analysis.boundingBox.y.toFixed(1)} × {result.analysis.boundingBox.z.toFixed(1)} mm</dd></div>}
                  </dl>
                </CardContent>
              </Card>

              {result.costEstimate && (
                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-3">Cost Estimate</h3>
                    <dl className="space-y-2 text-sm">
                      <div className="flex justify-between"><dt className="text-gray-500">Material</dt><dd>{result.costEstimate.materialCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Machine</dt><dd>{result.costEstimate.machineCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Electricity</dt><dd>{(result.costEstimate.electricityCost || 0).toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Waste</dt><dd>{result.costEstimate.wasteCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Overhead</dt><dd>{result.costEstimate.overheadCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between border-t pt-2 font-medium"><dt>Total Cost</dt><dd>{result.costEstimate.totalCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between text-brand-600 font-semibold text-base"><dt>Suggested Price</dt><dd>{result.costEstimate.suggestedPrice.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Markup</dt><dd>{result.costEstimate.markupMultiplier}x</dd></div>
                    </dl>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Multi-color mode */}
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
                    <Input
                      label="Name"
                      value={c.colorName}
                      onChange={e => updateColor(idx, 'colorName', e.target.value)}
                    />
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
                    <Input
                      label="Grams"
                      type="number"
                      step="0.1"
                      value={c.gramsUsed}
                      onChange={e => updateColor(idx, 'gramsUsed', e.target.value)}
                    />
                  </div>
                  <div className="col-span-1">
                    {colors.length > 1 && (
                      <Button variant="outline" size="sm" onClick={() => removeColor(idx)} className="text-red-500 w-full">
                        ×
                      </Button>
                    )}
                  </div>
                </div>
              ))}

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Print Minutes"
                  type="number"
                  value={printMinutes}
                  onChange={e => setPrintMinutes(e.target.value)}
                />
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
                          <span className="ml-2 font-medium">{d.materialCost.toFixed(3)} OMR</span>
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
                            <span>{t.purgeGrams}g = {t.purgeCost.toFixed(3)} OMR</span>
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
                    <div className="flex justify-between"><dt className="text-gray-500">Material</dt><dd>{multiResult.materialCost.toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Machine</dt><dd>{multiResult.machineCost.toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Electricity</dt><dd>{(multiResult.electricityCost || 0).toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Purge Waste</dt><dd>{multiResult.wasteCost.toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Overhead</dt><dd>{multiResult.overheadCost.toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between border-t pt-2 font-medium"><dt>Total Cost</dt><dd>{multiResult.totalCost.toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between text-brand-600 font-semibold text-base"><dt>Suggested Price</dt><dd>{multiResult.suggestedPrice.toFixed(3)} OMR</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Markup</dt><dd>{multiResult.markupMultiplier}x</dd></div>
                  </dl>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
