import { Injectable, Logger } from '@nestjs/common';
import { SliceErrorCode } from '@printforge/types';

/**
 * `POST ${SLICER_URL}/slice` (plan "Sidecar contract"): the request names the
 * source file relative to the uploads volume, the kind, the copies and the raw
 * presets; the answer is the plate's G-code bytes, or `{error, exitCode,
 * logTail}` with 400 (bad input / unresolvable chain), 409 (busy), 504
 * (timeout) or 500 (Orca crashed). One slice takes up to 300 s in the
 * container, so the client waits 330 s. A refused connection or no SLICER_URL
 * is SLICER_UNAVAILABLE; the processor marks the run FAILED with that code.
 */

export interface SidecarPreset {
  raw: Record<string, unknown>;
}

export interface SidecarFilament extends SidecarPreset {
  /** Material.density as text, e.g. "1.24" (the sidecar writes it as `filament_density`). */
  density: string;
}

export interface SidecarSliceRequest {
  /** Attachment.storagePath: relative to the uploads volume, forward slashes. */
  inputPath: string;
  kind: 'stl' | '3mf';
  copies: number;
  machine?: SidecarPreset;
  process?: SidecarPreset;
  filaments: SidecarFilament[];
  siblings?: SidecarPreset[];
}

export interface SidecarSliceError {
  ok: false;
  code: string;
  message: string;
  exitCode: number | null;
  logTail: string;
}

export type SidecarSliceResult = { ok: true; gcode: Buffer; plateFiles: number | null } | SidecarSliceError;

export const SLICE_TIMEOUT_MS = 330_000;

const codeFor = (status: number): string => {
  if (status === 504) return SliceErrorCode.TIMED_OUT;
  if (status === 409) return 'SLICER_BUSY';
  if (status === 400) return 'BAD_SLICE_INPUT';
  return 'SLICER_FAILED';
};

@Injectable()
export class SidecarSliceClient {
  private readonly logger = new Logger(SidecarSliceClient.name);

  get baseUrl(): string {
    return (process.env.SLICER_URL || '').trim().replace(/\/+$/, '');
  }

  async slice(req: SidecarSliceRequest): Promise<SidecarSliceResult> {
    const base = this.baseUrl;
    if (!base) return { ok: false, code: SliceErrorCode.SLICER_UNAVAILABLE, message: 'The slicer container is not configured (SLICER_URL)', exitCode: null, logTail: '' };
    let res: Response;
    try {
      res = await fetch(`${base}/slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(SLICE_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error & { name?: string };
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      this.logger.warn(`slicer POST /slice ${timedOut ? 'timed out' : 'unreachable'}: ${e?.message ?? err}`);
      return timedOut
        ? { ok: false, code: SliceErrorCode.TIMED_OUT, message: `The slicer did not answer within ${Math.round(SLICE_TIMEOUT_MS / 1000)} s`, exitCode: null, logTail: '' }
        : { ok: false, code: SliceErrorCode.SLICER_UNAVAILABLE, message: 'The slicer container is unreachable', exitCode: null, logTail: '' };
    }
    if (res.ok) {
      const plateFiles = Number(res.headers.get('X-Plate-Files'));
      return { ok: true, gcode: Buffer.from(await res.arrayBuffer()), plateFiles: Number.isFinite(plateFiles) && plateFiles > 0 ? plateFiles : null };
    }
    let body: { error?: unknown; exitCode?: unknown; logTail?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* a non-JSON error body: the status is all we know */
    }
    const message = typeof body.error === 'string' && body.error ? body.error : `The slicer answered ${res.status}`;
    this.logger.warn(`slicer POST /slice answered ${res.status}: ${message}`);
    return {
      ok: false,
      code: codeFor(res.status),
      message,
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
      logTail: typeof body.logTail === 'string' ? body.logTail : '',
    };
  }
}
