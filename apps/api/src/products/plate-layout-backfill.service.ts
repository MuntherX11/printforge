import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { round3 } from '../catalog-core/cost-engine';
import { PrismaService } from '../common/prisma/prisma.service';
import { BackfillCounts, runBackfill } from '../common/utils/backfill-runner';
import { isMultiColourComponent } from '../stock-ledger/colour-key';

export const BF1_KEY = 'plate-layouts-v1';
const BATCH = 100;
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };
/** Plate grams more than this far from units × per-unit grams → created inactive for review. */
export const STALE_GRAMS_RATIO = 0.3;

type Outcome = 'created' | 'skipped';

/**
 * BF-1 (§2.4): promotes legacy plate calibration (`platedUnits`, `platedMinutes`,
 * `platedGrams`) to a CALIBRATION PlateLayout. Layouts now drive reservation and
 * deduction, so legacy values are validated first: out of range or incomplete →
 * marked, no layout; grams that disagree with the component by > 30 % → the
 * layout is created inactive for review.
 *
 * Idempotent and resumable: each component claims itself with a guarded
 * `platedMigratedAt` update as the first statement of its own transaction, so a
 * marked row is never returned again, two runners can't both create a layout,
 * and a layout the owner deletes is never recreated. The `plated*` columns are
 * left untouched (rollback-safe).
 */
@Injectable()
export class PlateLayoutBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlateLayoutBackfillService.name);

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    setImmediate(() => {
      runBackfill(this.prisma, this.logger, BF1_KEY, (renew) => this.run(renew)).catch((e) => this.logger.error(e?.message, e?.stack));
    });
  }

  async run(renewLease: () => Promise<void> = async () => undefined): Promise<BackfillCounts> {
    const counts: BackfillCounts = { created: 0, skipped: 0, failed: 0 };
    let after: string | null = null;
    for (;;) {
      await renewLease();
      const rows: any[] = await (this.prisma as any).productComponent.findMany({
        where: { platedMigratedAt: null, platedUnits: { not: null }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: BATCH,
        include: { materials: true },
      });
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      for (const c of rows) {
        try {
          const outcome = await this.migrate(c);
          counts[outcome]++;
        } catch (e) {
          // Transient: the transaction rolled back, the row stays unmarked, the next boot retries it.
          counts.failed++;
          this.logger.error(`${BF1_KEY}: component ${c.id} failed: ${(e as Error)?.message}`, (e as Error)?.stack);
        }
      }
      if (rows.length < BATCH) break;
    }
    return counts;
  }

  private async migrate(c: any): Promise<Outcome> {
    return (this.prisma as any).$transaction(async (tx: any) => {
      const claimed = await tx.productComponent.updateMany({ where: { id: c.id, platedMigratedAt: null }, data: { platedMigratedAt: new Date() } });
      if (claimed.count !== 1) {
        this.logger.log(`${BF1_KEY}: ${c.id} skipped: claimed by another runner`);
        return 'skipped';
      }
      const multi = isMultiColourComponent(c);
      const perUnit = multi ? c.materials.reduce((s: number, m: any) => s + (m.gramsUsed || 0), 0) : c.gramsUsed || 0;
      const units = c.platedUnits;
      const minutes = c.platedMinutes;
      const grams = c.platedGrams ?? round3(perUnit * (units ?? 0));
      const intOk = Number.isInteger(units) && units >= 1 && units <= 500;
      const minOk = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 1 && minutes <= 100_000;
      const gOk = typeof grams === 'number' && Number.isFinite(grams) && grams >= 0.1 && grams <= 100_000;
      if (!intOk || !minOk || !gOk) {
        this.logger.log(`${BF1_KEY}: "${c.description}" skipped: out of range or incomplete (units=${units}, minutes=${minutes}, grams=${grams})`);
        return 'skipped';
      }
      const dup = await tx.plateLayout.findFirst({ where: { componentId: c.id, unitsPerPlate: units, isActive: true }, select: { id: true } });
      if (dup) {
        this.logger.log(`${BF1_KEY}: "${c.description}" skipped: layout exists`);
        return 'skipped';
      }
      let isActive = true;
      let note: string | null = null;
      if (!(perUnit > 0)) {
        isActive = false;
        note = 'component has no per-unit grams to cross-check';
      } else {
        const diff = Math.abs(grams / units - perUnit) / perUnit;
        if (diff > STALE_GRAMS_RATIO) {
          isActive = false;
          note = `plate grams differ by ${Math.round(diff * 100)} % from the component`;
        }
      }
      const layout = await tx.plateLayout.create({
        data: {
          componentId: c.id, name: `×${units}`, unitsPerPlate: units, plateMinutes: minutes, plateGrams: grams,
          source: 'CALIBRATION', attachmentId: null, colorChanges: 0, isActive,
        },
        select: { id: true },
      });
      const slots = multi ? this.multiSlots(c.materials, grams) : [{ colorIndex: 0, gramsUsed: grams }];
      for (const s of slots) await tx.plateLayoutSlot.create({ data: { layoutId: layout.id, ...s } });
      if (!isActive) this.logger.warn(`${BF1_KEY}: layout ×${units} for "${c.description}" created inactive for review: ${note}`);
      return 'created';
    }, TX_OPTS);
  }

  /** One slot per ComponentMaterial, proportional to its grams (equal split when they sum to 0). */
  private multiSlots(materials: Array<{ colorIndex: number; gramsUsed: number }>, grams: number) {
    const sum = materials.reduce((s, m) => s + (m.gramsUsed || 0), 0);
    return materials.map((m) => ({
      colorIndex: m.colorIndex,
      gramsUsed: round3(sum > 0 ? (grams * (m.gramsUsed || 0)) / sum : grams / materials.length),
    }));
  }
}
