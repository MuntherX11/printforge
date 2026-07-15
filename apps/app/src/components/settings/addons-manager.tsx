'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Puzzle, Upload, Trash2, ExternalLink } from 'lucide-react';

interface Addon {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  version: string;
  isActive: boolean;
}

export function AddonsManager() {
  const { toast } = useToast();
  const [addons, setAddons] = useState<Addon[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function load() {
    api.get<Addon[]>('/addons/manage')
      .then((list) => setAddons(Array.isArray(list) ? list : []))
      .catch((err: any) => toast('error', err?.message || 'Failed to load addons'))
      .finally(() => setLoading(false));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const addon = (await api.upload('/addons/upload', file, {})) as Addon;
      toast('success', `Installed "${addon.name}" v${addon.version}`);
      load();
    } catch (err: any) {
      toast('error', err?.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function toggleActive(a: Addon) {
    setBusyId(a.id);
    try {
      await api.patch(`/addons/${a.id}`, { isActive: !a.isActive });
      setAddons((prev) => prev.map((x) => (x.id === a.id ? { ...x, isActive: !x.isActive } : x)));
    } catch (err: any) {
      toast('error', err?.message || 'Failed to update');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: Addon) {
    if (!confirm(`Remove addon "${a.name}"? Its files will be deleted.`)) return;
    setBusyId(a.id);
    try {
      await api.delete(`/addons/${a.id}`);
      setAddons((prev) => prev.filter((x) => x.id !== a.id));
      toast('success', 'Addon removed');
    } catch (err: any) {
      toast('error', err?.message || 'Failed to remove');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Puzzle className="h-4 w-4" /> Addons
          </CardTitle>
          <label className="cursor-pointer">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={handleUpload}
              disabled={uploading}
            />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
              <Upload className="h-4 w-4" /> {uploading ? 'Installing…' : 'Upload addon (.zip)'}
            </span>
          </label>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Upload a zipped web app containing an <code className="text-xs">addon.json</code> manifest.
          Active addons appear in the sidebar for all staff.
        </p>

        {loading ? (
          <p className="text-sm text-gray-500 py-4 text-center">Loading…</p>
        ) : addons.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            No addons installed yet. Upload a <code className="text-xs">.zip</code> to add one.
          </p>
        ) : (
          <div className="space-y-2">
            {addons.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 py-2.5 border-b dark:border-gray-700 last:border-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate dark:text-gray-100">{a.name}</p>
                    <span className="text-xs text-gray-400">v{a.version}</span>
                    {!a.isActive && (
                      <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-700 rounded px-1">
                        disabled
                      </span>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{a.description}</p>
                  )}
                  <p className="text-[11px] text-gray-400 font-mono">/{a.slug}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {a.isActive && (
                    <Link
                      href={`/addons/${a.slug}`}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      <ExternalLink className="h-3.5 w-3.5" /> Open
                    </Link>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === a.id}
                    onClick={() => toggleActive(a)}
                  >
                    {a.isActive ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busyId === a.id}
                    onClick={() => remove(a)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
