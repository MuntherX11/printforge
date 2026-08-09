'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Palette, Search } from 'lucide-react';

interface BrandRow {
  brand: string;
  enabled: boolean;
  swatches: number;
}

/**
 * Which filament brands appear in the Filaments form.
 *
 * The swatch catalogue lists 150-odd brands; a workshop buys from a handful.
 * Everything is off by default except the brands actually in use here, so the
 * Brand dropdown opens on a short list instead of a wall of names.
 */
export function FilamentBrandsManager() {
  const { toast } = useToast();
  const [rows, setRows] = useState<BrandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);

  function load() {
    setLoading(true);
    api.get<any>('/filament-catalog/brand-settings')
      .then((r) => setRows(r?.brands || []))
      .catch((err: any) => toast('error', err?.message || 'Failed to load brands'))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const enabledCount = rows.filter((r) => r.enabled).length;

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!onlyEnabled || r.enabled) && (!term || r.brand.toLowerCase().includes(term)),
    );
  }, [rows, q, onlyEnabled]);

  function toggle(brand: string) {
    setRows((cur) => cur.map((r) => (r.brand === brand ? { ...r, enabled: !r.enabled } : r)));
  }

  async function save() {
    setSaving(true);
    try {
      const brands = rows.filter((r) => r.enabled).map((r) => r.brand);
      await api.post('/filament-catalog/brand-settings', { brands });
      toast('success', `${brands.length} brand${brands.length === 1 ? '' : 's'} enabled`);
    } catch (err: any) {
      toast('error', err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-4 w-4" /> Filament Brands
          </CardTitle>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {loading ? '' : `${enabledCount} of ${rows.length} enabled`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Only enabled brands appear when adding a filament. Turning a brand off hides its colours
          too; it never affects filaments already in stock.
        </p>

        {loading ? (
          <p className="py-6 text-center text-sm text-gray-500">Loading brands…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">
            No swatch catalogue loaded, so there are no brands to choose from.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search brands…"
                  className="h-10 w-full rounded-md border border-gray-300 bg-white pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={onlyEnabled}
                  onChange={(e) => setOnlyEnabled(e.target.checked)}
                  className="h-4 w-4"
                />
                Enabled only
              </label>
            </div>

            <div className="max-h-80 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700">
              {visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-gray-500">No brands match that.</p>
              ) : (
                visible.map((r) => (
                  <label
                    key={r.brand}
                    className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                  >
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => toggle(r.brand)}
                      className="h-4 w-4 flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm dark:text-gray-100">{r.brand}</span>
                    <span className="flex-shrink-0 text-xs tabular-nums text-gray-400">
                      {r.swatches} colour{r.swatches === 1 ? '' : 's'}
                    </span>
                  </label>
                ))
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save Brands'}
              </Button>
              <Button variant="outline" onClick={load} disabled={saving}>Reset</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
