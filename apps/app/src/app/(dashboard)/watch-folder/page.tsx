'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Loading } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { FolderOpen, FileText, Box, Check, X, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function WatchFolderPage() {
  const { toast } = useToast();
  const [imports, setImports] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState<any>(null);
  const [importing, setImporting] = useState(false);

  const load = () => {
    Promise.all([
      api.get<any[]>('/watch-folder/pending'),
      api.get<any>('/materials').then(r => r.data || r),
    ]).then(([imps, mats]) => {
      setImports(imps);
      setMaterials(Array.isArray(mats) ? mats : []);
    }).catch(console.error).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      api.get<any[]>('/watch-folder/pending').then(setImports).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  async function handleDismiss(id: string) {
    try {
      await api.post(`/watch-folder/${id}/dismiss`);
      setImports(prev => prev.filter(i => i.id !== id));
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function handleImport(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!showImport) return;
    setImporting(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post(`/watch-folder/${showImport.id}/import`, {
        name: form.get('name'),
        sku: form.get('sku') || undefined,
        materialId: form.get('materialId') || undefined,
      });
      setShowImport(null);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <Loading />;

  const matOptions = materials.map(m => ({
    value: m.id,
    label: `${m.name}${m.color ? ` (${m.color})` : ''}`,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Watch Folder</h1>
          <p className="text-sm text-gray-500">Drop G-code or STL files into the watch folder. They appear here automatically.</p>
        </div>
        <Button variant="outline" onClick={load}>
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      {imports.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-500">
            <FolderOpen className="h-12 w-12 mx-auto mb-3 text-gray-400" />
            <p>No pending files detected</p>
            <p className="text-xs mt-1">Place .gcode or .stl files in the watch folder</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {imports.map(imp => (
            <Card key={imp.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className="mt-1">
                      {imp.fileType === 'gcode' ? (
                        <FileText className="h-8 w-8 text-blue-500" />
                      ) : (
                        <Box className="h-8 w-8 text-purple-500" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-semibold">{imp.filename}</h3>
                      <p className="text-xs text-gray-400">
                        {imp.fileType.toUpperCase()} | {(imp.fileSize / 1024).toFixed(1)} KB
                      </p>
                      <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
                        {imp.fileType === 'gcode' && imp.analysis && (
                          <>
                            {imp.analysis.slicer && <div><span className="text-gray-500">Slicer:</span> {imp.analysis.slicer}</div>}
                            {imp.analysis.estimatedTimeSeconds && <div><span className="text-gray-500">Time:</span> {Math.round(imp.analysis.estimatedTimeSeconds / 60)} min</div>}
                            {imp.analysis.filamentUsedGrams && <div><span className="text-gray-500">Filament:</span> {imp.analysis.filamentUsedGrams.toFixed(1)}g</div>}
                            {imp.analysis.filamentType && <div><span className="text-gray-500">Type:</span> {imp.analysis.filamentType}</div>}
                          </>
                        )}
                        {imp.fileType === 'stl' && imp.analysis && (
                          <>
                            {imp.analysis.volumeCm3 && <div><span className="text-gray-500">Volume:</span> {imp.analysis.volumeCm3.toFixed(2)} cm³</div>}
                            {imp.analysis.estimatedGrams && <div><span className="text-gray-500">Weight:</span> {imp.analysis.estimatedGrams.toFixed(1)}g</div>}
                            {imp.analysis.estimatedMinutes && <div><span className="text-gray-500">Time:</span> {imp.analysis.estimatedMinutes} min</div>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setShowImport(imp)}>
                      <Check className="h-4 w-4 mr-1" /> Import
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleDismiss(imp.id)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!showImport} onClose={() => setShowImport(null)} title="Import as Product">
        <form onSubmit={handleImport} className="space-y-4">
          <Input
            name="name"
            label="Product Name"
            defaultValue={showImport?.filename?.replace(/\.(gcode|gco|g|stl)$/i, '') || ''}
            required
          />
          <Input name="sku" label="SKU (optional)" />
          <Select
            name="materialId"
            label="Material (auto-adds BOM component)"
            options={[{ value: '', label: 'Skip — add material later' }, ...matOptions]}
          />

          {showImport?.analysis && (
            <div className="bg-gray-50 rounded p-3 text-sm space-y-1">
              <p className="font-medium text-gray-700">Auto-detected from file:</p>
              {(showImport.analysis.filamentUsedGrams || showImport.analysis.estimatedGrams) && (
                <p>Grams: {(showImport.analysis.filamentUsedGrams || showImport.analysis.estimatedGrams).toFixed(1)}g</p>
              )}
              {(showImport.analysis.estimatedTimeSeconds || showImport.analysis.estimatedMinutes) && (
                <p>Print time: {showImport.analysis.estimatedTimeSeconds
                  ? Math.round(showImport.analysis.estimatedTimeSeconds / 60)
                  : showImport.analysis.estimatedMinutes} min</p>
              )}
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowImport(null)}>Cancel</Button>
            <Button type="submit" disabled={importing}>
              {importing ? 'Importing...' : 'Create Product'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
