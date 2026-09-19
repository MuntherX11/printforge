import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JobStatus } from '@printforge/types';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { lineDescription, mapLegacyVariantId, validatePair } from '../catalog-core/option-pair';
import { planFromBom, ProductionPlannerService } from '../catalog-core/production-planner.service';
import { pickSpools } from '../catalog-core/spool-picker';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { CostingService } from '../costing/costing.service';
import { lockOptions, TX_OPTS } from '../products/product-locks';
import { SettingsService } from '../settings/settings.service';
import { JobCompletionService } from '../stock-ledger/job-completion.service';
import { EventsGateway } from '../websocket/events.gateway';
import { materialLines, plateRows, reservationSummary, singlePlateFilename } from './job-builder';
import { reprintRows } from './job-reprint';
import { parseCreateJob, parseFail, parseReprint, parseUpdateJob } from './job-input';
import { JobPlanningService } from './job-planning.service';
import { buildFilamentPlan, jobDetailExtras } from './job-presenter';
import { JobSchedulingService } from './job-scheduling.service';

const ACTIVE = ['QUEUED', 'IN_PROGRESS', 'PAUSED'];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const NO_LONGER_ACTIVE = 'This job was already completed, failed or cancelled';

/** Minimal shape of a customer row returned via Prisma include. */
interface CustomerRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private costingService: CostingService,
    @Optional() private gateway: EventsGateway,
    private jobPlanning: JobPlanningService,
    private jobScheduling: JobSchedulingService,
    private completion: JobCompletionService,
    private resolver: BomResolverService,
    private planner: ProductionPlannerService,
    @Optional() private emailNotifications?: EmailNotificationService,
    @Optional() private whatsapp?: WhatsAppService,
    @Optional() private settingsService?: SettingsService,
  ) {}

  // ------------------------------------------------------------------ J1

  /**
   * J1 (§3.7 "Job creation"): linkage and pair validated, option rows locked FOR
   * SHARE as the transaction's first statement, the pair planned with
   * catalog-core (plates, per-slot grams by policy) and stored as JobPlate rows
   * and JobMaterial lines with their planned identity.
   */
  async create(body: unknown) {
    const dto = parseCreateJob(body);
    const isInternal = dto.purpose !== 'CUSTOMER';

    // Test/sample/waste prints may skip the order/product link; they still burn
    // filament, so they carry their own material lines instead.
    if (!isInternal && !dto.orderId && !dto.productId && !dto.variantId) {
      throw new BadRequestException('A production job must be linked to an order or a product');
    }
    if (isInternal && !dto.productId && !dto.materials.length) {
      throw new BadRequestException('A test print needs at least one filament line (spool + grams)');
    }

    // ---- linkage (§3.7)
    if (dto.orderItemId && !dto.orderId) throw new BadRequestException('An order line needs its order');
    let order: { orderNumber: string; customer: { name: string } | null } | null = null;
    if (dto.orderId) {
      order = await this.prisma.order.findUnique({
        where: { id: dto.orderId },
        select: { orderNumber: true, customer: { select: { name: true } } },
      });
      if (!order) throw new NotFoundException('Linked order not found');
    }
    const ctx = new CatalogRequestContext();
    let productId = dto.productId ?? null;
    let sizeOptionId = dto.sizeOptionId ?? null;
    let colourOptionId = dto.colourOptionId ?? null;
    if (dto.variantId && !sizeOptionId && !colourOptionId) {
      await this.resolver.preloadVariants([dto.variantId], ctx);
      const mapped = mapLegacyVariantId({ productId, variantId: dto.variantId }, (id) => ctx.variants.get(id) ?? null);
      ({ productId, sizeOptionId, colourOptionId } = mapped);
    }
    let lineBound = false;
    if (dto.orderItemId) {
      const item = await this.prisma.orderItem.findUnique({
        where: { id: dto.orderItemId },
        select: { id: true, orderId: true, productId: true, variantId: true, sizeOptionId: true, colourOptionId: true },
      });
      if (!item) throw new NotFoundException('Order line not found');
      if (item.orderId !== dto.orderId) throw new BadRequestException('That order line belongs to another order');
      await this.resolver.preloadVariants([item.variantId].filter((x): x is string => !!x), ctx);
      const eff = this.resolver.effectiveOptions(item, ctx);
      if (eff.skip || (item.productId ?? null) !== productId || eff.sizeOptionId !== sizeOptionId || eff.colourOptionId !== colourOptionId) {
        throw new BadRequestException("The job's product, size or colour doesn't match the order line");
      }
      lineBound = true;
    }

    // ---- explicit filament lines (test prints), validated before anything is created
    const explicitLines: Array<{ spoolId: string; materialId: string; gramsUsed: number; costPerGram: number }> = [];
    for (const [i, line] of dto.materials.entries()) {
      const spool = await this.prisma.spool.findUnique({
        where: { id: line.spoolId },
        select: { id: true, materialId: true, currentWeight: true, material: { select: { costPerGram: true } } },
      });
      if (!spool) throw new BadRequestException(`Filament line ${i + 1}: spool not found`);
      if (spool.currentWeight < line.gramsUsed) {
        throw new BadRequestException(
          `Filament line ${i + 1}: only ${spool.currentWeight.toFixed(0)} g left on that spool, ${line.gramsUsed} g requested`,
        );
      }
      explicitLines.push({ spoolId: spool.id, materialId: spool.materialId, gramsUsed: line.gramsUsed, costPerGram: spool.material?.costPerGram ?? 0 });
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // First statement: the option rows the pair is validated on (§3.1 rule 3).
      const optionIds = [sizeOptionId, colourOptionId].filter((x): x is string => !!x);
      if (optionIds.length) await lockOptions(tx, optionIds, 'SHARE');

      let config: Awaited<ReturnType<BomResolverService['requireConfig']>> | null = null;
      let names: { size: { name: string } | null; colour: { name: string } | null } = { size: null, colour: null };
      if (productId) {
        config = await this.resolver.requireConfig(productId, ctx, tx);
        const pairRows = validatePair(this.resolver.pairContext(config), sizeOptionId, colourOptionId, {
          audience: 'STAFF',
          allowInactive: lineBound,
        });
        names = { size: pairRows.size, colour: pairRows.colour };
      } else if (optionIds.length) {
        throw new BadRequestException('A size or colour needs a product');
      }

      const policy = dto.surplusPolicy ?? config?.product.surplusPolicy ?? 'KEEP_FOR_STOCK';
      let plates: any[] = [];
      let lines: any[] = explicitLines.map((l) => ({ ...l, colorIndex: 0 }));
      let reservation: ReturnType<typeof reservationSummary> | null = null;
      if (config && !explicitLines.length) {
        const bom = this.resolver.resolveWithConfig(config, { sizeOptionId, colourOptionId });
        const blocking = bom.problems.find((p) => ['NO_COMPONENTS', 'COMPONENT_NO_MATERIAL', 'SLOT_NO_MATERIAL'].includes(p.code));
        if (blocking && bom.components.length) throw new BadRequestException(blocking.message);
        for (const e of dto.plates ?? []) {
          if (!bom.components.some((c) => c.componentId === e.componentId)) {
            throw new BadRequestException(`That component isn't part of "${bom.label}"`);
          }
        }
        const plan = planFromBom(bom, { quantity: dto.quantityToProduce, surplusPolicy: policy, plates: dto.plates }, config.materials, ctx.planCache);
        if (plan.problems.length) {
          const c = bom.components.find((x) => x.componentId === plan.problems[0].componentId);
          throw new BadRequestException(`"${c?.description ?? 'A component'}" has no sliced data — add its grams and minutes or a plate layout`);
        }
        const needs = plan.filamentNeeds;
        const picks = pickSpools(needs, await this.planner.spoolsFor(needs), { reservedBySpool: await this.planner.reservedBySpool() });
        plates = plateRows(plan.components);
        lines = materialLines(plan.components, needs, picks);
        reservation = reservationSummary(needs, picks);
      }

      const name = dto.name
        || (order ? (order.customer?.name ? `${order.orderNumber} — ${order.customer.name}` : order.orderNumber) : '')
        || (config ? lineDescription(config.product, names.size, names.colour) : '')
        || (dto.purpose === 'TEST' ? 'Test print' : dto.purpose === 'SAMPLE' ? 'Sample print' : dto.purpose === 'WASTE' ? 'Waste / reprint' : 'Untitled Job');

      const job = await tx.productionJob.create({
        data: {
          name,
          status: 'QUEUED',
          productId,
          sizeOptionId,
          colourOptionId,
          variantId: sizeOptionId ?? colourOptionId,
          printerId: dto.printerId ?? config?.product.defaultPrinterId ?? null,
          assignedToId: dto.assignedToId ?? null,
          orderId: dto.orderId ?? null,
          orderItemId: dto.orderItemId ?? null,
          // Any requested file name is ignored for jobs with plates (§3.7).
          gcodeFilename: plates.length ? singlePlateFilename(plates) : dto.gcodeFilename ?? null,
          colorChanges: plates.length ? 0 : dto.colorChanges,
          quantityToProduce: dto.quantityToProduce,
          purpose: dto.purpose as any,
          surplusPolicy: plates.length ? (policy as any) : null,
          stockMode: (dto.stockMode ?? null) as any,
        },
      });
      if (plates.length) await tx.jobPlate.createMany({ data: plates.map((p) => ({ ...p, jobId: job.id })) });
      if (lines.length) await tx.jobMaterial.createMany({ data: lines.map((l) => ({ ...l, jobId: job.id })) });

      const full = await tx.productionJob.findUnique({
        where: { id: job.id },
        include: {
          printer: true,
          assignedTo: { select: { id: true, name: true } },
          materials: { include: { material: true, spool: true } },
          plates: { orderBy: { sortOrder: 'asc' } },
        },
      });
      return { ...full, reservation: reservation ?? { lines: lines.length, withSpool: lines.filter((l) => l.spoolId).length, short: [] } };
    }, TX_OPTS);
    return result;
  }

  // ------------------------------------------------------------------ J2

  /** J2: readiness of a pair and quantity, with the credit each component would earn (no order). */
  async preview(body: unknown) {
    return this.jobPlanning.previewJob(body);
  }

  // ------------------------------------------------------------ list / J3

  async findAll(query: PaginationDto, status?: string) {
    const validStatuses = ['QUEUED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];
    const where = status && validStatuses.includes(status) ? { status: status as JobStatus } : {};

    const [data, total] = await Promise.all([
      this.prisma.productionJob.findMany({
        where,
        ...paginate(query),
        include: {
          printer: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      }),
      this.prisma.productionJob.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  /** J3: the job, its pair (effectiveOptions), plates, surplus per component and picking list. */
  async findOne(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: {
        printer: true,
        assignedTo: { select: { id: true, name: true, email: true } },
        order: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true } } } },
        orderItem: true,
        materials: {
          include: {
            material: true,
            slicedMaterial: true,
            // Location matters as much as the spool id — the operator has to go and fetch it.
            spool: { include: { location: { select: { id: true, name: true } } } },
          },
        },
        plates: { orderBy: { sortOrder: 'asc' } },
        reprintOf: { select: { id: true, name: true, status: true } },
        reprints: { select: { id: true, name: true, status: true }, orderBy: { createdAt: 'desc' } },
        attachments: true,
      },
    });
    if (!job) throw new NotFoundException('Production job not found');
    const ctx = new CatalogRequestContext();
    const extras = await jobDetailExtras(job, this.resolver, ctx);
    return {
      ...job,
      ...extras.detail,
      filamentPlan: await buildFilamentPlan(job, extras.bom, this.planner, ctx),
    };
  }

  // ------------------------------------------------------------------ J8

  /** J8: allowlist only; a status change is a guarded transition (§3.7 "Updating a job"). */
  async update(id: string, body: unknown) {
    const dto = parseUpdateJob(body);
    const job = await this.prisma.productionJob.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!job) throw new NotFoundException('Production job not found');
    if (TERMINAL.includes(job.status)) {
      throw new BadRequestException(`Cannot modify a job in terminal state: ${job.status}`);
    }
    if (dto.printerId) {
      const p = await this.prisma.printer.findUnique({ where: { id: dto.printerId }, select: { id: true } });
      if (!p) throw new BadRequestException('Printer not found');
    }
    if (dto.assignedToId) {
      const u = await this.prisma.user.findUnique({ where: { id: dto.assignedToId }, select: { id: true } });
      if (!u) throw new BadRequestException('User not found');
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Guarded transition first; also re-checks "still active" for field edits.
      const data: Record<string, unknown> = {};
      let from = ACTIVE;
      if (dto.status) {
        data.status = dto.status;
        if (dto.status === 'IN_PROGRESS') {
          from = ['QUEUED', 'PAUSED'];
          data.startedAt = new Date();
        }
      }
      if (dto.printerId !== undefined) data.printerId = dto.printerId;
      if (dto.assignedToId !== undefined) data.assignedToId = dto.assignedToId;
      if (dto.printDuration !== undefined) data.printDuration = dto.printDuration;
      if (dto.filamentUsedMm !== undefined) data.filamentUsedMm = dto.filamentUsedMm;

      let flipped = await tx.productionJob.updateMany({ where: { id, status: { in: from } }, data });
      if (flipped.count === 0 && dto.status === 'IN_PROGRESS') {
        // Already printing: only the other fields apply.
        const { status: _s, startedAt: _t, ...rest } = data;
        flipped = await tx.productionJob.updateMany({ where: { id, status: 'IN_PROGRESS' }, data: rest });
      }
      if (flipped.count === 0) {
        const now = await tx.productionJob.findUnique({ where: { id }, select: { status: true } });
        throw new ConflictException(`This job was already ${String(now?.status ?? 'removed').toLowerCase().replace('_', ' ')} — reload`);
      }
      return tx.productionJob.findUnique({
        where: { id },
        include: { printer: true, materials: { include: { material: true } } },
      });
    }, TX_OPTS);
  }

  // ---------------------------------------------------------------- cost

  /**
   * Job cost. Jobs with plates: printDuration = the recorded duration, else
   * Σ plateMinutes × plateCount × 60, and no purge (plate grams include it).
   * Legacy jobs are unchanged.
   */
  async calculateCost(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { printer: true, materials: { include: { material: true } }, plates: true },
    });
    if (!job) throw new NotFoundException('Production job not found');

    const plates = (job as any).plates ?? [];
    const input = plates.length
      ? {
          ...job,
          printDuration: job.printDuration ?? plates.reduce((s: number, p: any) => s + p.plateMinutes * p.plateCount * 60, 0),
          colorChanges: 0,
          purgeWasteGrams: 0,
        }
      : job;
    const breakdown = await this.costingService.calculateJobCost(input as any);

    return this.prisma.productionJob.update({
      where: { id },
      data: {
        materialCost: breakdown.materialCost,
        machineCost: breakdown.machineCost,
        wasteCost: breakdown.wasteCost,
        overheadCost: breakdown.overheadCost,
        totalCost: breakdown.totalCost,
      },
    });
  }

  // -------------------------------------------------------- J4 / J5 facade

  previewPlan(orderId: string) {
    return this.jobPlanning.previewPlan(orderId);
  }

  createFromPlan(orderId: string, body: unknown, userId?: string | null) {
    return this.jobPlanning.createFromPlan(orderId, body, userId);
  }

  // ------------------------------------------------------------------ J6

  /** J6: the shared completion service; cost, broadcast and notification after commit. */
  async completeJob(id: string, userId?: string | null) {
    const result = (await this.completion.complete(id, { source: 'MANUAL', userId }))!;
    const job = result.job;

    await this.calculateCost(id).catch(() => {
      // Cost fields may already be populated or materials missing
    });
    this.gateway?.broadcastNotification({
      type: 'success',
      title: 'Job Completed',
      message: `"${job.name}" finished successfully.`,
    });
    if (job.orderId) {
      await this.notifyOrderCompletedIfAllDone(job.orderId).catch(() => {});
    }
    const { plates: _plates, ...rest } = job;
    return { ...rest, stockCredits: result.stockCredits, warnings: result.warnings };
  }

  private async notifyOrderCompletedIfAllDone(orderId: string) {
    const allJobs = await this.prisma.productionJob.findMany({
      where: { orderId },
      select: { status: true },
    });

    const allDone = allJobs.length > 0 && allJobs.every((j) => TERMINAL.includes(j.status));
    if (!allDone) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true },
    });
    if (!order) return;

    const notifyEnabled = await this.settingsService?.get('notify_order_completed', 'true') ?? 'true';
    if (notifyEnabled === 'false') return;

    const companyName = await this.settingsService?.get('company_name', 'PrintForge') ?? 'PrintForge';
    const customer = order.customer as CustomerRecord | null;

    if (customer?.email) {
      this.emailNotifications?.notifyCustomerOrderCompleted(customer.email, { orderNumber: order.orderNumber }).catch(() => {});
    }
    if (customer?.phone) {
      this.whatsapp?.sendOrderCompleted(customer.phone, { customerName: customer.name, orderNumber: order.orderNumber, companyName }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ J9

  /** J9: guarded transition first; proportional waste deducted atomically. Never credits stock. */
  async failJob(id: string, body: unknown) {
    const dto = parseFail(body);
    const failed = await this.prisma.$transaction(async (tx: any) => {
      const flipped = await tx.productionJob.updateMany({
        where: { id, status: { in: ACTIVE } },
        data: { status: 'FAILED', failureReason: dto.failureReason, failedAt: new Date(), wasteGrams: dto.wasteGrams },
      });
      if (flipped.count === 0) return null;
      const job = await tx.productionJob.findUnique({ where: { id }, include: { materials: true } });
      const totalPlanned = job.materials.reduce((s: number, m: any) => s + m.gramsUsed, 0);
      if (dto.wasteGrams > 0 && totalPlanned > 0) {
        for (const m of job.materials) {
          if (!m.spoolId) continue;
          const waste = (dto.wasteGrams * m.gramsUsed) / totalPlanned;
          await tx.$executeRaw(Prisma.sql`/* completion:spool */ UPDATE "Spool"
            SET "currentWeight" = GREATEST(0, "currentWeight" - ${waste}), "updatedAt" = NOW()
            WHERE "id" = ${m.spoolId}`);
        }
      }
      return tx.productionJob.findUnique({
        where: { id },
        include: { printer: true, materials: { include: { material: true } } },
      });
    }, TX_OPTS);
    if (!failed) {
      const exists = await this.prisma.productionJob.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Production job not found');
      throw new ConflictException(NO_LONGER_ACTIVE);
    }
    this.gateway?.broadcastNotification({
      type: 'error',
      title: 'Job Failed',
      message: `"${failed.name}" failed${dto.failureReason ? `: ${dto.failureReason}` : ''}.`,
    });
    return failed;
  }

  // ------------------------------------------------------------------ J7

  /**
   * J7: reprint a FAILED job, optionally a subset of its plates. Per component,
   * unitsRequired' = max(0, R − (U − U')); lines rebuilt from the chosen plates'
   * slot snapshot by policy and mapped to the original line of the same planned
   * identity (keeping a swap, spool, cost and slicedMaterialId).
   */
  async reprintJob(id: string, body?: unknown) {
    const chosenIn = parseReprint(body);
    const original: any = await this.prisma.productionJob.findUnique({
      where: { id },
      include: { materials: true, plates: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!original) throw new NotFoundException('Production job not found');
    if (original.status !== 'FAILED') throw new BadRequestException('Only failed jobs can be reprinted');

    // The pair: stored, or for a pre-release job its order line / legacy option (§3.2).
    let sizeOptionId = original.sizeOptionId ?? null;
    let colourOptionId = original.colourOptionId ?? null;
    if (!sizeOptionId && !colourOptionId) {
      const ctx = new CatalogRequestContext();
      await this.resolver.preloadVariants([original.variantId].filter(Boolean), ctx);
      if (original.orderItemId) await this.resolver.preloadOrderItems([original.orderItemId], ctx);
      const eff = this.resolver.effectiveOptions(original, ctx);
      if (!eff.skip) ({ sizeOptionId, colourOptionId } = eff);
    }

    const plates: any[] = original.plates ?? [];
    const counts = new Map<string, number>(plates.map((p) => [p.id, p.plateCount]));
    if (chosenIn) {
      counts.clear();
      for (const c of chosenIn) {
        const p = plates.find((x) => x.id === c.jobPlateId);
        if (!p) throw new BadRequestException('That plate is not part of this job');
        if (c.plateCount > p.plateCount) {
          throw new BadRequestException(`"${p.label}": at most ${p.plateCount} plates can be reprinted`);
        }
        counts.set(p.id, c.plateCount);
      }
      if (!counts.size) throw new BadRequestException('Choose at least one plate to reprint');
    }

    const slotMaterialIds = [...new Set(plates.flatMap((p) => ((p.slots as any[]) ?? []).map((x) => x.materialId)))];
    const mats = slotMaterialIds.length
      ? await this.prisma.material.findMany({ where: { id: { in: slotMaterialIds } }, select: { id: true, costPerGram: true } })
      : [];
    const { newPlates, lines } = reprintRows(original, counts, (id) => mats.find((m) => m.id === id)?.costPerGram ?? 0);

    return this.prisma.$transaction(async (tx: any) => {
      const job = await tx.productionJob.create({
        data: {
          name: `${original.name} (reprint)`,
          status: 'QUEUED',
          printerId: original.printerId,
          assignedToId: original.assignedToId,
          orderId: original.orderId,
          orderItemId: original.orderItemId,
          productId: original.productId,
          componentId: original.componentId,
          sizeOptionId,
          colourOptionId,
          variantId: original.variantId ?? sizeOptionId ?? colourOptionId,
          purpose: original.purpose,
          surplusPolicy: original.surplusPolicy,
          stockMode: original.stockMode,
          quantityToProduce: original.componentId && newPlates.length ? Math.max(1, newPlates[0].unitsRequired) : original.quantityToProduce,
          colorChanges: original.colorChanges,
          gcodeFilename: plates.length ? singlePlateFilename(newPlates) : original.gcodeFilename,
          reprintOfId: original.id,
        },
      });
      if (newPlates.length) await tx.jobPlate.createMany({ data: newPlates.map((p) => ({ ...p, jobId: job.id })) });
      if (lines.length) await tx.jobMaterial.createMany({ data: lines.map((l) => ({ ...l, jobId: job.id })) });
      return tx.productionJob.findUnique({
        where: { id: job.id },
        include: { printer: true, materials: true, plates: { orderBy: { sortOrder: 'asc' } } },
      });
    }, TX_OPTS);
  }

  // ---------------------------------------------------------------- misc

  async getFailureStats() {
    const [totalJobs, failedJobs, wasteAgg, reprintCount] = await Promise.all([
      this.prisma.productionJob.count(),
      this.prisma.productionJob.count({ where: { status: 'FAILED' } }),
      this.prisma.productionJob.aggregate({
        where: { status: 'FAILED' },
        _sum: { wasteGrams: true },
      }),
      this.prisma.productionJob.count({ where: { reprintOfId: { not: null } } }),
    ]);

    return {
      totalJobs,
      failedJobs,
      failureRate: totalJobs > 0 ? Math.round((failedJobs / totalJobs) * 10000) / 100 : 0,
      totalWasteGrams: wasteAgg._sum.wasteGrams || 0,
      reprintCount,
    };
  }

  async autoAssign() {
    return this.jobScheduling.autoAssign();
  }

  async getQueue() {
    return this.jobScheduling.getQueue();
  }
}
