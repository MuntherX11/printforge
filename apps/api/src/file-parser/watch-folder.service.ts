import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { allowedBody } from '../common/utils/validate-number';
import { type ComponentCreateInput, parseComponentCreate, parseProductCreate } from '../products/product-input';
import { assertSkuFree } from '../products/product-locks';
import { GcodeParserService } from './gcode-parser.service';
import { StlEstimatorService } from './stl-estimator.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The only keys POST /watch-folder/:id/import reads. The body used to be typed
 * inline and written to Prisma as-is, skipping product-input.ts: no length or
 * HTML check on the name, no SKU check, and any materialId. Any other key → 400.
 */
export const WATCH_IMPORT_KEYS = ['name', 'sku', 'materialId'] as const;

export interface WatchImportInput {
  name: string;
  sku: string | null;
  materialId: string | null;
}

/** Name and SKU follow parseProductCreate; materialId is an optional id. */
export function parseWatchImport(raw: unknown): WatchImportInput {
  const b = allowedBody(raw, WATCH_IMPORT_KEYS);
  const product = parseProductCreate({ name: b.name, sku: b.sku });
  const m = b.materialId;
  let materialId: string | null = null;
  if (m !== undefined && m !== null && m !== '') {
    if (typeof m !== 'string' || !m.trim() || m.trim().length > 64) throw new BadRequestException('"materialId" must be an id');
    materialId = m.trim();
  }
  return { name: product.name, sku: product.sku, materialId };
}

/** Grams and minutes, the product-input.ts bounds. */
const FILE_MAX = { grams: 100_000, minutes: 100_000 };

/**
 * A weight or time read from the file: missing, or not a positive finite
 * number, means unknown (0, as before); beyond the product bounds → 400.
 */
function fileNumber(raw: unknown, what: string, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (n > max) throw new BadRequestException(`The file's ${what} (${n}) is more than ${max}`);
  return Math.round(n * 1000) / 1000;
}

export interface PendingImport {
  id: string;
  filename: string;
  filePath: string;
  fileType: 'gcode' | 'stl';
  fileSize: number;
  analysis: any;
  status: 'pending' | 'imported' | 'dismissed';
  createdAt: Date;
}

@Injectable()
export class WatchFolderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchFolderService.name);
  private watcher: fs.FSWatcher | null = null;
  private pendingImports: Map<string, PendingImport> = new Map();
  private idCounter = 0;

  constructor(
    private prisma: PrismaService,
    private gcodeParser: GcodeParserService,
    private stlEstimator: StlEstimatorService,
  ) {}

  private get watchDir(): string {
    return process.env.WATCH_FOLDER || path.join(process.env.UPLOAD_DIR || '/app/uploads', 'watch');
  }

  async onModuleInit() {
    const dir = this.watchDir;
    if (!dir) return;

    // Create watch dir if it doesn't exist
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}

    // Process any existing files
    await this.scanExisting();

    // Start watching
    try {
      this.watcher = fs.watch(dir, (eventType, filename) => {
        if (eventType === 'rename' && filename) {
          // Delay slightly to let the file finish writing
          setTimeout(() => this.handleNewFile(filename), 1000);
        }
      });
      this.logger.log(`Watching folder: ${dir}`);
    } catch (err: any) {
      this.logger.warn(`Could not watch folder ${dir}: ${err.message}`);
    }
  }

  onModuleDestroy() {
    this.watcher?.close();
  }

  private async scanExisting() {
    const dir = this.watchDir;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        await this.handleNewFile(file);
      }
    } catch {}
  }

  private async handleNewFile(filename: string) {
    const lower = filename.toLowerCase();
    const isGcode = lower.endsWith('.gcode') || lower.endsWith('.gco') || lower.endsWith('.g');
    const isStl = lower.endsWith('.stl');

    if (!isGcode && !isStl) return;

    // Skip if already tracked
    for (const imp of this.pendingImports.values()) {
      if (imp.filename === filename && imp.status === 'pending') return;
    }

    const filePath = path.join(this.watchDir, filename);

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) return;

      const buffer = await fs.promises.readFile(filePath);
      let analysis: any;

      if (isGcode) {
        analysis = this.gcodeParser.parseHeader(buffer);
      } else {
        analysis = this.stlEstimator.analyze(buffer, 1.24, 20);
      }

      const id = `wi_${++this.idCounter}_${Date.now()}`;
      const pending: PendingImport = {
        id,
        filename,
        filePath,
        fileType: isGcode ? 'gcode' : 'stl',
        fileSize: stat.size,
        analysis,
        status: 'pending',
        createdAt: new Date(),
      };

      this.pendingImports.set(id, pending);
      this.logger.log(`Auto-detected: ${filename} (${isGcode ? 'G-code' : 'STL'}, ${(stat.size / 1024).toFixed(1)}KB)`);
    } catch (err: any) {
      this.logger.warn(`Failed to process ${filename}: ${err.message}`);
    }
  }

  /**
   * Get all pending imports (filePath omitted from public API response).
   */
  getPending(): Omit<PendingImport, 'filePath'>[] {
    return Array.from(this.pendingImports.values())
      .filter(i => i.status === 'pending')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ filePath: _, ...safe }) => safe);
  }

  /**
   * Get all imports including imported/dismissed (filePath omitted from public API response).
   */
  getAll(): Omit<PendingImport, 'filePath'>[] {
    return Array.from(this.pendingImports.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ filePath: _, ...safe }) => safe);
  }

  /**
   * Dismiss a pending import.
   */
  dismiss(id: string): boolean {
    const imp = this.pendingImports.get(id);
    if (!imp) return false;
    imp.status = 'dismissed';
    return true;
  }

  /**
   * Mark as imported (after user creates a product/job from it).
   */
  markImported(id: string): boolean {
    const imp = this.pendingImports.get(id);
    if (!imp) return false;
    imp.status = 'imported';
    return true;
  }

  /**
   * Import a watched file as a new product with BOM auto-populated.
   * POST /watch-folder/:id/import is ADMIN/OPERATOR, like every other product
   * write. The body goes through parseWatchImport and the component, when a
   * material is chosen, through parseComponentCreate's bounds. The SKU must be
   * free and the material must exist. Product and component are written in one
   * transaction. The file is claimed before the first await, so of two
   * imports of the same file only one gets past the pending check; if that
   * one fails, it hands the file back to pending (unless it was dismissed
   * meanwhile), and nothing else can.
   */
  async importAsProduct(id: string, body: unknown) {
    const imp = this.pendingImports.get(id);
    if (!imp || imp.status !== 'pending') return null;
    imp.status = 'imported';
    try {
      return await this.createProductFrom(imp, body);
    } catch (e) {
      if (imp.status === 'imported') imp.status = 'pending';
      throw e;
    }
  }

  /** importAsProduct's work, once the file is claimed. */
  private async createProductFrom(imp: PendingImport, body: unknown) {
    const params = parseWatchImport(body);

    const analysis = imp.analysis ?? {};
    const grams = fileNumber(
      imp.fileType === 'gcode' ? analysis.filamentUsedGrams : analysis.estimatedGrams,
      'filament weight in grams', FILE_MAX.grams,
    );
    const minutes = imp.fileType === 'gcode'
      ? Math.round(fileNumber(analysis.estimatedTimeSeconds, 'print time in seconds', FILE_MAX.minutes * 60) / 60)
      : Math.round(fileNumber(analysis.estimatedMinutes, 'print time in minutes', FILE_MAX.minutes));

    let component: ComponentCreateInput | null = null;
    if (params.materialId) {
      if (grams < 0.1) {
        throw new BadRequestException(
          "This file has no filament weight, so it can't get a component. Import it without a material and add the component on the product page.",
        );
      }
      component = parseComponentCreate({
        description: imp.filename, materialId: params.materialId, gramsUsed: grams, printMinutes: minutes, quantity: 1,
      });
    }

    await assertSkuFree(this.prisma, params.sku);
    if (component) {
      const material = await this.prisma.material.findUnique({ where: { id: component.materialId }, select: { id: true } });
      if (!material) throw new NotFoundException('Material not found');
    }

    return this.prisma.$transaction(async (tx: any) => {
      const product = await tx.product.create({
        data: { name: params.name, sku: params.sku, estimatedGrams: grams, estimatedMinutes: minutes },
        select: { id: true },
      });
      if (component) {
        await tx.productComponent.create({
          data: {
            productId: product.id,
            variantId: null,
            materialId: component.materialId,
            description: component.description,
            gramsUsed: component.gramsUsed,
            printMinutes: component.printMinutes,
            quantity: component.quantity,
            sortOrder: 0,
            stockConfirmedAt: new Date(),
          },
        });
      }
      return tx.product.findUnique({ where: { id: product.id }, include: { components: { include: { material: true } } } });
    });
  }
}
