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
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!component) return;
    setUnits(component.platedUnits ? String(component.platedUnits) : '');
    setMinutes(component.platedMinutes ? String(component.platedMinutes) : '');
    setGrams(component.platedGrams ? String(component.platedGrams) : '');
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
      if (res?.filamentGrams) setGrams(String(Math.round(res.filamentGrams * 100) / 100));
      toast('success', 'Read time and grams from the file — type how many units are on the plate');
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
