import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Optional,
  InternalServerErrorException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { DiscordNotificationService } from '../communications/discord-notification.service';
import { generateNumber } from '../common/utils/number-generator';
import { getGenerator, listGenerators } from './generators/registry';
import { Semaphore } from './util/semaphore';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import type { Response } from 'express';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const ARTIFACT_DIR = path.join(UPLOAD_DIR, 'artifacts');

// Storage keys are 32 hex chars; nothing else is ever a valid on-disk name.
const STORAGE_KEY_RE = /^[a-f0-9]{32}$/;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

@Injectable()
export class ConfiguratorService {
  private readonly logger = new Logger(ConfiguratorService.name);
  // Cap concurrent CPU-bound generation across the shared host (spec §8).
  private readonly genLimiter = new Semaphore(
    Math.max(1, parseInt(process.env.CONFIGURATOR_CONCURRENCY || '3', 10)),
  );

  constructor(
    private prisma: PrismaService,
    @Optional() private settings?: SettingsService,
    @Optional() private discord?: DiscordNotificationService,
  ) {}

  // ---- Preview surface (read-only, NEVER writes to disk) ----

  generators() {
    return listGenerators();
  }

  choices(key: string) {
    return getGenerator(key).choices();
  }

  info(key: string, params: unknown) {
    const gen = getGenerator(key);
    return gen.info(gen.validate(params));
  }

  previewSvg(key: string, params: unknown): string {
    const gen = getGenerator(key);
    return gen.previewSvg(gen.validate(params));
  }

  // ---- The one state-changing customer route (spec §2/§3) ----

  async createOrder(
    customerId: string,
    dto: { generatorKey: string; params: unknown; quantity?: number },
  ) {
    const gen = getGenerator(dto.generatorKey);

    // 1. Server-authoritative validation. Throws 400 on bad input (spec §6).
    const spec = gen.validate(dto.params);
    const info = gen.info(spec);

    const quantity = Number.isInteger(dto.quantity) ? Number(dto.quantity) : 1;
    if (quantity < 1 || quantity > 50) {
      throw new BadRequestException('Quantity must be a whole number between 1 and 50');
    }

    // 2. Generate the heavy artifact ONCE, at commit, under a concurrency cap.
    let files;
    try {
      files = await this.genLimiter.run(() => gen.generate(spec));
    } catch (err: any) {
      if (err?.status === 503) throw new ServiceUnavailableException(err.message);
      this.logger.error(`Generation failed for ${dto.generatorKey}: ${err?.message}`);
      throw new InternalServerErrorException('Could not generate the model — please try again');
    }
    if (!files?.length) throw new InternalServerErrorException('Generator produced no files');

    // 3. Write each file under an OPAQUE server-generated key. No customer input
    //    ever reaches the path (spec §3a).
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    const written: Array<{ storageKey: string; filename: string; mime: string; size: number }> = [];
    try {
      for (const f of files) {
        const storageKey = randomUUID().replace(/-/g, ''); // 32 hex chars
        await fs.writeFile(path.join(ARTIFACT_DIR, storageKey), f.body);
        written.push({ storageKey, filename: f.filename, mime: f.mime, size: f.body.length });
      }
    } catch (err) {
      await this.cleanupFiles(written.map((w) => w.storageKey));
      throw new InternalServerErrorException('Could not store the generated model');
    }

    // 4. Pricing (rough estimate; staff can adjust the order later).
    const pricePerGram = parseFloat((await this.settings?.get('filament_price_per_gram', '0.05')) ?? '0.05');
    const markup = parseFloat((await this.settings?.get('markup_multiplier', '2.5')) ?? '2.5');
    const unitPrice = round3(Math.max(0, info.estimatedGrams) * pricePerGram * markup);
    const subtotal = round3(unitPrice * quantity);
    const taxRateRaw = parseFloat((await this.settings?.get('tax_rate', '0')) ?? '0');
    const taxRate = taxRateRaw >= 0 && taxRateRaw <= 100 ? taxRateRaw / 100 : 0;
    const tax = round3(subtotal * taxRate);
    const total = round3(subtotal + tax);

    // 5. Persist order + params + artifact metadata in one transaction. params is
    //    the source of truth; artifacts are derived data (spec §1).
    let orderNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { orderNumber = await generateNumber(this.prisma, 'ORD', 'order'); break; }
      catch (e: any) { if (e?.code !== 'P2002' || attempt === 4) throw e; }
    }
    if (!orderNumber) throw new InternalServerErrorException('Failed to generate order number');

    let order;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: {
            orderNumber: orderNumber!,
            customerId,
            status: 'PENDING',
            subtotal, tax, total,
            notes: `Configurator: ${gen.name} — ${info.label}`,
            items: {
              create: [{
                description: info.label,
                quantity,
                unitPrice,
                totalPrice: subtotal,
              }],
            },
          },
        });
        const configOrder = await tx.configOrder.create({
          data: {
            orderId: created.id,
            generatorKey: gen.key,
            params: spec as any, // validated, normalised spec
            status: 'GENERATED',
            artifacts: {
              create: written.map((w) => ({
                filename: w.filename,
                mime: w.mime,
                sizeBytes: w.size,
                storageKey: w.storageKey,
              })),
            },
          },
        });
        return { ...created, configOrderId: configOrder.id };
      });
    } catch (err) {
      // Roll back the files we wrote if the DB write fails.
      await this.cleanupFiles(written.map((w) => w.storageKey));
      throw err;
    }

    // Fire-and-forget staff notification (never blocks the response).
    this.discord?.notifyNewPortalOrder({
      orderNumber: order.orderNumber,
      customerName: 'Configurator customer',
      total: order.total,
      itemCount: quantity,
    }).catch(() => {});

    // Return the order reference ONLY — never the artifact (spec §3).
    return { orderId: order.id, orderNumber: order.orderNumber, total: order.total };
  }

  // ---- Staff-only views ----

  /**
   * Config submissions + artifact metadata for an order (no file bytes).
   * The opaque storageKey is deliberately never returned to any client — it is
   * an internal handle. Artifacts are addressed by their public `id` and served
   * only through the authorized download route.
   */
  async getForOrder(orderId: string) {
    const rows = await this.prisma.configOrder.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, generatorKey: true, params: true, status: true, createdAt: true,
        artifacts: {
          select: { id: true, filename: true, mime: true, sizeBytes: true, createdAt: true },
          orderBy: { filename: 'asc' },
        },
      },
    });
    // Belt-and-braces: strip any key that might slip through a future query change.
    return rows.map((r: any) => ({
      ...r,
      artifacts: (r.artifacts ?? []).map(({ id, filename, mime, sizeBytes, createdAt }: any) => ({
        id, filename, mime, sizeBytes, createdAt,
      })),
    }));
  }

  /**
   * Stream an artifact to an authenticated employee (spec §3b). The controller
   * enforces StaffGuard; here we resolve the opaque key and set a safe
   * Content-Disposition built from the stored (validated) filename.
   */
  async streamArtifact(artifactId: string, res: Response) {
    const artifact = await this.prisma.configArtifact.findUnique({
      where: { id: artifactId },
      include: { configOrder: { select: { orderId: true } } },
    });
    if (!artifact || !artifact.configOrder?.orderId) {
      throw new NotFoundException('Artifact not found');
    }
    // Defence in depth: the on-disk key must be an opaque token, never anything
    // derived from client input.
    if (!STORAGE_KEY_RE.test(artifact.storageKey)) {
      throw new NotFoundException('Artifact not found');
    }
    const filePath = path.join(ARTIFACT_DIR, artifact.storageKey);
    // Ensure the resolved path stays inside the artifact dir.
    const resolved = path.resolve(filePath);
    const rootWithSep = ARTIFACT_DIR.endsWith(path.sep) ? ARTIFACT_DIR : ARTIFACT_DIR + path.sep;
    if (!resolved.startsWith(rootWithSep)) throw new NotFoundException('Artifact not found');
    try {
      await fs.stat(resolved);
    } catch {
      throw new NotFoundException('Artifact file is missing');
    }

    const safeName = artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', artifact.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', String(artifact.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(resolved).pipe(res);
  }

  // ---- Retention (spec §8) ----

  /**
   * Delete artifact files + rows for orders in terminal states (DELIVERED /
   * CANCELLED) older than the retention window. Keeps the shared box from
   * growing without bound; params stay on the order so it can be regenerated.
   */
  async cleanupExpiredArtifacts(retentionDays = 90): Promise<{ removed: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const stale = await this.prisma.configArtifact.findMany({
      where: {
        createdAt: { lt: cutoff },
        configOrder: { order: { status: { in: ['DELIVERED', 'CANCELLED'] } } },
      },
      select: { id: true, storageKey: true },
    });
    if (stale.length === 0) return { removed: 0 };
    await this.cleanupFiles(stale.map((s) => s.storageKey));
    await this.prisma.configArtifact.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    this.logger.log(`Retention: removed ${stale.length} expired artifact(s)`);
    return { removed: stale.length };
  }

  private async cleanupFiles(storageKeys: string[]) {
    await Promise.all(
      storageKeys.map((key) =>
        fs.unlink(path.join(ARTIFACT_DIR, key)).catch(() => {}),
      ),
    );
  }
}
