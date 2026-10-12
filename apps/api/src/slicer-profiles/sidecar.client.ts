import { Injectable, Logger } from '@nestjs/common';
import type { SlicerHealth, SlicerProfileKind, SlicerStockPresetDto } from '@printforge/types';
import type { PresetJson } from './bundle-import';

/**
 * Tiny fetch wrapper over the slicer sidecar (`SLICER_URL`, the
 * `printforge-slicer` container). Every call has a 3 s budget and never
 * throws: an unreachable container degrades to `reachable: false` / null so
 * Settings still loads and an import still lands (the chain check is then
 * deferred to the first slice).
 */

export interface PresetForCheck {
  kind: SlicerProfileKind;
  name: string;
  json: PresetJson;
}

export interface ProfileCheckResult {
  ok: boolean;
  /** Preset names whose `inherits` chain the sidecar cannot flatten to a root. */
  unresolved: string[];
}

const TIMEOUT_MS = 3000;
const STOCK_LIST_LIMIT = 50;

@Injectable()
export class SidecarClient {
  private readonly logger = new Logger(SidecarClient.name);

  /** Base URL without a trailing slash; empty when the sidecar is not configured. */
  get baseUrl(): string {
    return (process.env.SLICER_URL || '').trim().replace(/\/+$/, '');
  }

  async health(): Promise<SlicerHealth> {
    const body = await this.request<{ ok?: unknown; orcaVersion?: unknown }>('GET', '/health');
    if (!body || body.ok === false) return { reachable: false, orcaVersion: null };
    return { reachable: true, orcaVersion: typeof body.orcaVersion === 'string' ? body.orcaVersion : null };
  }

  /** Null when the sidecar did not answer (unreachable, timed out, or a non-2xx). */
  async checkProfiles(presets: PresetForCheck[]): Promise<ProfileCheckResult | null> {
    const body = await this.request<{ ok?: unknown; unresolved?: unknown }>('POST', '/profiles/check', {
      presets: presets.map((p) => ({ kind: p.kind.toLowerCase(), name: p.name, json: p.json })),
    });
    if (!body) return null;
    const unresolved = Array.isArray(body.unresolved) ? body.unresolved.filter((n): n is string => typeof n === 'string') : [];
    return { ok: body.ok === true && unresolved.length === 0, unresolved };
  }

  /**
   * The presets bundled with OrcaSlicer that a user can pick, filtered by a
   * case-insensitive substring of the name. Null when the sidecar did not answer.
   */
  async listStock(kind: SlicerProfileKind, q: string): Promise<SlicerStockPresetDto[] | null> {
    const query = new URLSearchParams({ q, limit: String(STOCK_LIST_LIMIT) });
    const body = await this.request<{ presets?: unknown }>('GET', `/profiles/${kind.toLowerCase()}?${query}`);
    if (!body) return null;
    const presets: unknown[] = Array.isArray(body.presets) ? body.presets : [];
    return presets
      .filter((p): p is { name: string; vendor?: unknown } => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
      .map((p) => ({ name: p.name, vendor: typeof p.vendor === 'string' ? p.vendor : '' }));
  }

  /** Whether OrcaSlicer bundles a preset of that kind and name. Null when the sidecar did not answer. */
  async hasStock(kind: SlicerProfileKind, name: string): Promise<boolean | null> {
    const res = await this.call('GET', `/profiles/${kind.toLowerCase()}/${encodeURIComponent(name)}`);
    if (!res) return null;
    if (res.status === 404) return false;
    return res.ok ? true : null;
  }

  private async request<T>(method: 'GET' | 'POST', route: string, payload?: unknown): Promise<T | null> {
    const res = await this.call(method, route, payload);
    if (!res) return null;
    if (!res.ok) {
      this.logger.warn(`slicer ${method} ${route} answered ${res.status}`);
      return null;
    }
    return res.body as T;
  }

  /** Null when the sidecar is not configured, unreachable, timed out or answered something that is not JSON. */
  private async call(method: 'GET' | 'POST', route: string, payload?: unknown): Promise<{ status: number; ok: boolean; body: unknown } | null> {
    const base = this.baseUrl;
    if (!base) return null;
    try {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { status: res.status, ok: res.ok, body: await res.json() };
    } catch (err) {
      this.logger.warn(`slicer ${method} ${route} unreachable: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }
}
