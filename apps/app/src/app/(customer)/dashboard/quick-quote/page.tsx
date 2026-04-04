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

export default function CustomerQuickQuotePage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [materialId, setMaterialId] = useState('');
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [estimate, setEstimate] = useState<QuoteResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Material[]>('/materials').then(setMaterials).catch(() => {});
  }, []);

  async function handleAnalyze() {
    if (!file || !materialId) return;
    setLoading(true);
    setError('');
    setAnalysis(null);
    setEstimate(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('materialId', materialId);
      const res = await api.upload(
        '/file-parser/analyze', file, { materialId }
      ) as { analysis: AnalysisResult; costEstimate: QuoteResult };
      setAnalysis(res.analysis);
      setEstimate(res.costEstimate);
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }

  function formatTime(seconds?: number) {
    if (!seconds) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold dark:text-gray-100">Quick Quote</h1>

      <Card>
        <CardHeader>
          <CardTitle>Upload your file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">File (.gcode or .stl)</label>
            <input
              type="file"
              accept=".gcode,.gco,.g,.stl"
              onChange={e => {
                setFile(e.target.files?.[0] || null);
                setAnalysis(null);
                setEstimate(null);
                setError('');
              }}
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
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <Button onClick={handleAnalyze} disabled={!file || !materialId || loading}>
            {loading ? 'Analyzing...' : 'Get Quote'}
          </Button>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>

      {analysis && estimate && (
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
    </div>
  );
}
