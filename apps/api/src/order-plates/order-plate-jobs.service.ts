import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrderPlanJobsResult, OrderPlanWarning } from '@printforge/types';
import { BomResolverService, type ResolvedComponent, type ResolvedLayout } from '../catalog-core/bom-resolver.service';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { planFromBom, ProductionPlannerService } from '../catalog-core/production-planner.service';
import { pickSpools } from '../catalog-core/spool-picker';
import { PrismaService } from '../common/prisma/prisma.service';
import { materialLines, plateRows, singlePlateFilename } from '../production/job-builder';
import { assertPlannable } from '../production/job-plan-rules';
import type { RowPlan } from '../production/job-planning.service';
import { lockOrderPlan } from '../production/job-transitions';
import { lockOptions, TX_OPTS } from '../products/product-locks';
import { ProductStockService } from '../stock-ledger/product-stock.service';
import { OrderNeedsService } from './order-needs.service';
import { parseNoBody } from './order-plate-input';
import { liveJobsOf, type PlateRow, type StoredItem } from './order-plate-model';
import { GONE_FROM_PLAN } from './order-plate-rules';
import { plateLabel } from './order-plate-view';

/**
 * Jobs from the sliced plates of an order (v2.19.0): every DONE plate that has
 * no jobs yet becomes one job per part on it. The jobs of one plate carry its
 * id (`orderPlateId`) — they are one physical print (production/job-siblings.ts).
 *
 * It runs like J5 (JobPlanningService.createFromPlan): under the order's plan
 * lock, on the plan recomputed inside it, everything checked before anything
 * is written, and with the same builders — a job has a JobPlate with a slot
 * snapshot and JobMaterial lines with a spool pick, exactly as a planned job
 * has. Its plate row holds the units the slicer really placed and the part's
 * share of the plate's minutes and grams, so the jobs of a plate add up to the
 * plate.
 *
 * A plate may hold more than the order still needs (a ×10 file for 6 units):
 * that is a warning of the plan, never a block. The job then delivers what the
 * order needs and the rest is surplus, by the product's surplus policy, as for
 * a planned job. A part of which the order needs nothing more gets no job and
 * a warning; the other parts and plates get theirs.
 *
 * Printed stock: the suggested `fromStock` of a row is allocated here, as the
 * production plan would, but only for the rows these plates print (and not for
 * a row whose suggestion has a planning problem — the rule of
 * planWithSuggestions). The next plan sees the allocation and suggests none
 * again. An order that printed stock covers in full has no plate to make jobs
 * from: that stays with Plan Production.
 */

export const NOTHING_TO_CREATE = 'No sliced plate is waiting for jobs — slice a plate first. If printed stock covers the whole order, use Plan Production instead';

interface Work {
  plate: PlateRow;
  item: StoredItem;
  rp: RowPlan;
  /** Units the plate prints of this part. */
  units: number;
  /** Units of them the order needs (the rest is surplus). */
  required: number;
  component: ResolvedComponent;
  layout: ResolvedLayout;
}

/** The plate as a layout of the part: what the job planner's builders read. */
function plateAsLayout(plate: PlateRow, item: StoredItem, c: ResolvedComponent, label: string): ResolvedLayout {
  const grams = item.grams ?? 0;
  const slotGrams = new Map<number, number>();
  if (c.slots.length === 1) {
    // One colour: everything the file used is that slot's, whatever index the part gives it
    // (a one-slot project printed alone reports tool 0; the part's slot need not be 0).
    slotGrams.set(c.slots[0].colorIndex, grams);
  } else if (item.slotGrams && Object.keys(item.slotGrams).length) {
    // A project's file says what each colour used.
    for (const s of c.slots) slotGrams.set(s.colorIndex, item.slotGrams[String(s.colorIndex)] ?? 0);
  } else {
    const sum = c.slots.reduce((t, s) => t + s.gramsPerUnit, 0);
    for (const s of c.slots) slotGrams.set(s.colorIndex, sum > 0 ? (grams * s.gramsPerUnit) / sum : grams / Math.max(1, c.slots.length));
  }
  return {
    layoutId: null, label, unitsPerPlate: item.unitsSliced ?? 0, plateMinutes: item.minutes ?? 0, plateGrams: grams, slotGrams,
    attachmentId: plate.attachmentId, gcodeFilename: plate.gcodeFilename, colorChanges: plate.colorChanges,
    ...(plate.printerId ? { printerId: plate.printerId, printerName: plate.printerName } : {}),
  };
}

@Injectable()
export class OrderPlateJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly needs: OrderNeedsService,
    private readonly resolver: BomResolverService,
    private readonly planner: ProductionPlannerService,
    private readonly stock: ProductStockService,
  ) {}

  async createJobs(orderId: string, body: unknown, userId: string | null = null): Promise<OrderPlanJobsResult> {
    parseNoBody(body);
    // The parts' files are read before the lock, never inside the transaction.
    const files = await this.needs.prepare(orderId);
    return this.prisma.$transaction(async (tx: any) => {
      await lockOrderPlan(tx, orderId);
      // Read after the lock, as J5 does: a cancel is either seen here or waits and returns what this allocates.
      const current = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
      if (!current) throw new NotFoundException('Order not found');
      assertPlannable(current.status);
      const lineOptions = await tx.orderItem.findMany({ where: { orderId }, select: { variantId: true, sizeOptionId: true, colourOptionId: true } });
      const optionIds = [...new Set(lineOptions.flatMap((i: any) => [i.variantId, i.sizeOptionId, i.colourOptionId]).filter(Boolean))] as string[];
      if (optionIds.length) await lockOptions(tx, optionIds, 'SHARE');

      const state = await this.needs.load(orderId, { db: tx, files });
      const ready = state.plates.filter((p) => p.status === 'DONE' && !liveJobsOf(state.jobs, p.id).length);
      const warnings: OrderPlanWarning[] = [];

      // ---- everything checked before anything is written
      const work: Work[] = [];
      /** Units of each row the order still needs, taken by the plates in their order. */
      const left = new Map<string, number>();
      for (const plate of ready) {
        const label = plateLabel(plate.sortOrder, plate.printerName);
        for (const item of plate.items) {
          const rp = state.rows.get(item.rowKey);
          if (!rp) {
            // The order line was removed since: the rest of the order is not held up by it.
            warnings.push({ code: 'BLOCKED', plateId: plate.id, rowKey: item.rowKey, message: `${label}: ${GONE_FROM_PLAN.replace(/^A part on this plate/, 'a part on it')} — no job was made for it` });
            continue;
          }
          const desc = rp.row.componentDescription;
          if (!item.unitsSliced || item.unitsSliced < 1) {
            warnings.push({ code: 'PLATE_TOO_FULL', plateId: plate.id, rowKey: item.rowKey, message: `${label}: no "${desc}" was placed, so no job was made for it` });
            continue;
          }
          if (rp.component.pendingFirstSlice) throw new BadRequestException(`"${desc}" has not been sliced yet — slice one unit on the product page first`);
          let layout: ResolvedLayout;
          if (plate.kind === 'LAYOUT') {
            const own = rp.component.layouts.find((l) => l.layoutId === plate.layoutId);
            if (!own) throw new BadRequestException(`${label}: that plate of "${desc}" no longer exists — delete this plate and add it again`);
            layout = own;
          } else {
            layout = plateAsLayout(plate, item, rp.component, label);
          }
          const units = layout.unitsPerPlate * plate.plateCount;
          const open = left.get(item.rowKey) ?? rp.row.toProduce;
          if (open < 1) {
            // One plate too many holds up nothing else: its part is left out and said.
            warnings.push({ code: 'OVER', plateId: plate.id, rowKey: item.rowKey, message: `${label}: the order needs no more "${desc}", so no job was made for it — take it off the plate or delete the plate` });
            continue;
          }
          const required = Math.min(units, open);
          left.set(item.rowKey, open - required);
          work.push({ plate, item, rp, units, required, component: { ...rp.component, layouts: [layout], inactiveLayoutIds: [] }, layout });
        }
      }
      // Nothing at all: the reason a plate gave, when one did.
      if (!work.length) throw new BadRequestException(warnings[0]?.message ?? NOTHING_TO_CREATE);

      // ---- writes
      const printed = new Set(work.map((w) => w.item.rowKey));
      for (const { row, component, problem } of state.plan.rows) {
        if (row.fromStock <= 0 || !printed.has(row.rowKey) || (problem && row.toProduce > 0)) continue;
        await this.stock.allocate(tx, {
          componentId: component.componentId, colourKey: row.colourKey, quantity: row.fromStock, orderItemId: row.orderItemId,
          description: row.componentDescription, userId,
        });
      }
      const ctx = new CatalogRequestContext();
      const reservedBySpool = await this.planner.reservedBySpool();
      const jobIds: string[] = [];
      for (const w of work) {
        const { row, bom, sizeName, colourName } = w.rp;
        const config = await this.resolver.requireConfig(bom.productId, ctx);
        const planned = planFromBom(
          { ...bom, components: [w.component] },
          {
            quantity: 1,
            unitsRequired: { [w.component.componentId]: w.required },
            surplusPolicy: row.surplusPolicy,
            plates: [{ componentId: w.component.componentId, layoutId: w.layout.layoutId, plateCount: w.plate.plateCount }],
          },
          config.materials,
          ctx.planCache,
        );
        const needs = planned.filamentNeeds;
        const picks = pickSpools(needs, await this.planner.spoolsFor(needs), { reservedBySpool });
        const label = plateLabel(w.plate.sortOrder, w.plate.printerName);
        const plateData = plateRows(planned.components).map((p) => ({ ...p, label }));
        const job = await tx.productionJob.create({
          data: {
            name: `${row.productName}${sizeName ? ` — ${sizeName}` : ''}${colourName ? ` — ${colourName}` : ''} — ${row.componentDescription} (×${w.required}) · ${label}`.slice(0, 250),
            status: 'QUEUED',
            orderId,
            orderItemId: row.orderItemId,
            productId: row.productId,
            componentId: w.component.componentId,
            sizeOptionId: row.sizeOptionId,
            colourOptionId: row.colourOptionId,
            variantId: row.sizeOptionId ?? row.colourOptionId,
            quantityToProduce: w.required,
            printerId: w.plate.printerId,
            purpose: 'CUSTOMER',
            surplusPolicy: row.surplusPolicy,
            stockMode: null,
            colorChanges: 0,
            // The plate's file name, unless the plate prints several times (§3.7: a bridge must not finish the job on its first plate).
            gcodeFilename: singlePlateFilename(plateData),
            orderPlateId: w.plate.id,
          },
        });
        if (plateData.length) await tx.jobPlate.createMany({ data: plateData.map((p) => ({ ...p, jobId: job.id })) });
        const lines = materialLines(planned.components, needs, picks);
        if (lines.length) await tx.jobMaterial.createMany({ data: lines.map((l) => ({ ...l, jobId: job.id })) });
        jobIds.push(job.id);
      }
      await tx.order.updateMany({ where: { id: orderId, status: 'CONFIRMED' }, data: { status: 'IN_PRODUCTION' } });
      return { jobsCreated: jobIds.length, jobIds, warnings };
    }, TX_OPTS);
  }
}
