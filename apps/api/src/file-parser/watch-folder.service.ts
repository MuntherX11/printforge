import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { GcodeParserService } from './gcode-parser.service';
import { StlEstimatorService } from './stl-estimator.service';
import * as fs from 'fs';
import * as path from 'path';

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
   * Get all pending imports.
   */
  getPending(): PendingImport[] {
    return Array.from(this.pendingImports.values())
      .filter(i => i.status === 'pending')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get all imports (including imported/dismissed).
   */
  getAll(): PendingImport[] {
    return Array.from(this.pendingImports.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
   */
  async importAsProduct(id: string, params: {
    name: string;
    sku?: string;
    materialId?: string;
  }) {
    const imp = this.pendingImports.get(id);
    if (!imp || imp.status !== 'pending') return null;

    const analysis = imp.analysis;

    let estimatedGrams = 0;
    let estimatedMinutes = 0;

    if (imp.fileType === 'gcode') {
      estimatedGrams = analysis.filamentUsedGrams || 0;
      estimatedMinutes = analysis.estimatedTimeSeconds ? Math.round(analysis.estimatedTimeSeconds / 60) : 0;
    } else {
      estimatedGrams = analysis.estimatedGrams || 0;
      estimatedMinutes = analysis.estimatedMinutes || 0;
    }

    // Create product
    const product = await this.prisma.product.create({
      data: {
        name: params.name,
        sku: params.sku || undefined,
        estimatedGrams,
        estimatedMinutes,
        components: params.materialId ? {
          create: [{
            materialId: params.materialId,
            description: imp.filename,
            gramsUsed: estimatedGrams,
            printMinutes: estimatedMinutes,
            quantity: 1,
            sortOrder: 0,
          }],
        } : undefined,
      },
      include: { components: { include: { material: true } } },
    });

    imp.status = 'imported';
    return product;
  }
}
