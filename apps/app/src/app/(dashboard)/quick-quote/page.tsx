'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Upload, Calculator, FileText, Box, Save, Link2 } from 'lucide-react';

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
  const [customers, setCustomers] = useState<any[]>([]);
  const [saveCustomerId, setSaveCustomerId] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // Mode: 'file' | 'multi' | 'link'
  const [mode, setMode] = useState<'file' | 'multi' | 'link'>('file');

  // Link quote state
  const [linkUrl, setLinkUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scrapedData, setScrapedData] = useState<any>(null);

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
      api.get<any>('/customers').then(r => r.data || r).catch(() => []),
    ]).then(([mats, prts, custs]) => {
      setMaterials(Array.isArray(mats) ? mats : []);
      setPrinters(prts);
      setCustomers(Array.isArray(custs) ? custs : []);
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
      // Auto-populate color changes from gcode analysis
      if (data?.analysis?.totalFilamentChanges != null) {
        setColorChanges(String(data.analysis.totalFilamentChanges));
      }
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setAnalyzing(false);
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

  async function handleScrapeUrl() {
    if (!linkUrl.trim()) return;
    setScraping(true);
    setScrapedData(null);
    setError('');
    try {
      const data = await api.post('/file-parser/scrape-url', { url: linkUrl });
      setScrapedData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to scrape URL');
    } finally {
      setScraping(false);
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
  const printerOptions = [{ value: '', label: 'Select printer...' }, ...printers.map(p => ({ value: p.id, label: p.name }))];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Quick Quote</h1>
        <div className="flex gap-2">
          <Button variant={mode === 'file' ? 'primary' : 'outline'} onClick={() => { setMode('file'); setMultiMode(false); setResult(null); setError(''); setMultiResult(null); setScrapedData(null); }}>
            <Upload className="h-4 w-4 mr-2" /> File Upload
          </Button>
          <Button variant={mode === 'multi' ? 'primary' : 'outline'} onClick={() => { setMode('multi'); setMultiMode(true); setResult(null); setError(''); setMultiResult(null); setScrapedData(null); }}>
            <Calculator className="h-4 w-4 mr-2" /> Multi-Color
          </Button>
          <Button variant={mode === 'link' ? 'primary' : 'outline'} onClick={() => { setMode('link'); setResult(null); setError(''); setMultiResult(null); setScrapedData(null); }}>
            <Link2 className="h-4 w-4 mr-2" /> Link Quote
          </Button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

      {mode === 'file' ? (
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
                    onChange={e => {
                      const f = e.target.files?.[0] || null;
                      setFile(f);
                      setResult(null);
                      setError('');
                      setMultiResult(null);
                      setScrapedData(null);
                    }}
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

              <Button onClick={handleAnalyze} disabled={!file || analyzing || !materialId || !printerId} className="w-full">
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
                      <div className="flex justify-between"><dt className="text-gray-500">Material</dt><dd>{result.costEstimate.materialCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Machine</dt><dd>{result.costEstimate.machineCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Electricity</dt><dd>{(result.costEstimate.electricityCost || 0).toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Waste</dt><dd>{result.costEstimate.wasteCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between"><dt className="text-gray-500">Overhead</dt><dd>{result.costEstimate.overheadCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between border-t pt-2 font-medium"><dt>Total Cost</dt><dd>{result.costEstimate.totalCost.toFixed(3)} OMR</dd></div>
                      <div className="flex justify-between text-brand-600 font-semibold text-base"><dt>Suggested Price</dt><dd>{result.costEstimate.suggestedPrice.toFixed(3)} OMR</dd></div>
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
        </>
      ) : mode === 'multi' ? (
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
      ) : (
        <>
          {/* Link quote mode */}
          <Card>
            <CardContent className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Model URL</label>
                <p className="text-xs text-gray-400 mb-2">
                  Paste a link from MakerWorld, Thangs, Thingiverse, Printables, MyMiniFactory, or Cults3D
                </p>
                <div className="flex gap-2">
                  <Input
                    value={linkUrl}
                    onChange={e => setLinkUrl(e.target.value)}
                    placeholder="https://makerworld.com/en/models/..."
                    className="flex-1"
                  />
                  <Button onClick={handleScrapeUrl} disabled={scraping || !linkUrl.trim()}>
                    {scraping ? 'Scraping...' : 'Fetch'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {scrapedData && (
            <Card>
              <CardContent className="p-6">
                <div className="flex gap-4">
                  {scrapedData.thumbnailUrl && (
                    <img
                      src={scrapedData.thumbnailUrl}
                      alt={scrapedData.title || 'Model preview'}
                      className="w-32 h-32 object-cover rounded-lg border"
                    />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {scrapedData.siteName && (
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{scrapedData.siteName}</span>
                      )}
                    </div>
                    <h3 className="font-semibold text-lg">{scrapedData.title || 'Unknown Model'}</h3>
                    {scrapedData.description && (
                      <p className="text-sm text-gray-500 mt-1 line-clamp-3">{scrapedData.description}</p>
                    )}
                    <a href={scrapedData.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-600 hover:underline mt-2 inline-block">
                      View on {scrapedData.siteName || 'site'}
                    </a>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t space-y-3">
                  {scrapedData.isPaid ? (
                    <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded">
                      This model requires purchase on {scrapedData.siteName || 'the source site'}
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-600">
                        To generate an accurate quote, the STL file is needed. You can:
                      </p>
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onClick={() => { setMode('file'); }}>
                          <Upload className="h-4 w-4 mr-1" /> Upload STL Yourself
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => {
                          toast('success', 'Request noted — admin will handle the STL file');
                        }}>
                          Let Us Handle It
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
