'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useFormatCurrency } from '@/lib/locale-context';
import { ArrowLeft, AlertTriangle, CheckCircle, Sparkles } from 'lucide-react';

interface Field {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select' | 'checkbox';
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string } | string>;
}

interface Info {
  dimensions: { width: number; height: number; depth: number };
  warnings: string[];
  label: string;
  estimatedGrams: number;
}

/** Normalise the loose option shapes a generator may declare. */
function normOptions(opts: Field['options']) {
  return (opts ?? []).map((o) =>
    typeof o === 'string' ? { value: o, label: o } : { value: String(o.value), label: String(o.label ?? o.value) },
  );
}

export default function ConfiguratorPage() {
  const params = useParams();
  const router = useRouter();
  const formatCurrency = useFormatCurrency();
  const key = String(params?.key ?? '');

  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [notAvailable, setNotAvailable] = useState(false);

  const [info, setInfo] = useState<Info | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ orderNumber: string } | null>(null);

  // ---- load field definitions ----
  useEffect(() => {
    if (!key) return;
    api.get<{ fields?: Field[] }>(`/configurator/${key}/choices`)
      .then((r) => {
        const fs = Array.isArray(r?.fields) ? r.fields : [];
        setFields(fs);
        const init: Record<string, unknown> = {};
        for (const f of fs) {
          if (f.default !== undefined) init[f.key] = f.default;
          else if (f.type === 'select') init[f.key] = normOptions(f.options)[0]?.value ?? '';
          else if (f.type === 'checkbox') init[f.key] = false;
          else init[f.key] = '';
        }
        setValues(init);
      })
      .catch(() => setNotAvailable(true))
      .finally(() => setLoading(false));
  }, [key]);

  // ---- server-side preview, debounced ----
  // The server is the authority on validity: whatever it rejects here is
  // exactly what it would reject at order time, so the customer sees real
  // constraints rather than a guess made in the browser.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshPreview = useCallback((vals: Record<string, unknown>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(vals)) {
        if (v !== '' && v !== undefined && v !== null) qs.set(k, String(v));
      }
      setPreviewing(true);
      try {
        const i = await api.get<Info>(`/configurator/${key}/info?${qs}`);
        setInfo(i);
        setValidationError(null);
        setPreviewSrc(`/api/configurator/${key}/preview.svg?${qs}`);
      } catch (err: any) {
        setValidationError(err?.message || 'That combination isn’t valid');
        setInfo(null);
      } finally {
        setPreviewing(false);
      }
    }, 350);
  }, [key]);

  useEffect(() => {
    if (!loading && fields.length > 0) refreshPreview(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, loading, fields.length]);

  function setField(k: string, v: unknown) {
    setValues((prev) => ({ ...prev, [k]: v }));
    setPlaced(null);
    setOrderError(null);
  }

  async function placeOrder() {
    setSubmitting(true);
    setOrderError(null);
    try {
      const res = await api.post<{ orderNumber: string }>('/configurator/orders', {
        generatorKey: key,
        params: values,
        quantity,
      });
      setPlaced({ orderNumber: res.orderNumber });
    } catch (err: any) {
      setOrderError(err?.message || 'Could not place the order — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-5 w-32 rounded bg-gray-200 dark:bg-gray-700" />
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="h-96 rounded-lg bg-gray-100 dark:bg-gray-800" />
          <div className="h-96 rounded-lg bg-gray-100 dark:bg-gray-800" />
        </div>
      </div>
    );
  }

  if (notAvailable) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-gray-500 dark:text-gray-400">
          <Sparkles className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">This designer isn&apos;t available</p>
          <Link href="/dashboard/configurator" className="text-sm text-brand-600 dark:text-brand-400 hover:underline mt-2 inline-block">
            Back to all designers
          </Link>
        </CardContent>
      </Card>
    );
  }

  const canOrder = !!info && !validationError && !previewing;

  return (
    <div className="space-y-5">
      <Link
        href="/dashboard/configurator"
        className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      >
        <ArrowLeft className="h-4 w-4" /> All designers
      </Link>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- Controls ---- */}
        <Card>
          <CardContent className="p-5 space-y-4">
            <h1 className="text-lg font-semibold dark:text-gray-100">Customise</h1>

            {fields.map((f) => {
              const v = values[f.key];
              if (f.type === 'select') {
                return (
                  <Select
                    key={f.key}
                    label={f.label}
                    value={String(v ?? '')}
                    onChange={(e) => setField(f.key, e.target.value)}
                    options={normOptions(f.options)}
                  />
                );
              }
              if (f.type === 'checkbox') {
                return (
                  <label key={f.key} className="flex items-center gap-2.5 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={!!v}
                      onChange={(e) => setField(f.key, e.target.checked)}
                      className="rounded border-gray-300 text-brand-600"
                    />
                    {f.label}
                  </label>
                );
              }
              return (
                <Input
                  key={f.key}
                  label={f.label}
                  type={f.type === 'number' ? 'number' : 'text'}
                  min={f.min}
                  max={f.max}
                  step={f.step ?? (f.type === 'number' ? 'any' : undefined)}
                  maxLength={f.maxLength}
                  value={String(v ?? '')}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              );
            })}
          </CardContent>
        </Card>

        {/* ---- Preview + order ---- */}
        <div className="space-y-4">
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold dark:text-gray-100">Preview</h2>
                {previewing && <span className="text-xs text-gray-400">updating…</span>}
              </div>

              <div className="rounded-md border dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 min-h-[180px] flex items-center justify-center overflow-hidden">
                {validationError ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" /> {validationError}
                  </p>
                ) : previewSrc ? (
                  // Rendered as an <img>, so the SVG cannot execute script even
                  // though the server already strips scriptable content.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewSrc} alt="Design preview" className="max-w-full max-h-64" />
                ) : (
                  <p className="text-sm text-gray-400">Adjust the options to see a preview</p>
                )}
              </div>

              {info && (
                <dl className="grid grid-cols-2 gap-2 mt-4 text-sm">
                  <div className="flex justify-between border-b border-dashed dark:border-gray-700 py-1">
                    <dt className="text-gray-500 dark:text-gray-400">Size</dt>
                    <dd className="dark:text-gray-200 tabular-nums">
                      {info.dimensions.width.toFixed(0)}×{info.dimensions.height.toFixed(0)}×{info.dimensions.depth.toFixed(1)} mm
                    </dd>
                  </div>
                  <div className="flex justify-between border-b border-dashed dark:border-gray-700 py-1">
                    <dt className="text-gray-500 dark:text-gray-400">Material</dt>
                    <dd className="dark:text-gray-200 tabular-nums">~{info.estimatedGrams} g</dd>
                  </div>
                </dl>
              )}

              {info?.warnings?.length ? (
                <ul className="mt-3 space-y-1">
                  {info.warnings.map((w, i) => (
                    <li key={i} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-4">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Quantity</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    className="w-10 h-10 rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                    aria-label="Decrease quantity"
                  >
                    −
                  </button>
                  <span className="w-8 text-center font-semibold dark:text-gray-200">{quantity}</span>
                  <button
                    onClick={() => setQuantity((q) => Math.min(50, q + 1))}
                    className="w-10 h-10 rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                </div>
              </div>

              <ol className="text-xs text-gray-400 dark:text-gray-500 space-y-0.5 list-none border-t dark:border-gray-700 pt-3">
                <li>1. You place the order</li>
                <li>2. We generate the print file and confirm within 24 hours</li>
                <li>3. Ready for delivery in 1–3 business days</li>
              </ol>

              {placed ? (
                <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-4 py-3">
                  <p className="text-sm font-medium text-green-700 dark:text-green-400 flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" /> Order {placed.orderNumber} received!
                  </p>
                  <p className="text-xs text-green-700/80 dark:text-green-400/80 mt-1">
                    We&apos;ll confirm by WhatsApp or email within 24 hours.
                  </p>
                  <button
                    onClick={() => router.push('/dashboard/orders')}
                    className="mt-2 text-xs underline font-medium text-green-700 dark:text-green-400"
                  >
                    View in My Orders
                  </button>
                </div>
              ) : (
                <>
                  {orderError && (
                    <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">
                      {orderError}
                    </p>
                  )}
                  <Button className="w-full" disabled={!canOrder || submitting} onClick={placeOrder}>
                    {submitting ? 'Placing order…' : 'Place Order'}
                  </Button>
                  {!canOrder && !previewing && (
                    <p className="text-xs text-gray-400 text-center">
                      Fix the options above to enable ordering
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
