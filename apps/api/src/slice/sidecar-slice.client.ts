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

/** One model on a mixed plate (v2.19.0): a part of an order, with the copies asked for. */
export interface SidecarSliceInput {
  inputPath: string;
  kind: 'stl' | '3mf';
  copies: number;
}

/**
 * The second request shape: 1..24 models of ONE filament sliced onto one plate
 * with the printer's machine and process. A 3MF input gives only its shape. The
 * answer carries `X-Input-Units`: the units the slicer placed per input, in
 * request order (an entry can be 0 when the plate was too full).
 */
export interface SidecarMixedSliceRequest {
  inputs: SidecarSliceInput[];
  machine: SidecarPreset;
  process: SidecarPreset;
  /** exactly one */
  filaments: SidecarFilament[];
  siblings?: SidecarPreset[];
}

export interface SidecarSliceError {
  ok: false;
  code: string;
  message: string;
  exitCode: number | null;
  logTail: string;
  /** Mixed request: the index of the input that is to blame, when one is. */
  input?: number | null;
}

export type SidecarSliceResult =
  | { ok: true; gcode: Buffer; plateFiles: number | null; /** mixed request only; null when the header is missing or unreadable */ inputUnits?: number[] | null }
  | SidecarSliceError;

/** `X-Input-Units: [3,0,12]` → whole numbers from 0, or null when it is not that. */
export function parseInputUnits(header: string | null | undefined): number[] | null {
  if (!header) return null;
  try {
    const v: unknown = JSON.parse(header);
    return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0) ? (v as number[]) : null;
  } catch {
    return null;
  }
}

export const SLICE_TIMEOUT_MS = 330_000;

const codeFor = (status: number): string => {
  if (status === 504) return SliceErrorCode.TIMED_OUT;
  if (status === 409) return 'SLICER_BUSY';
  if (status === 400) return 'BAD_SLICE_INPUT';
  return 'SLICER_FAILED';
};

/** The process exit code is the 8-bit form of OrcaSlicer's negative CLI codes (239 = -17). */
const signedExit = (code: number): number => (code > 127 ? code - 256 : code);

export const SLICER_TIMED_OUT_SENTENCE = 'The slicer took too long and was stopped; try fewer units';
export const SLICER_STOPPED_SENTENCE = 'The slicer stopped with an error';

/**
 * One plain sentence for an OrcaSlicer CLI failure. `exitCode` null = it was
 * stopped for taking too long. The exit code alone decides the sentence;
 * `logTail` is part of the signature so a later rule can read it.
 */
export function orcaFailureSentence(exitCode: number | null, _logTail: string = ''): string {
  if (exitCode === null || !Number.isFinite(exitCode)) return SLICER_TIMED_OUT_SENTENCE;
  const code = signedExit(exitCode);
  switch (code) {
    case -3: return 'The model file could not be read';
    case -5: return 'A slicer preset could not be loaded';
    case -14: return 'The slicer ran out of memory; try fewer units';
    case -15:
    case -16: return 'This project is for a printer the slicer does not support';
    case -17: return 'The process preset does not match this printer; set a default process for it in Settings › Slicer';
    case -18: return 'This project has settings the slicer cannot use; re-save it in your current OrcaSlicer';
    case -21: return 'The slicer could not arrange the units on the plate; try fewer units';
    case -50: return 'Nothing fits on the plate; the model may be larger than the bed';
    case -51:
    case -52: return "The model does not pass the slicer's checks (it may sit outside the bed)";
    default:
      if (code <= -100 && code >= -104) return 'The slicer failed while slicing this model';
      return `${SLICER_STOPPED_SENTENCE} (code ${code})`;
  }
}

/** Most characters of raw slicer output kept on a run (its end is what says why). */
export const ERROR_DETAIL_MAX = 4000;

/**
 * What a failed sidecar call writes on the run: `error` is what the staff
 * reads, `detail` the slicer's raw output (null when there is none). An
 * OrcaSlicer failure or timeout becomes a plain sentence; the other codes
 * (unreachable, busy, bad input) already carry one and keep their code.
 */
export function sidecarFailure(out: SidecarSliceError): { error: string; detail: string | null } {
  const logTail = (out.logTail ?? '').trim();
  const raw = [(out.message ?? '').trim(), logTail].filter(Boolean).join('\n').slice(-ERROR_DETAIL_MAX) || null;
  if (out.code === SliceErrorCode.TIMED_OUT) return { error: orcaFailureSentence(null, logTail), detail: logTail ? raw : null };
  if (out.code === 'SLICER_FAILED') {
    // Without an exit code the slicer never ran to an end we can name (the sidecar itself failed).
    const error = typeof out.exitCode === 'number' ? orcaFailureSentence(out.exitCode, logTail) : SLICER_STOPPED_SENTENCE;
    return { error, detail: raw };
  }
  return { error: `${out.code}: ${out.message}`, detail: logTail ? raw : null };
}

@Injectable()
export class SidecarSliceClient {
  private readonly logger = new Logger(SidecarSliceClient.name);

  get baseUrl(): string {
    return (process.env.SLICER_URL || '').trim().replace(/\/+$/, '');
  }

  async slice(req: SidecarSliceRequest | SidecarMixedSliceRequest): Promise<SidecarSliceResult> {
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
      return {
        ok: true, gcode: Buffer.from(await res.arrayBuffer()), plateFiles: Number.isFinite(plateFiles) && plateFiles > 0 ? plateFiles : null,
        inputUnits: parseInputUnits(res.headers.get('X-Input-Units')),
      };
    }
    let body: { error?: unknown; exitCode?: unknown; logTail?: unknown; input?: unknown } = {};
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
      input: typeof body.input === 'number' && Number.isInteger(body.input) && body.input >= 0 ? body.input : null,
    };
  }
}
