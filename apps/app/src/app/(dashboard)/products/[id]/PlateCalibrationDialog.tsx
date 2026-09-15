'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Upload } from 'lucide-react';

/**
 * Plate calibration for one BOM component: how many units fit on a full plate,
 * and that plate's total time and grams from the slicer.
 *
 * The point: printMinutes x quantity assumes every unit pays its own heat-up
 * and colour changes. A full-plate slice measures how that overhead amortises
 * — the sardine box's part dropped 40% per unit at 12-up. Upload the multi-up
 * G-code and the time and grams are read from its header; only the unit count
 * is typed by hand, because the file doesn't know it.
 */
export function PlateCalibrationDialog({ open, onClose, component, onSaved }: {
  open: boolean;
  onClose: () => void;
  component: { id: string; description: string; platedUnits?: number | null; platedMinutes?: number | null; platedGrams?: number | null } | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [units, setUnits] = useState('');
  const [minutes, setMinutes] = useState('');
  const [grams, setGrams] = useState('');
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detected, setDetected] = useState<{
    count: number | null;
    models: Array<{ model: string; count: number }>;
    ignored: string[];
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!component) return;
    setUnits(component.platedUnits ? String(component.platedUnits) : '');
    setMinutes(component.platedMinutes ? String(component.platedMinutes) : '');
    setGrams(component.platedGrams ? String(component.platedGrams) : '');
    setDetected(null);
  }, [component?.id, open]);

  async function parseGcode(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.postForm<any>('/file-parser/parse-gcode', fd);
      if (res?.estimatedTimeSeconds) setMinutes(String(Math.round(res.estimatedTimeSeconds / 60)));
      if (res?.filamentUsedGrams) setGrams(String(Math.round(res.filamentUsedGrams * 100) / 100));
      // Object labels give the unit count directly; the purge tower is already
      // excluded server-side. null means the file has no labels — ask, don't guess.
      if (res?.objectCount) setUnits(String(res.objectCount));
      setDetected({
        count: res?.objectCount ?? null,
        models: res?.objectModels ?? [],
        ignored: res?.ignoredLabels ?? [],
      });
      toast('success', res?.objectCount
        ? `Read ${res.objectCount} object${res.objectCount === 1 ? '' : 's'}, time and grams from the file`
        : 'Read time and grams — this file has no object labels, so type the units on the plate');
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function save(clear = false) {
    if (!component) return;
    setSaving(true);
    try {
      await api.patch(`/products/components/${component.id}`, clear
        ? { platedUnits: null, platedMinutes: null, platedGrams: null }
        : {
            platedUnits: parseInt(units) || undefined,
            platedMinutes: parseFloat(minutes) || undefined,
            platedGrams: parseFloat(grams) || undefined,
          });
      toast('success', clear ? 'Plate calibration cleared' : 'Plate calibration saved');
      onSaved();
      onClose();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={component ? `Plate calibration — ${component.description}` : 'Plate calibration'}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Slice a full plate of just this component, then upload the G-code — or type the slicer&apos;s
          numbers in. This drives the true cost floor for bulk pricing.
        </p>
        <div>
          <input ref={fileRef} type="file" accept=".gcode,.gco,.g" className="hidden" onChange={parseGcode} />
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={parsing}>
            <Upload className="h-4 w-4 mr-2" /> {parsing ? 'Reading…' : 'Read from plate G-code'}
          </Button>
        </div>
        {detected && (
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800/50">
            {detected.count ? (
              <>
                <p className="text-gray-700 dark:text-gray-200">
                  {detected.models.map(m => `${m.count} × ${m.model}`).join(', ')}
                </p>
                {detected.models.length > 1 && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    This plate mixes {detected.models.length} different models — check the unit count covers only this component.
                  </p>
                )}
              </>
            ) : (
              <p className="text-gray-600 dark:text-gray-300">
                No object labels in this file — type how many units are on the plate.
              </p>
            )}
            {detected.ignored.length > 0 && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Purge tower not counted.
              </p>
            )}
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Input label="Units on plate" type="number" min={1} step={1} value={units} onChange={e => setUnits(e.target.value)} placeholder="e.g. 12" />
          <Input label="Plate minutes" type="number" min={1} step={1} value={minutes} onChange={e => setMinutes(e.target.value)} placeholder="e.g. 243" />
          <Input label="Plate grams" type="number" min={0.1} step={0.1} value={grams} onChange={e => setGrams(e.target.value)} placeholder="e.g. 112.2" />
        </div>
        <div className="flex gap-3">
          <Button onClick={() => save(false)} disabled={saving || !units || !minutes}>{saving ? 'Saving…' : 'Save'}</Button>
          {(component?.platedUnits || component?.platedMinutes) && (
            <Button variant="outline" onClick={() => save(true)} disabled={saving}>Clear</Button>
          )}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Dialog>
  );
}
