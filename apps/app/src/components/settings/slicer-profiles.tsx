'use client';

import { useState, useEffect, useRef } from 'react';
import type {
  SlicerBundleImportResult,
  SlicerHealth,
  SlicerProfileDto,
  SlicerProfileKind,
  SlicerProfilePatchDto,
  SlicerStockPresetDto,
  SlicerStockPresetList,
} from '@printforge/types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Layers, Upload, Trash2, RefreshCw, Plus } from 'lucide-react';

interface PrinterOption { id: string; name: string }
interface MaterialOption { id: string; name: string; type?: string | null; color?: string | null }

const KINDS: Array<{ kind: SlicerProfileKind; title: string; hint: string }> = [
  { kind: 'MACHINE', title: 'Machine presets', hint: 'Map each to the printer it drives.' },
  { kind: 'PROCESS', title: 'Process presets', hint: 'Pick the printer and mark one as its default — STL parts slice with it.' },
  { kind: 'FILAMENT', title: 'Filament presets', hint: 'Map each to the shop filament it is sliced with.' },
];

const STOCK_KINDS: Array<{ kind: SlicerProfileKind; label: string }> = [
  { kind: 'MACHINE', label: 'Printer' },
  { kind: 'PROCESS', label: 'Process' },
  { kind: 'FILAMENT', label: 'Filament' },
];
const MAIN_TYPES = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'NYLON', 'OTHER'] as const;
/** The name a stock preset is stored under (the API appends the same suffix). */
const stockNameOf = (name: string) => `${name} (stock)`;
const STOCK_MIN_CHARS = 2;
const STOCK_DEBOUNCE_MS = 300;

const selectClass =
  'h-8 rounded-md border border-gray-300 bg-white px-2 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * Settings > Slicer (ADMIN): the OrcaSlicer presets the owner exported, their
 * printer / filament mapping, and whether the slicer container is up.
 */
export function SlicerProfilesManager() {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<SlicerProfileDto[]>([]);
  const [printers, setPrinters] = useState<PrinterOption[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [health, setHealth] = useState<SlicerHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<SlicerBundleImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [stockKind, setStockKind] = useState<SlicerProfileKind>('FILAMENT');
  const [stockQuery, setStockQuery] = useState('');
  const [stockResults, setStockResults] = useState<SlicerStockPresetDto[] | null>(null);
  const [stockSearching, setStockSearching] = useState(false);
  const [stockOffline, setStockOffline] = useState(false);
  const [addingStock, setAddingStock] = useState<string | null>(null);

  function loadProfiles() {
    return api.get<SlicerProfileDto[]>('/slicer-profiles')
      .then((list) => setProfiles(Array.isArray(list) ? list : []))
      .catch((err: any) => toast('error', err?.message || 'Failed to load slicer profiles'));
  }

  function loadHealth() {
    setHealth(null);
    api.get<SlicerHealth>('/slicer-profiles/health')
      .then(setHealth)
      .catch(() => setHealth({ reachable: false, orcaVersion: null }));
  }

  useEffect(() => {
    loadHealth();
    Promise.all([
      loadProfiles(),
      api.get<any>('/printers').then((r) => setPrinters(Array.isArray(r) ? r : [])).catch(() => {}),
      api.get<any>('/materials?limit=500').then((r) => setMaterials(Array.isArray(r) ? r : (r?.data ?? []))).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Search the presets that ship with OrcaSlicer: debounced, and a late answer never replaces a newer one.
  useEffect(() => {
    const q = stockQuery.trim();
    setStockOffline(false);
    if (q.length < STOCK_MIN_CHARS) {
      setStockResults(null);
      setStockSearching(false);
      return;
    }
    let stale = false;
    setStockSearching(true);
    const timer = setTimeout(() => {
      api.get<SlicerStockPresetList>(`/slicer-profiles/stock?kind=${stockKind}&q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (stale) return;
          setStockResults(Array.isArray(r?.presets) ? r.presets : []);
          setStockOffline(r?.reachable === false);
        })
        .catch((err: any) => {
          if (stale) return;
          setStockResults([]);
          toast('error', err?.message || 'Search failed');
        })
        .finally(() => { if (!stale) setStockSearching(false); });
    }, STOCK_DEBOUNCE_MS);
    return () => { stale = true; clearTimeout(timer); };
  }, [stockKind, stockQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addStock(preset: SlicerStockPresetDto) {
    setAddingStock(preset.name);
    try {
      await api.post<SlicerProfileDto>('/slicer-profiles/stock', { kind: stockKind, name: preset.name });
      toast('success', `Added ${preset.name}`);
      await loadProfiles();
    } catch (err: any) {
      toast('error', err?.message || 'Failed to add the preset');
    } finally {
      setAddingStock(null);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = (await api.upload('/slicer-profiles/import', file, {})) as SlicerBundleImportResult;
      setLastImport(result);
      toast('success', `Imported ${result.imported.length} preset${result.imported.length === 1 ? '' : 's'}${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`);
      await loadProfiles();
    } catch (err: any) {
      toast('error', err?.message || 'Import failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function patch(p: SlicerProfileDto, body: SlicerProfilePatchDto) {
    setBusyId(p.id);
    try {
      const updated = await api.patch<SlicerProfileDto>(`/slicer-profiles/${p.id}`, body);
      // A new default clears the old one for that printer, a new main preset the old one for that type: refetch so every row agrees.
      if (body.isDefault !== undefined || body.materialType !== undefined || updated.isDefault !== p.isDefault) await loadProfiles();
      else setProfiles((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
    } catch (err: any) {
      toast('error', err?.message || 'Failed to update');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: SlicerProfileDto) {
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    setBusyId(p.id);
    try {
      await api.delete(`/slicer-profiles/${p.id}`);
      setProfiles((prev) => prev.filter((x) => x.id !== p.id));
      toast('success', 'Preset deleted');
    } catch (err: any) {
      toast('error', err?.message || 'Failed to delete');
    } finally {
      setBusyId(null);
    }
  }

  const printerOptions = [{ value: '', label: '— no printer —' }, ...printers.map((p) => ({ value: p.id, label: p.name }))];
  const materialOptions = [
    { value: '', label: '— no filament —' },
    ...materials.map((m) => ({ value: m.id, label: [m.name, m.type && !m.name.includes(m.type) ? `(${m.type})` : ''].filter(Boolean).join(' ') })),
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" /> Slicer
            {health === null ? (
              <Badge>checking…</Badge>
            ) : health.reachable ? (
              <Badge variant="success">OrcaSlicer {health.orcaVersion ?? ''} online</Badge>
            ) : (
              <Badge variant="error">slicer offline</Badge>
            )}
            <button type="button" onClick={loadHealth} aria-label="Re-check the slicer" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              <RefreshCw className={`h-3.5 w-3.5 ${health === null ? 'animate-spin' : ''}`} />
            </button>
          </CardTitle>
          <label className="cursor-pointer">
            <input
              ref={fileRef}
              type="file"
              accept=".orca_printer,.orca_filament"
              className="hidden"
              onChange={handleUpload}
              disabled={uploading}
            />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
              <Upload className="h-4 w-4" /> {uploading ? 'Importing…' : 'Import bundle (.orca_printer / .orca_filament)'}
            </span>
          </label>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Export a printer or filament bundle from OrcaSlicer and import it here. Presets are stored exactly as
          exported; a re-import of the same preset replaces its settings and keeps its mapping.
        </p>

        {lastImport && (
          <div className="mb-4 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs space-y-1">
            <p className="font-medium dark:text-gray-100">
              Last import: {lastImport.imported.length} imported
              {lastImport.imported.some((i) => i.replaced) && ` (${lastImport.imported.filter((i) => i.replaced).length} replaced)`}
              {lastImport.skipped.length > 0 && `, ${lastImport.skipped.length} skipped`}
            </p>
            {lastImport.skipped.map((s) => (
              <p key={s.name} className="text-amber-700 dark:text-amber-400">
                Skipped <span className="font-mono">{s.name}</span>: {s.reason}
              </p>
            ))}
            {lastImport.check === null ? (
              <p className="text-gray-500 dark:text-gray-400">Slicer offline — the preset check runs at the first slice.</p>
            ) : lastImport.check.ok ? (
              <p className="text-green-700 dark:text-green-400">Every preset resolves in the slicer.</p>
            ) : (
              <p className="text-amber-700 dark:text-amber-400">
                Not resolvable in the slicer (parent preset missing): {lastImport.check.unresolved.join(', ')}
              </p>
            )}
          </div>
        )}

        <div className="mb-4 rounded-md border border-gray-200 dark:border-gray-700 p-3">
          <p className="text-sm font-medium dark:text-gray-100">Use a stock Orca preset</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Add a preset that ships with OrcaSlicer, with no bundle to export.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              aria-label="Kind of stock preset"
              className={selectClass}
              value={stockKind}
              onChange={(e) => setStockKind(e.target.value as SlicerProfileKind)}
            >
              {STOCK_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
            <input
              type="search"
              aria-label="Search stock presets by name"
              placeholder="Search by name, for example eSUN PLA+"
              className={`${selectClass} flex-1 min-w-[12rem]`}
              value={stockQuery}
              onChange={(e) => setStockQuery(e.target.value)}
            />
          </div>
          {stockQuery.trim().length >= STOCK_MIN_CHARS && (
            <div className="mt-2 text-xs" aria-live="polite">
              {stockOffline ? (
                <p className="text-amber-700 dark:text-amber-400">The slicer is offline, so its presets cannot be searched.</p>
              ) : stockResults === null ? (
                <p className="text-gray-500 dark:text-gray-400">Searching…</p>
              ) : stockResults.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400">{stockSearching ? 'Searching…' : 'No stock preset matches.'}</p>
              ) : (
                <ul className="max-h-56 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                  {stockResults.map((r) => {
                    const added = profiles.some((p) => p.kind === stockKind && p.name === stockNameOf(r.name));
                    return (
                      <li key={`${r.vendor}/${r.name}`}>
                        <button
                          type="button"
                          disabled={added || addingStock !== null}
                          onClick={() => addStock(r)}
                          className="flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm dark:text-gray-100">{r.name}</span>
                            {r.vendor && <span className="block truncate text-gray-500 dark:text-gray-400">{r.vendor}</span>}
                          </span>
                          <span className="flex-shrink-0 inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                            {added ? 'Added' : addingStock === r.name ? 'Adding…' : <><Plus className="h-3.5 w-3.5" /> Add</>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-4 text-center">Loading…</p>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            No presets yet. Import an <code className="text-xs">.orca_printer</code> bundle to add a printer, its
            process and its filaments, or add a stock preset above.
          </p>
        ) : (
          <div className="space-y-5">
            {KINDS.map(({ kind, title, hint }) => {
              const rows = profiles.filter((p) => p.kind === kind);
              if (rows.length === 0) return null;
              return (
                <div key={kind}>
                  <div className="flex items-baseline gap-2 mb-1">
                    <h3 className="text-sm font-medium dark:text-gray-100">{title}</h3>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{hint}</span>
                  </div>
                  {kind === 'FILAMENT' && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      A main preset is used for every filament of that type that has no preset of its own.
                    </p>
                  )}
                  <div>
                    {rows.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-3 py-2 border-b dark:border-gray-700 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate dark:text-gray-100">
                            {p.name}
                            {p.stock && <Badge className="ml-2 align-middle">stock</Badge>}
                          </p>
                          {p.inherits && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">based on {p.inherits}</p>
                          )}
                        </div>
                        <div className="flex items-center justify-end gap-2 flex-wrap flex-shrink-0">
                          {kind === 'FILAMENT' ? (
                            <>
                              <select
                                aria-label={`Filament for ${p.name}`}
                                className={selectClass}
                                value={p.materialId ?? ''}
                                disabled={busyId === p.id}
                                onChange={(e) => patch(p, { materialId: e.target.value || null })}
                              >
                                {materialOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                              <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-200">
                                Main for
                                <select
                                  aria-label={`Filament type ${p.name} is the main preset for`}
                                  className={selectClass}
                                  value={p.materialType ?? ''}
                                  disabled={busyId === p.id}
                                  onChange={(e) => patch(p, { materialType: (e.target.value || null) as SlicerProfilePatchDto['materialType'] })}
                                >
                                  <option value="">— none —</option>
                                  {/* A type outside the list (set through the API) still shows as selected. */}
                                  {p.materialType && !MAIN_TYPES.includes(p.materialType as (typeof MAIN_TYPES)[number]) && (
                                    <option value={p.materialType}>{p.materialType}</option>
                                  )}
                                  {MAIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                </select>
                              </label>
                            </>
                          ) : (
                            <select
                              aria-label={`Printer for ${p.name}`}
                              className={selectClass}
                              value={p.printerId ?? ''}
                              disabled={busyId === p.id}
                              onChange={(e) => patch(p, { printerId: e.target.value || null })}
                            >
                              {printerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          )}
                          {kind === 'PROCESS' && (
                            <label className={`flex items-center gap-1 text-xs ${p.printerId ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400'}`}>
                              <input
                                type="radio"
                                name={`default-process-${p.printerId ?? 'none'}`}
                                checked={p.isDefault}
                                disabled={!p.printerId || busyId === p.id}
                                onChange={() => patch(p, { isDefault: true })}
                              />
                              Default
                            </label>
                          )}
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={busyId === p.id}
                            onClick={() => remove(p)}
                            title={p.printerId || p.materialId || p.materialType ? 'Unmap first, then delete' : 'Delete'}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
