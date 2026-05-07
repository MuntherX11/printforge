'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Upload, FileText, Box, Save, FileCode2, Layers } from 'lucide-react';
import PlatePreviewCard from '../products/[id]/PlatePreviewCard';

interface FileQuotePanelProps {
  materials: any[];
  printers: any[];
  customers: any[];
  formatCurrency: (amount: number) => string;
}

export function FileQuotePanel({ materials, printers, customers, formatCurrency }: FileQuotePanelProps) {
  const { toast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [materialId, setMaterialId] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [colorChanges, setColorChanges] = useState('0');
  const [infill, setInfill] = useState('20');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [saveCustomerId, setSaveCustomerId] = useState('');
  const [saving, setSaving] = useState(false);

  // 3MF state
  const [threeMfAnalysis, setThreeMfAnalysis] = useState<any>(null);
  const [threeMfLoading, setThreeMfLoading] = useState(false);
  const [threeMfSelected, setThreeMfSelected] = useState<Set<number>>(new Set());
  const [threeMfPlateNames, setThreeMfPlateNames] = useState<Record<string, string>>({});
  const [threeMfResult, setThreeMfResult] = useState<any>(null);
  const [threeMfEstimating, setThreeMfEstimating] = useState(false);

  // ── Derived ───────────────────────────────────────────────────────────────

  const matOptions = materials.map(m => ({
    value: m.id,
    label: `${m.name}${m.color ? ` (${m.color})` : ''}`,
  }));
  const printerOptions = [
    { value: '', label: 'Select printer...' },
    ...printers.map(p => ({ value: p.id, label: p.name })),
  ];
  const is3mfFile = file?.name.toLowerCase().endsWith('.3mf') ?? false;

  // ── Handlers ──────────────────────────────────────────────────────────────

  function resetFileState() {
    setResult(null);
    setError('');
    setThreeMfAnalysis(null);
    setThreeMfResult(null);
    setThreeMfSelected(new Set());
    setThreeMfPlateNames({});
  }

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
      if (data?.analysis?.totalFilamentChanges != null) {
        setColorChanges(String(data.analysis.totalFilamentChanges));
      }
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleAnalyze3mf(f: File) {
    setThreeMfLoading(true);
    setThreeMfAnalysis(null);
    setThreeMfResult(null);
    setError('');
    try {
      const data = await api.upload('/file-parser/analyze', f, {});
      if (data?.analysis?.type === '3mf') {
        setThreeMfAnalysis(data.analysis);
        const allIndices = new Set<number>(
          (data.analysis.plates as any[]).map((p: any) => p.plateIndex as number),
        );
        setThreeMfSelected(allIndices);
        const names: Record<string, string> = {};
        for (const plate of data.analysis.plates as any[]) {
          names[String(plate.plateIndex)] = plate.name;
        }
        setThreeMfPlateNames(names);
      } else {
        setError('Unexpected response from 3MF parser');
      }
    } catch (err: any) {
      setError(err.message || '3MF analysis failed');
    } finally {
      setThreeMfLoading(false);
    }
  }

  async function handleEstimatePlates() {
    if (!threeMfAnalysis || threeMfSelected.size === 0 || !materialId) return;
    setThreeMfEstimating(true);
    setThreeMfResult(null);
    setError('');
    try {
      const selectedPlates = (threeMfAnalysis.plates as any[])
        .filter((p: any) => threeMfSelected.has(p.plateIndex))
        .map((p: any) => ({
          plateIndex: p.plateIndex,
          name: threeMfPlateNames[String(p.plateIndex)] || p.name,
          printSeconds: p.printSeconds,
          weightGrams: p.weightGrams,
          toolChanges: p.toolChanges,
          tools: p.tools,
        }));
      const data = await api.post('/costing/estimate-plates', {
        plates: selectedPlates,
        defaultMaterialId: materialId,
        printerId: printerId || undefined,
      });
      setThreeMfResult(data);
    } catch (err: any) {
      setError(err.message || 'Plate estimation failed');
    } finally {
      setThreeMfEstimating(false);
    }
  }

  async function handleSaveQuote() {
    if (!result?.costEstimate || !saveCustomerId) {
      toast('error', 'Select a customer and ensure cost estimate is available');
      return;
    }
    setSaving(true);
    try {
      await api.post('/quotes/from-analysis', {
        customerId: saveCustomerId,
        description: result.filename || 'Quick Quote',
        analysis: result.analysis,
        costEstimate: result.costEstimate,
        source: 'QUICK_QUOTE',
      });
      toast('success', 'Quote saved successfully');
    } catch (err: any) {
      toast('error', err.message || 'Failed to save quote');
    } finally {
      setSaving(false);
    }
  }

  async function handleSave3mfQuote() {
    if (!threeMfResult || !saveCustomerId) {
      toast('error', 'Select a customer first');
      return;
    }
    setSaving(true);
    try {
      const fileName = file?.name ?? 'project.3mf';
      const items = (threeMfResult.plates as any[]).map((p: any) => ({
        description: `${fileName} — ${p.name}`,
        quantity: 1,
        unitPrice: p.breakdown.suggestedPrice,
        estimatedGrams: Math.round(p.weightGrams),
        estimatedMinutes: Math.round(p.printSeconds / 60),
      }));
      await api.post('/quotes', {
        customerId: saveCustomerId,
        items,
        notes: `3MF import from ${fileName} — ${threeMfResult.plates.length} plate(s)`,
      });
      toast('success', 'Quote saved');
    } catch (err: any) {
      toast('error', err.message || 'Failed to save quote');
    } finally {
      setSaving(false);
    }
  }

  function togglePlate(plateIndex: number) {
    setThreeMfSelected(prev => {
      const next = new Set(prev);
      if (next.has(plateIndex)) next.delete(plateIndex);
      else next.add(plateIndex);
      return next;
    });
  }

  function updatePlateName(plateIndex: number, name: string) {
    setThreeMfPlateNames(prev => ({ ...prev, [String(plateIndex)]: name }));
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {/* Upload zone */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Upload G-code, STL, or 3MF File
            </label>
            <label className="flex items-center justify-center w-full h-32 px-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer hover:border-brand-400 dark:hover:border-brand-500 transition-colors">
              <input
                type="file"
                accept=".gcode,.gco,.g,.stl,.3mf"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0] || null;
                  setFile(f);
                  resetFileState();
                  if (f?.name.toLowerCase().endsWith('.3mf')) {
                    handleAnalyze3mf(f);
                  }
                }}
              />
              <div className="text-center">
                {file ? (
                  <>
                    {is3mfFile
                      ? <FileCode2 className="h-8 w-8 mx-auto text-brand-500 mb-2" />
                      : <FileText className="h-8 w-8 mx-auto text-brand-500 mb-2" />
                    }
                    <p className="text-sm font-medium dark:text-gray-200">{file.name}</p>
                    <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</p>
                  </>
                ) : (
                  <>
                    <Upload className="h-8 w-8 mx-auto text-gray-400 mb-2" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Click to upload .gcode, .stl, or .3mf
                    </p>
                  </>
                )}
              </div>
            </label>
          </div>

          {/* Non-3MF options: material, printer, analyze button */}
          {!is3mfFile && (
            <>
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
                {file?.name?.toLowerCase().endsWith('.stl') && (
                  <Input
                    label="Infill % (STL only)"
                    type="number"
                    value={infill}
                    onChange={e => setInfill(e.target.value)}
                    min="0"
                    max="100"
                  />
                )}
              </div>

              <Button
                onClick={handleAnalyze}
                disabled={!file || analyzing || !materialId || !printerId}
                className="w-full"
              >
                {analyzing ? 'Analyzing...' : 'Analyze & Quote'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* 3MF: parsing spinner */}
      {is3mfFile && threeMfLoading && (
        <div className="flex items-center justify-center py-8 gap-3 text-gray-500 dark:text-gray-400">
          <svg className="animate-spin h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm">Parsing 3MF file…</span>
        </div>
      )}

      {/* 3MF: plate selection + estimate */}
      {is3mfFile && threeMfAnalysis && !threeMfLoading && (
        <Card>
          <CardContent className="p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-brand-500" />
                <h3 className="font-semibold dark:text-gray-100">
                  {threeMfAnalysis.totalPlates} Plate
                  {threeMfAnalysis.totalPlates !== 1 ? 's' : ''} detected
                </h3>
                {threeMfAnalysis.slicer && (
                  <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded">
                    {threeMfAnalysis.slicer}
                  </span>
                )}
              </div>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {threeMfSelected.size} selected
              </span>
            </div>

            {/* Material + printer selectors */}
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Default Material"
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

            <p className="text-xs text-gray-400 dark:text-gray-500 -mt-2">
              For multicolor plates, material cost is resolved per tool type from your inventory.
              The default material is used as fallback.
            </p>

            {/* Plate grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {(threeMfAnalysis.plates as any[]).map((plate: any) => (
                <PlatePreviewCard
                  key={plate.plateIndex}
                  plate={plate}
                  selected={threeMfSelected.has(plate.plateIndex)}
                  name={threeMfPlateNames[String(plate.plateIndex)] || plate.name}
                  onToggle={togglePlate}
                  onNameChange={updatePlateName}
                />
              ))}
            </div>

            <Button
              onClick={handleEstimatePlates}
              disabled={threeMfSelected.size === 0 || !materialId || threeMfEstimating}
              className="w-full"
            >
              {threeMfEstimating
                ? 'Estimating…'
                : `Estimate ${threeMfSelected.size} Plate${threeMfSelected.size !== 1 ? 's' : ''}`}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Normal gcode/stl results */}
      {result && !is3mfFile && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent className="p-6">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                {result.analysis?.type === 'gcode'
                  ? <FileText className="h-5 w-5" />
                  : <Box className="h-5 w-5" />}
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
                {result.analysis?.boundingBox && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Bounding Box</dt>
                    <dd>
                      {result.analysis.boundingBox.x.toFixed(1)} ×{' '}
                      {result.analysis.boundingBox.y.toFixed(1)} ×{' '}
                      {result.analysis.boundingBox.z.toFixed(1)} mm
                    </dd>
                  </div>
                )}
                {result.analysis?.totalFilamentChanges != null && (
                  <div className="flex justify-between"><dt className="text-gray-500">Tool Changes</dt><dd>{result.analysis.totalFilamentChanges}</dd></div>
                )}
                {result.analysis?.toolCount != null && result.analysis.toolCount > 1 && (
                  <div className="flex justify-between"><dt className="text-gray-500">Tools Used</dt><dd>{result.analysis.toolCount}</dd></div>
                )}
              </dl>
              {result.analysis?.tools?.length > 1 && (
                <div className="mt-4 pt-3 border-t">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Per-Tool Breakdown</h4>
                  <div className="space-y-1">
                    {result.analysis.tools.map((t: any) => (
                      <div key={t.index} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          {t.colorHex && (
                            <span className="w-4 h-4 rounded-full border" style={{ backgroundColor: t.colorHex }} />
                          )}
                          <span className="text-gray-600">T{t.index}</span>
                          {t.materialType && <span className="text-gray-400 text-xs">({t.materialType})</span>}
                        </div>
                        <span className="text-gray-700">{t.filamentGrams?.toFixed(1) || '?'}g</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {result.costEstimate && (
            <Card>
              <CardContent className="p-6">
                <h3 className="font-semibold mb-3">Cost Estimate</h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between"><dt className="text-gray-500">Material</dt><dd>{formatCurrency(result.costEstimate.materialCost)}</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">Machine</dt><dd>{formatCurrency(result.costEstimate.machineCost)}</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">Electricity</dt><dd>{formatCurrency(result.costEstimate.electricityCost || 0)}</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">Waste</dt><dd>{formatCurrency(result.costEstimate.wasteCost)}</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">Overhead</dt><dd>{formatCurrency(result.costEstimate.overheadCost)}</dd></div>
                  <div className="flex justify-between border-t pt-2 font-medium"><dt>Total Cost</dt><dd>{formatCurrency(result.costEstimate.totalCost)}</dd></div>
                  <div className="flex justify-between text-brand-600 font-semibold text-base"><dt>Suggested Price</dt><dd>{formatCurrency(result.costEstimate.suggestedPrice)}</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">Markup</dt><dd>{result.costEstimate.markupMultiplier}x</dd></div>
                </dl>

                <div className="mt-4 pt-4 border-t space-y-3">
                  <h4 className="text-sm font-medium text-gray-700">Save as Quote</h4>
                  <Select
                    label="Customer"
                    value={saveCustomerId}
                    onChange={e => setSaveCustomerId(e.target.value)}
                    options={[{ value: '', label: 'Select customer...' }, ...customers.map(c => ({ value: c.id, label: c.name }))]}
                  />
                  <Button onClick={handleSaveQuote} disabled={saving || !saveCustomerId} className="w-full" variant="secondary">
                    <Save className="h-4 w-4 mr-2" />
                    {saving ? 'Saving...' : 'Save Quote'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* 3MF results: per-plate cards + grand total */}
      {threeMfResult && is3mfFile && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {(threeMfResult.plates as any[]).map((plate: any) => (
              <Card key={plate.plateIndex}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-sm dark:text-gray-100 truncate">{plate.name}</h4>
                    {plate.isMultiColor && (
                      <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded ml-2 shrink-0">
                        Multi-color
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500 mb-3">
                    {Math.round(plate.printSeconds / 60)} min · {Math.round(plate.weightGrams)}g
                  </div>
                  <dl className="space-y-1 text-xs">
                    <div className="flex justify-between"><dt className="text-gray-500">Material</dt><dd>{formatCurrency(plate.breakdown.materialCost)}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Machine</dt><dd>{formatCurrency(plate.breakdown.machineCost)}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">Electricity</dt><dd>{formatCurrency(plate.breakdown.electricityCost || 0)}</dd></div>
                    {plate.breakdown.wasteCost > 0 && (
                      <div className="flex justify-between"><dt className="text-gray-500">Waste</dt><dd>{formatCurrency(plate.breakdown.wasteCost)}</dd></div>
                    )}
                    <div className="flex justify-between"><dt className="text-gray-500">Overhead</dt><dd>{formatCurrency(plate.breakdown.overheadCost)}</dd></div>
                    <div className="flex justify-between border-t dark:border-gray-700 pt-1 mt-1 font-medium text-sm">
                      <dt className="dark:text-gray-200">Cost</dt>
                      <dd>{formatCurrency(plate.breakdown.totalCost)}</dd>
                    </div>
                    <div className="flex justify-between text-brand-600 dark:text-brand-400 font-semibold">
                      <dt>Price</dt>
                      <dd>{formatCurrency(plate.breakdown.suggestedPrice)}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Grand total + save */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-4">
                <h3 className="font-semibold dark:text-gray-100">
                  Total — {threeMfResult.plates.length} plate{threeMfResult.plates.length !== 1 ? 's' : ''}
                </h3>
                <dl className="flex gap-6 text-right">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Cost</dt>
                    <dd className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(threeMfResult.grandTotalCost)}</dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Price ({threeMfResult.markupMultiplier}×)</dt>
                    <dd className="text-sm font-semibold tabular-nums text-brand-600 dark:text-brand-400">{formatCurrency(threeMfResult.grandSuggestedPrice)}</dd>
                  </div>
                </dl>
              </div>
              <div className="pt-4 border-t dark:border-gray-700 space-y-3">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Save as Quote</h4>
                <Select
                  label="Customer"
                  value={saveCustomerId}
                  onChange={e => setSaveCustomerId(e.target.value)}
                  options={[{ value: '', label: 'Select customer...' }, ...customers.map(c => ({ value: c.id, label: c.name }))]}
                />
                <Button
                  onClick={handleSave3mfQuote}
                  disabled={saving || !saveCustomerId}
                  className="w-full"
                  variant="secondary"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? 'Saving...' : `Save Quote (${threeMfResult.plates.length} items)`}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
