'use client';

import { useCallback, useRef, useState } from 'react';
import { componentDryRunRequests, componentWriteRequests, type ComponentWrite, type ComponentWriteRequest } from '@printforge/types';
import { api } from '@/lib/api';
import type { ApiComponentWriteResult, ApiImpactPreview, ApiOpenLineImpact, Problem } from '@/lib/types/api';
import { errorText } from './options-ui';

export interface ComponentWriter {
  saving: boolean;
  /** Open lines the change would alter (dry run); `Save anyway` confirms them. */
  impact: ApiOpenLineImpact[] | null;
  error: string | null;
  /** Dry run, then the write when nothing is affected. The warnings once written; null otherwise. */
  submit: (w: ComponentWrite, fallback: string) => Promise<Problem[] | null>;
  /** `Save anyway`: the write the dry run held back, with confirm. */
  confirm: (fallback: string) => Promise<Problem[] | null>;
  clearImpact: () => void;
  reset: () => void;
}

function send<T>(req: ComponentWriteRequest): Promise<T> {
  return req.method === 'PATCH' ? api.patch<T>(req.path, req.body) : api.put<T>(req.path, req.body);
}

/** Runs the requests one after another and collects their warnings. */
async function writeAll(base: string, w: ComponentWrite, confirm: boolean): Promise<Problem[]> {
  const warnings: Problem[] = [];
  for (const req of componentWriteRequests(base, w, confirm)) {
    const r = await send<ApiComponentWriteResult>(req);
    warnings.push(...(r.warnings ?? []));
  }
  return warnings;
}

/**
 * A component's P10/P11 write as Edit component and the BOM filament picker
 * send it (spec §3.3): a filament change runs the dry run first and holds the
 * write while its open-line impact is shown; `confirm` then writes it with
 * `confirm: true`.
 */
export function useComponentWrite(productId: string, componentId: string | null): ComponentWriter {
  const [saving, setSaving] = useState(false);
  const [impact, setImpact] = useState<ApiOpenLineImpact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<ComponentWrite | null>(null);
  const base = componentId ? `/products/${productId}/components/${componentId}` : null;

  const submit = useCallback(async (w: ComponentWrite, fallback: string) => {
    if (!base) return null;
    setSaving(true);
    setError(null);
    try {
      let found: ApiOpenLineImpact[] = [];
      for (const req of componentDryRunRequests(base, w)) {
        found = [...found, ...((await send<ApiImpactPreview>(req)).impact ?? [])];
      }
      if (found.length) {
        pending.current = w;
        setImpact(found);
        return null;
      }
      return await writeAll(base, w, false);
    } catch (err) {
      setError(errorText(err, fallback));
      return null;
    } finally {
      setSaving(false);
    }
  }, [base]);

  const confirm = useCallback(async (fallback: string) => {
    const w = pending.current;
    if (!base || !w) return null;
    setSaving(true);
    setError(null);
    try {
      const warnings = await writeAll(base, w, true);
      pending.current = null;
      setImpact(null);
      return warnings;
    } catch (err) {
      setError(errorText(err, fallback));
      return null;
    } finally {
      setSaving(false);
    }
  }, [base]);

  const clearImpact = useCallback(() => {
    pending.current = null;
    setImpact(null);
  }, []);

  const reset = useCallback(() => {
    clearImpact();
    setError(null);
  }, [clearImpact]);

  return { saving, impact, error, submit, confirm, clearImpact, reset };
}
