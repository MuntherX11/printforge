import { Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Generator, GeneratedFile, GeneratorInfo, GeneratorUpload, UploadSlot } from './generator.interface';
import * as path from 'path';
import * as fs from 'fs/promises';
import { pathToFileURL } from 'url';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const ADDONS_DIR = path.join(UPLOAD_DIR, 'addons');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Contract version this host understands. Addons declare which they target. */
export const GENERATOR_API_VERSION = 1;

/** Shape an addon's server module must export (see docs/ADDON_GENERATORS.md). */
interface AddonGeneratorModule {
  apiVersion?: number;
  /** Upload slots the module accepts; the host enforces these before calling it. */
  uploads?: UploadSlot[];
  choices?: () => Record<string, unknown>;
  validate: (raw: unknown, uploads?: GeneratorUpload[]) => unknown;
  info: (spec: any) => GeneratorInfo;
  previewSvg?: (spec: any) => string;
  generate: (spec: any, uploads?: GeneratorUpload[]) => Promise<GeneratedFile[]> | GeneratedFile[];
}

const REQUIRED_FNS: Array<keyof AddonGeneratorModule> = ['validate', 'info', 'generate'];

// Hard ceilings the host enforces regardless of what an addon returns, so a
// buggy or greedy generator can't exhaust the shared box (spec §8).
const MAX_FILES = 12;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILENAME_RE = /^[a-zA-Z0-9._-]{1,120}$/;

/**
 * Wraps an addon-supplied module in the host's Generator contract, re-checking
 * everything that crosses the boundary. The addon owns validation + geometry;
 * PrintForge still owns the security envelope, so a sloppy addon degrades to a
 * clean 4xx/5xx instead of a vulnerability.
 *
 * TRUST NOTE: the module is executed in-process with API privileges. Addon
 * upload is ADMIN-only, so this matches the existing addon trust model
 * (internal/proprietary code). Do NOT enable this for third-party addons
 * without moving generation to an isolated sidecar.
 */
export class AddonGenerator implements Generator {
  private readonly logger = new Logger(AddonGenerator.name);

  constructor(
    readonly key: string,
    readonly name: string,
    readonly description: string,
    private readonly mod: AddonGeneratorModule,
  ) {}

  /** Upload slots declared by the addon module, if any. */
  get uploads(): UploadSlot[] | undefined {
    return Array.isArray(this.mod.uploads) ? this.mod.uploads : undefined;
  }

  choices(): Record<string, unknown> {
    try {
      return this.mod.choices ? this.mod.choices() : {};
    } catch (err: any) {
      this.logger.warn(`[${this.key}] choices() failed: ${err?.message}`);
      return {};
    }
  }

  validate(raw: unknown, uploads?: GeneratorUpload[]): unknown {
    let spec: unknown;
    try {
      spec = this.mod.validate(raw, uploads);
    } catch (err: any) {
      // Any throw from an addon's validator is a client error, never a 500.
      throw new BadRequestException(shortMessage(err));
    }
    if (!spec || typeof spec !== 'object') {
      throw new BadRequestException('Generator returned an invalid specification');
    }
    return spec;
  }

  info(spec: any): GeneratorInfo {
    try {
      const out = this.mod.info(spec);
      return {
        dimensions: {
          width: finite(out?.dimensions?.width),
          height: finite(out?.dimensions?.height),
          depth: finite(out?.dimensions?.depth),
        },
        warnings: Array.isArray(out?.warnings) ? out.warnings.map((w) => String(w).slice(0, 300)).slice(0, 20) : [],
        label: String(out?.label ?? this.name).slice(0, 120),
        estimatedGrams: Math.max(0, finite(out?.estimatedGrams)),
      };
    } catch (err: any) {
      throw new BadRequestException(shortMessage(err));
    }
  }

  previewSvg(spec: any): string {
    if (!this.mod.previewSvg) return '';
    try {
      const svg = String(this.mod.previewSvg(spec) ?? '');
      // The addon builds this server-side, but never trust it into the browser
      // unfiltered — strip anything scriptable (spec §4).
      if (/<script|javascript:|\son[a-z]+\s*=/i.test(svg)) {
        this.logger.warn(`[${this.key}] previewSvg returned scriptable content — suppressed`);
        return '';
      }
      return svg;
    } catch (err: any) {
      throw new BadRequestException(shortMessage(err));
    }
  }

  async generate(spec: any, uploads?: GeneratorUpload[]): Promise<GeneratedFile[]> {
    let files: GeneratedFile[];
    try {
      files = await this.mod.generate(spec, uploads);
    } catch (err: any) {
      this.logger.error(`[${this.key}] generate() failed: ${err?.message}`);
      throw new InternalServerErrorException('Could not generate the model');
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new InternalServerErrorException('Generator produced no files');
    }
    if (files.length > MAX_FILES) {
      throw new InternalServerErrorException(`Generator returned too many files (${files.length})`);
    }
    // Re-validate every file crossing the boundary: the filename becomes a
    // download header and must never look like a path (spec §3a).
    return files.map((f, i) => {
      const body = f?.body;
      if (!Buffer.isBuffer(body)) {
        throw new InternalServerErrorException(`Generator file #${i + 1} is not a Buffer`);
      }
      if (body.length === 0 || body.length > MAX_FILE_BYTES) {
        throw new InternalServerErrorException(`Generator file #${i + 1} has an invalid size`);
      }
      const filename = path.basename(String(f?.filename ?? `part-${i + 1}.bin`)).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!FILENAME_RE.test(filename)) {
        throw new InternalServerErrorException(`Generator file #${i + 1} has an unusable filename`);
      }
      return { filename, mime: String(f?.mime ?? 'application/octet-stream').slice(0, 100), body };
    });
  }
}

function finite(n: any): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** Keep addon error text short and stack-free before it reaches a client (spec §6). */
function shortMessage(err: any): string {
  const msg = String(err?.message ?? 'Invalid parameters');
  return msg.split('\n')[0].slice(0, 200);
}

/**
 * Discover and load server generators from installed addons.
 * An addon opts in by shipping `addon.json` with:
 *   "generator": { "module": "server/generator.mjs", "apiVersion": 1 }
 */
export async function loadAddonGenerators(): Promise<Generator[]> {
  const logger = new Logger('AddonGeneratorLoader');
  const out: Generator[] = [];

  let slugs: string[];
  try {
    slugs = await fs.readdir(ADDONS_DIR);
  } catch {
    return out; // no addons installed yet
  }

  for (const slug of slugs) {
    if (!SLUG_RE.test(slug)) continue;
    const manifestPath = path.join(ADDONS_DIR, slug, 'addon.json');
    let manifest: any;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      continue; // not an addon dir, or unreadable manifest
    }
    const genDecl = manifest?.generator;
    if (!genDecl?.module) continue; // UI-only addon — nothing to load

    if (genDecl.apiVersion && Number(genDecl.apiVersion) !== GENERATOR_API_VERSION) {
      logger.warn(`[${slug}] generator apiVersion ${genDecl.apiVersion} != ${GENERATOR_API_VERSION}; skipped`);
      continue;
    }

    // Resolve the module path INSIDE the addon dir — reject traversal.
    const addonRoot = path.join(ADDONS_DIR, slug);
    const modPath = path.resolve(addonRoot, String(genDecl.module));
    const rootWithSep = addonRoot.endsWith(path.sep) ? addonRoot : addonRoot + path.sep;
    if (!modPath.startsWith(rootWithSep)) {
      logger.warn(`[${slug}] generator module escapes the addon directory; skipped`);
      continue;
    }

    try {
      await fs.access(modPath);
      // Dynamic import keeps ESM addon modules loadable from the CJS API build.
      const mod: AddonGeneratorModule = await import(pathToFileURL(modPath).href);
      const missing = REQUIRED_FNS.filter((fn) => typeof (mod as any)[fn] !== 'function');
      if (missing.length) {
        logger.warn(`[${slug}] generator module missing: ${missing.join(', ')}; skipped`);
        continue;
      }
      out.push(
        new AddonGenerator(
          slug,
          String(manifest.name ?? slug),
          String(manifest.description ?? ''),
          mod,
        ),
      );
      logger.log(`Loaded server generator from addon "${slug}"`);
    } catch (err: any) {
      logger.warn(`[${slug}] failed to load generator: ${err?.message}`);
    }
  }

  return out;
}
