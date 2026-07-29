'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { Download, FileBox, ChevronDown, ChevronRight } from 'lucide-react';

interface Artifact {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

interface ConfigOrder {
  id: string;
  generatorKey: string;
  params: Record<string, unknown>;
  status: string;
  createdAt: string;
  artifacts: Artifact[];
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

/** Renders a parameter value without ever injecting markup. */
function paramValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Production files generated from a customer's configurator submission.
 *
 * The artifact bytes are never exposed publicly — each download goes through
 * the authenticated staff route, which verifies the artifact belongs to an
 * order. The parameters are shown because they, not the file, are the source of
 * truth: an artifact can always be regenerated from them.
 */
export function ConfigArtifactsCard({ orderId }: { orderId: string }) {
  const [configs, setConfigs] = useState<ConfigOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [openParams, setOpenParams] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.get<ConfigOrder[]>(`/configurator/orders/${orderId}`)
      .then((r) => setConfigs(Array.isArray(r) ? r : []))
      .catch(() => setConfigs([]))
      .finally(() => setLoading(false));
  }, [orderId]);

  // Nothing to show for ordinary (non-configurator) orders.
  if (loading || configs.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileBox className="h-4 w-4" /> Production Files
          <Badge variant="default" className="ml-1 text-xs">
            {configs.reduce((n, c) => n + c.artifacts.length, 0)} file
            {configs.reduce((n, c) => n + c.artifacts.length, 0) === 1 ? '' : 's'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {configs.map((cfg) => {
          const isOpen = !!openParams[cfg.id];
          return (
            <div key={cfg.id} className="rounded-md border dark:border-gray-700">
              <div className="flex items-center justify-between px-4 py-2.5 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <div>
                  <p className="text-sm font-medium dark:text-gray-100">{cfg.generatorKey}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    generated {new Date(cfg.createdAt).toLocaleString()}
                  </p>
                </div>
                {cfg.status !== 'GENERATED' && (
                  <Badge variant="error" className="text-xs">{cfg.status}</Badge>
                )}
              </div>

              {/* Downloads */}
              <div className="divide-y dark:divide-gray-700">
                {cfg.artifacts.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    No files were produced for this submission.
                  </p>
                ) : (
                  cfg.artifacts.map((a) => (
                    <div key={a.id} className="flex items-center justify-between px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate dark:text-gray-100">{a.filename}</p>
                        <p className="text-xs text-gray-400">
                          {a.mime} · {humanSize(a.sizeBytes)}
                        </p>
                      </div>
                      {/* Plain anchor so the browser handles the streamed download;
                          the route is staff-guarded and sets Content-Disposition. */}
                      <a
                        href={`/api/configurator/artifacts/${a.id}/download`}
                        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
                      >
                        <Download className="h-3.5 w-3.5" /> Download
                      </a>
                    </div>
                  ))
                )}
              </div>

              {/* Parameters — the source of truth */}
              <button
                type="button"
                onClick={() => setOpenParams((p) => ({ ...p, [cfg.id]: !isOpen }))}
                className="w-full flex items-center gap-1.5 px-4 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border-t dark:border-gray-700"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Configuration used ({Object.keys(cfg.params ?? {}).length} parameters)
              </button>
              {isOpen && (
                <dl className="px-4 pb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(cfg.params ?? {}).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2 border-b border-dashed dark:border-gray-800 py-1">
                      <dt className="text-gray-500 dark:text-gray-400">{k}</dt>
                      <dd className="font-mono text-right dark:text-gray-200 truncate" title={paramValue(v)}>
                        {paramValue(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })}
        <p className="text-xs text-gray-400">
          Files are regenerated from the saved parameters, so they always match what the customer configured.
        </p>
      </CardContent>
    </Card>
  );
}
