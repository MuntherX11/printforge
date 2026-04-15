'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Material {
  id: string;
  name: string;
  type: string;
  color?: string;
}

interface QuoteResult {
  suggestedPrice: number;
  markupMultiplier: number;
  totalCost: number;
}

interface AnalysisResult {
  fileName: string;
  fileType: string;
  slicer?: string;
  estimatedTimeSeconds?: number;
  filamentUsedGrams?: number;
  layerHeight?: number;
}

function formatTime(seconds?: number) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTimeSec(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function CustomerQuickQuotePage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [materialId, setMaterialId] = useState('');
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [estimate, setEstimate] = useState<QuoteResult | null>(null);
  const [error, setError] = useState('');

  // 3MF state
  const [threeMfAnalysis, setThreeMfAnalysis] = useState<any>(null);
  const [threeMfLoading, setThreeMfLoading] = useState(false);
  const [threeMfSelected, setThreeMfSelected] = useState<Set<number>>(new Set());
  const [threeMfResult, setThreeMfResult] = useState<any>(null);
  const [threeMfEstimating, setThreeMfEstimating] = useState(false);

  useEffect(() => {
    api.get<Material[]>('/materials').then(setMaterials).catch(() => {});
  }, []);

  const is3mfFile = file?.name.toLowerCase().endsWith('.3mf') ?? false;

  function resetResults() {
    setAnalysis(null);
    setEstimate(null);
    setError('');
    setThreeMfAnalysis(null);
    setThreeMfResult(null);
    setThreeMfSelected(new Set());
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setFile(f);
    resetResults();
    if (f?.name.toLowerCase().endsWith('.3mf')) {
      await handleAnalyze3mf(f);
    }
  }

  async function handleAnalyze3mf(f: File) {
    if (!f) return;
    setThreeMfLoading(true);
    setError('');
    try {
      const data = await api.upload('/file-parser/analyze', f, {});
      if (data?.analysis?.type === '3mf') {
        setThreeMfAnalysis(data.analysis);
        // Pre-select all plates
        const allIndices = new Set<number>(
          (data.analysis.plates as any[]).map((p: any) => p.plateIndex as number),
        );
        setThreeMfSelected(allIndices);
      } else {
        setError('Could not parse 3MF file');
      }
    } catch (err: any) {
      setError(err.message || '3MF analysis failed');
    } finally {
      setThreeMfLoading(false);
    }
  }

  async function handleAnalyze() {
    if (!file || !materialId) return;
    setLoading(true);
    setError('');
    setAnalysis(null);
    setEstimate(null);
    try {
      const res = await api.upload(
        '/file-parser/analyze', file, { materialId },
      ) as { analysis: AnalysisResult; costEstimate: QuoteResult };
      setAnalysis(res.analysis);
      setEstimate(res.costEstimate);
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setLoading(false);
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
          name: p.name,
          printSeconds: p.printSeconds,
          weightGrams: p.weightGrams,
          toolChanges: p.toolChanges,
          tools: p.tools,
        }));
      const data = await api.post('/costing/estimate-plates', {
        plates: selectedPlates,
        defaultMaterialId: materialId,
      });
      setThreeMfResult(data);
    } catch (err: any) {
      setError(err.message || 'Estimation failed');
    } finally {
      setThreeMfEstimating(false);
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold dark:text-gray-100">Quick Quote</h1>

      {/* File upload card */}
      <Card>
        <CardHeader>
          <CardTitle>Upload your file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              File (.gcode, .stl, or .3mf)
            </label>
            <input
              type="file"
              accept=".gcode,.gco,.g,.stl,.3mf"
              onChange={handleFileChange}
              className="mt-1 block w-full text-sm text-gray-500 dark:text-gray-400
                file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0
                file:text-sm file:font-medium file:bg-brand-50 file:text-brand-700
                dark:file:bg-brand-950 dark:file:text-brand-300
                hover:file:bg-brand-100"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Material</label>
            <select
              value={materialId}
              onChange={e => setMaterialId(e.target.value)}
              className="mt-1 flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="">Select material...</option>
              {materials.map(m => (
                <option key={m.id} value={m.id}>{m.name}{m.color ? ` (${m.color})` : ''}</option>
              ))}
            </select>
          </div>

          {/* 3MF parsing indicator */}
          {is3mfFile && threeMfLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <svg className="animate-spin h-4 w-4 text-brand-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Parsing 3MF file…
            </div>
          )}

          {/* 3MF: plate selector */}
          {is3mfFile && threeMfAnalysis && !threeMfLoading && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {threeMfAnalysis.totalPlates} plate{threeMfAnalysis.totalPlates !== 1 ? 's' : ''} found
                {threeMfAnalysis.slicer ? ` · ${threeMfAnalysis.slicer}` : ''}
              </p>
              <div className="space-y-2">
                {(threeMfAnalysis.plates as any[]).map((plate: any) => {
                  const selected = threeMfSelected.has(plate.plateIndex);
                  return (
                    <label
                      key={plate.plateIndex}
                      className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                        selected
                          ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/30 dark:border-brand-400'
                          : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => togglePlate(plate.plateIndex)}
                        className="h-4 w-4 rounded border-gray-300 text-brand-600"
                      />
                      {plate.thumbnailBase64 && (
                        <img
                          src={plate.thumbnailBase64}
                          alt={plate.name}
                          className="h-12 w-16 object-contain rounded bg-gray-100 dark:bg-gray-800"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium dark:text-gray-200">{plate.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {formatTimeSec(plate.printSeconds)} · {Math.round(plate.weightGrams)}g
                          {plate.toolChanges > 0 ? ` · ${plate.toolChanges} color change${plate.toolChanges !== 1 ? 's' : ''}` : ''}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>

              <Button
                onClick={handleEstimatePlates}
                disabled={threeMfSelected.size === 0 || !materialId || threeMfEstimating}
                className="w-full"
              >
                {threeMfEstimating
                  ? 'Estimating…'
                  : `Get Quote for ${threeMfSelected.size} Plate${threeMfSelected.size !== 1 ? 's' : ''}`}
              </Button>
            </div>
          )}

          {/* Non-3MF: standard button */}
          {!is3mfFile && (
            <Button onClick={handleAnalyze} disabled={!file || !materialId || loading}>
              {loading ? 'Analyzing...' : 'Get Quote'}
            </Button>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </CardContent>
      </Card>

      {/* Non-3MF results */}
      {analysis && estimate && !is3mfFile && (
        <Card>
          <CardHeader>
            <CardTitle>Your Quote</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500 dark:text-gray-400">File</span>
                <p className="font-medium dark:text-gray-200">{analysis.fileName}</p>
              </div>
              {analysis.slicer && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Slicer</span>
                  <p className="font-medium dark:text-gray-200">{analysis.slicer}</p>
                </div>
              )}
              <div>
                <span className="text-gray-500 dark:text-gray-400">Print Time</span>
                <p className="font-medium dark:text-gray-200">{formatTime(analysis.estimatedTimeSeconds)}</p>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400">Material Used</span>
                <p className="font-medium dark:text-gray-200">{analysis.filamentUsedGrams?.toFixed(1)}g</p>
              </div>
            </div>

            <div className="border-t dark:border-gray-700 pt-4">
              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold dark:text-gray-100">Estimated Price</span>
                <span className="text-2xl font-bold text-brand-600 dark:text-brand-400">
                  {estimate.suggestedPrice.toFixed(3)} OMR
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                This is an estimate. Final price may vary based on printer and material availability.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 3MF results */}
      {threeMfResult && is3mfFile && (
        <Card>
          <CardHeader>
            <CardTitle>Your Quote</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Per-plate breakdown */}
            <div className="space-y-2">
              {(threeMfResult.plates as any[]).map((plate: any) => (
                <div
                  key={plate.plateIndex}
                  className="flex items-center justify-between py-2 border-b dark:border-gray-700 last:border-0"
                >
                  <div>
                    <p className="text-sm font-medium dark:text-gray-200">{plate.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {formatTimeSec(plate.printSeconds)} · {Math.round(plate.weightGrams)}g
                      {plate.isMultiColor ? ' · Multi-color' : ''}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-brand-600 dark:text-brand-400">
                    {plate.breakdown.suggestedPrice.toFixed(3)} OMR
                  </span>
                </div>
              ))}
            </div>

            {/* Grand total */}
            <div className="border-t dark:border-gray-700 pt-4">
              <div className="flex justify-between items-center">
                <span className="text-lg font-semibold dark:text-gray-100">
                  Total ({threeMfResult.plates.length} plate{threeMfResult.plates.length !== 1 ? 's' : ''})
                </span>
                <span className="text-2xl font-bold text-brand-600 dark:text-brand-400">
                  {threeMfResult.grandSuggestedPrice.toFixed(3)} OMR
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                This is an estimate. Final price may vary based on printer and material availability.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
