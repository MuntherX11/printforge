'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import type { ScannedFields as ScannedSpoolFields } from '@/components/spool-label-scanner';
import dynamic from 'next/dynamic';
const SpoolLabelScanner = dynamic(
  () => import('@/components/spool-label-scanner').then(m => ({ default: m.SpoolLabelScanner })),
  { ssr: false },
);
import { api } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Plus, Package, Upload, MapPin, Download, ScanLine, Search, X } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import type { FilamentStockRow } from '@/lib/types/api';
import {
  DEFAULT_FILAMENT_LIST_STATE,
  filterFilaments,
  parseFilamentListState,
  serializeFilamentListState,
  type FilamentListState,
} from '@printforge/types';
import { FilamentsFilterBar, type FilamentFilterPatch } from './FilamentsFilterBar';
import { FilamentsTable, PfidShortcut, filamentHref } from './FilamentsTable';
import { ScanReviewDialog } from './ScanReviewDialog';

/** Shape returned by bulk-upload endpoint */
interface BulkUploadResult {
  created: number;
  skipped: number;
  errors: string[];
}

/** The search box writes the URL this long after the last keystroke. */
const URL_DEBOUNCE_MS = 250;

const listUrl = (qs: string) => `/inventory${qs ? `?${qs}` : ''}`;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function FilamentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  // ---- list state, mirrored in the URL (q, type, brand, stock, sort, page)
  const [state, setState] = useState<FilamentListState>(() => parseFilamentListState(searchParams));
  /** The query string the URL should hold now. */
  const lastWritten = useRef(serializeFilamentListState(state));
  /** Query strings sent to router.replace whose echo has not come back yet. */
  const pendingWrites = useRef(new Set<string>());
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- data: every filament from GET /materials/stock; null until the first load
  const [rows, setRows] = useState<FilamentStockRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const requestId = useRef(0);
  const hasRows = useRef(false);

  const [uploadResult, setUploadResult] = useState<BulkUploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [scannedFields, setScannedFields] = useState<ScannedSpoolFields | null>(null);

  /** Loads every filament; a newer request makes older responses stale. */
  const load = useCallback(() => {
    const id = ++requestId.current;
    api.get<FilamentStockRow[]>('/materials/stock')
      .then((data) => {
        if (id !== requestId.current) return;
        hasRows.current = true;
        setRows(data);
        setLoadFailed(false);
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return;
        if (hasRows.current) toast('error', errorText(err, "Couldn't load filaments"));
        else setLoadFailed(true);
      });
  }, [toast]);

  useEffect(() => {
    load();
    return () => {
      requestId.current += 1; // ignore a response that lands after unmount
      if (urlTimer.current) clearTimeout(urlTimer.current);
    };
  }, [load]);

  // Adopt the URL when it changes from outside (Back, the dashboard tile, the
  // sidebar link), but not when it is the echo of our own router.replace.
  const spString = searchParams.toString();
  useEffect(() => {
    // searchParams is tracked through spString, which changes exactly when it does.
    const parsed = parseFilamentListState(searchParams);
    const qs = serializeFilamentListState(parsed);
    if (pendingWrites.current.has(qs)) {
      // Our own write coming back; once the newest one has, older echoes are done.
      if (qs === lastWritten.current) pendingWrites.current.clear();
      return;
    }
    if (qs === lastWritten.current) return;
    pendingWrites.current.clear();
    lastWritten.current = qs;
    if (urlTimer.current) clearTimeout(urlTimer.current);
    setState(parsed);
  }, [spString]);

  const result = useMemo(() => filterFilaments(rows ?? [], state), [rows, state]);

  /** The state as shown: once data is loaded a brand no filament has is dropped. */
  const view: FilamentListState = rows ? { ...state, brand: result.brand } : state;

  function writeUrl(next: FilamentListState) {
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = null;
    const qs = serializeFilamentListState(next);
    if (qs === lastWritten.current) return;
    pendingWrites.current.add(qs);
    lastWritten.current = qs;
    router.replace(listUrl(qs), { scroll: false });
  }

  /** Before leaving for a filament: make the current history entry hold this view, so Back restores it. */
  function flushUrl() {
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = null;
    const qs = serializeFilamentListState(view);
    lastWritten.current = qs;
    const url = listUrl(qs);
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, '', url);
  }

  function onQuery(q: string) {
    const next = { ...view, q, page: 1 };
    setState(next);
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => writeUrl(next), URL_DEBOUNCE_MS);
  }

  function update(patch: FilamentFilterPatch | { page: number }) {
    const next = { ...view, page: 1, ...patch };
    setState(next);
    writeUrl(next);
  }

  /** Resets search, Type, Brand, stock and page; keeps the sort. */
  function clearFilters() {
    const next = { ...DEFAULT_FILAMENT_LIST_STATE, sort: state.sort };
    setState(next);
    writeUrl(next);
  }

  /** Enter in the search box: open the PF-ID shortcut, or the only matching filament. */
  function openSingleMatch() {
    let href: string | null = null;
    if (result.pfidHit) href = filamentHref(result.pfidHit.row, [result.pfidHit.spool]);
    else if (result.matchedCount === 1) href = filamentHref(result.pageRows[0], result.spoolHits[result.pageRows[0].id]);
    if (!href) return;
    flushUrl();
    router.push(href);
  }

  function retry() {
    setLoadFailed(false);
    load();
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const uploaded = await api.upload('/materials/bulk-upload', file, {});
      setUploadResult(uploaded);
      load();
    } catch (err: unknown) {
      setUploadResult({ created: 0, skipped: 0, errors: [errorText(err, 'Upload failed')] });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Filaments</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/inventory/locations">
            <Button variant="outline"><MapPin className="h-4 w-4 mr-2" /> Locations</Button>
          </Link>
          <span className="hidden sm:inline-flex">
            <Button
              variant="outline"
              onClick={() => {
                window.open('/api/materials/template', '_blank');
              }}
            >
              <Download className="h-4 w-4 mr-2" /> Template
            </Button>
          </span>
          <label className="cursor-pointer hidden sm:inline-flex">
            <input type="file" accept=".xlsx" className="hidden" onChange={handleFileUpload} disabled={uploading} />
            <span className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 gap-2">
              <Upload className="h-4 w-4" /> {uploading ? 'Uploading...' : 'Excel Import'}
            </span>
          </label>
          <Button variant="outline" onClick={() => setShowScanner(true)}>
            <ScanLine className="h-4 w-4 mr-2" /> Scan Label
          </Button>
          <Link href="/inventory/new">
            <Button><Plus className="h-4 w-4 mr-2" /> Add Material</Button>
          </Link>
        </div>
      </div>

      {uploadResult && (
        <div className={`flex items-start justify-between gap-3 rounded-md p-4 text-sm ${uploadResult.created > 0 ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300' : 'bg-yellow-50 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300'}`}>
          <div>
            {uploadResult.created > 0 && <p>Created {uploadResult.created} materials.</p>}
            {uploadResult.skipped > 0 && <p>Skipped {uploadResult.skipped} rows.</p>}
            {uploadResult.errors?.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {uploadResult.errors.slice(0, 5).map((e: string, i: number) => <li key={i}>{e}</li>)}
                {uploadResult.errors.length > 5 && <li>...and {uploadResult.errors.length - 5} more</li>}
              </ul>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setUploadResult(null)}
            className="-m-1 rounded p-1 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <FilamentsFilterBar
        state={view}
        result={result}
        loaded={rows !== null}
        onQuery={onQuery}
        onChange={update}
        onClearFilters={clearFilters}
        onSubmit={openSingleMatch}
      />

      {result.pfidHit && (
        <PfidShortcut row={result.pfidHit.row} spool={result.pfidHit.spool} onBeforeNavigate={flushUrl} />
      )}

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            loadFailed ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <p role="alert" className="text-sm text-gray-700 dark:text-gray-300">Couldn&apos;t load filaments</p>
                <Button variant="outline" onClick={retry}>Retry</Button>
              </div>
            ) : (
              <Loading />
            )
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Package className="h-12 w-12" />}
              title="No materials added yet"
              description="Add your first material spool to start tracking inventory"
              action={<Link href="/inventory/new"><Button><Plus className="h-4 w-4 mr-2" /> Add Material</Button></Link>}
            />
          ) : result.matchedCount === 0 ? (
            <EmptyState
              icon={<Search className="h-12 w-12" />}
              title="No filaments match these filters"
              action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : (
            <FilamentsTable rows={result.pageRows} spoolHits={result.spoolHits} onBeforeNavigate={flushUrl} />
          )}
        </CardContent>
      </Card>
      <Pagination page={result.page} totalPages={result.totalPages} onPageChange={(page) => update({ page })} />

      <SpoolLabelScanner
        open={showScanner}
        onClose={() => setShowScanner(false)}
        onResult={setScannedFields}
      />

      <ScanReviewDialog
        fields={scannedFields}
        rows={rows}
        loadFailed={loadFailed}
        onClose={() => setScannedFields(null)}
        onChanged={load}
        onRetry={retry}
      />
    </div>
  );
}

/** useSearchParams needs a Suspense boundary for the production build. */
export default function InventoryPage() {
  return (
    <Suspense fallback={<Loading />}>
      <FilamentsPage />
    </Suspense>
  );
}
