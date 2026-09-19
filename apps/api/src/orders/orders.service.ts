import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException, Optional } from '@nestjs/common';
import type { OrderStatus, Problem } from '@printforge/types';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';
import { requiredEnum } from '../common/utils/validate-number';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { DiscordNotificationService } from '../communications/discord-notification.service';
import { SettingsService } from '../settings/settings.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { mapLegacyVariantId, validatePair } from '../catalog-core/option-pair';
import { PricingService, type ResolvedLine } from '../catalog-core/pricing.service';
import { ProductionPlannerService } from '../catalog-core/production-planner.service';
import { ProductStockService } from '../stock-ledger/product-stock.service';
import { cancelQueuedJobsForItem, LINE_STARTED_MESSAGE } from '../production/job-transitions';
import { lockOptions, lockProduct, TX_OPTS } from '../products/product-locks';
import {
  documentTotals, lineOptionsOf, lockLineRows, MAX_LINES, optionalId, orderItemColumns, parseColourSplit, parseCustomerLine,
  parseItemsArray, parseStaffLine, priceWarningsOf, splitLineByColour, taxRateOf,
} from './order-lines';
import {
  labelStock, materialAvailability, netAllocations, printFilesFor, resolveOrderLines, type PlannedLine,
} from './order-insights';

/** Minimal shape of a customer row returned via Prisma include. */
interface CustomerRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
const STARTED_JOB = ['IN_PROGRESS', 'PAUSED', 'COMPLETED'];

/**
 * What a customer route returns for an order (§0.2 "Customer responses", S5):
 * an explicit select, never pricing metadata, costs or the customer row.
 */
export const CUSTOMER_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  subtotal: true,
  tax: true,
  total: true,
  createdAt: true,
  items: { select: { description: true, quantity: true, unitPrice: true, totalPrice: true } },
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function optionalText(raw: unknown, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).replace(/<[^>]*>/g, '').trim().slice(0, max);
  return s || undefined;
}

function optionalDate(raw: unknown, field: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be a date`);
  return d;
}

function requiredId(raw: unknown, field: string): string {
  const id = optionalId(raw, field);
  if (!id) throw new BadRequestException(`${field} is required`);
  return id;
}

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private pricing: PricingService,
    private resolver: BomResolverService,
    private planner: ProductionPlannerService,
    private stock: ProductStockService,
    @Optional() private emailNotifications?: EmailNotificationService,
    @Optional() private whatsapp?: WhatsAppService,
    @Optional() private settingsService?: SettingsService,
    @Optional() private discord?: DiscordNotificationService,
    @Optional() private cache?: RedisCacheService,
  ) {}

  private async nextOrderNumber(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await generateNumber(this.prisma, 'ORD', 'order');
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    throw new InternalServerErrorException('Failed to generate unique document number');
  }

  /**
   * S2. The server prices every line itself (§3.9): tiers count across the lines
   * of one product and size, a client unitPrice counts only for an explicit
   * override (recorded MANUAL with its reason) or a custom line. Lines are
   * resolved after the FOR SHARE locks, on the locked rows.
   */
  async create(body: unknown) {
    const b = isObject(body) ? body : {};
    const customerId = requiredId(b.customerId, 'customerId');
    const items = parseItemsArray(b.items, { max: MAX_LINES, tooMany: 'An order can have at most 100 lines' }).map(parseStaffLine);
    const notes = optionalText(b.notes, 5000);
    const dueDate = optionalDate(b.dueDate, 'dueDate');
    const orderNumber = await this.nextOrderNumber();

    const { orderId, lines } = await this.prisma.$transaction(async (tx: any) => {
      await lockLineRows(tx, items);
      const lines = await this.pricing.resolveLines(items, { audience: 'STAFF', db: tx, ctx: new CatalogRequestContext() });
      const totals = documentTotals(lines, await taxRateOf(tx));
      const order = await tx.order.create({ data: { orderNumber, customerId, notes, dueDate, ...totals } });
      for (const l of lines) await tx.orderItem.create({ data: { orderId: order.id, ...orderItemColumns(l) } });
      return { orderId: order.id as string, lines };
    }, TX_OPTS);
    this.cache?.invalidate('dashboard:kpis').catch(() => {});

    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, items: true } });
    // Advisory only. The order stands; staff just need to know they have to
    // buy filament before this one can be printed.
    const stock = await this.availabilityOf(this.productLines(lines), null, new CatalogRequestContext()).catch(() => null);
    return {
      ...order,
      stockWarnings: stock?.materials.filter((m) => !m.hasEnoughStock) ?? [],
      priceWarnings: priceWarningsOf(lines),
    };
  }

  private productLines(lines: ReadonlyArray<ResolvedLine>): PlannedLine[] {
    return lines
      .filter((l) => l.productId)
      .map((l) => ({ productId: l.productId!, sizeOptionId: l.sizeOptionId, colourOptionId: l.colourOptionId, quantity: l.quantity }));
  }

  private availabilityOf(lines: PlannedLine[], excludeOrderId: string | null, ctx: CatalogRequestContext) {
    return materialAvailability(this.planner, lines, excludeOrderId, ctx);
  }

  async findAll(query: PaginationDto, status?: string) {
    const where = status && (ORDER_STATUSES as readonly string[]).includes(status) ? { status: status as OrderStatus } : {};

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        ...paginate(query),
        include: {
          customer: { select: { id: true, name: true } },
          _count: { select: { items: true, productionJobs: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  /** S4: staff order view with pairs, availability, print files by size and printed-stock allocations. */
  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { productionJobs: { select: { id: true, name: true, status: true, totalCost: true } } } },
        productionJobs: {
          include: { printer: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        invoices: { orderBy: { createdAt: 'desc' } },
        quote: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const ctx = new CatalogRequestContext();
    const options = await lineOptionsOf(this.resolver, order.items, ctx);
    const items = order.items.map((i: any) => ({ ...i, ...options.get(i.id) }));

    const { resolved, warnings } = await resolveOrderLines(this.resolver, order.orderNumber, order.items, ctx);
    const planned = resolved.map(({ item, res }) => ({ productId: res.bom.productId, ...res.pair, quantity: item.quantity }));
    const availability = await this.availabilityOf(planned, id, ctx);
    const partAvailability = await this.getPartAvailability(id, order.items);
    const printFiles = await printFilesFor(this.prisma, this.resolver, resolved, ctx);
    const stockAllocations = (await labelStock(this.prisma, await netAllocations(this.prisma, order.items.map((i: any) => i.id)))).map((a) => ({
      orderItemId: a.orderItemId,
      componentId: a.componentId,
      componentDescription: a.componentDescription,
      colourLabel: a.colourLabel,
      units: a.units,
    }));

    return {
      ...order,
      items,
      materialAvailability: availability.materials,
      partAvailability,
      printFiles,
      stockAllocations,
      warnings: dedupe([...warnings, ...availability.warnings]),
    };
  }

  /**
   * S3. Preflight for the New Order screen: what would be short if this order
   * were placed right now. Advisory, not a block — a print farm takes the order
   * and buys filament, it does not turn the customer away.
   */
  async checkStock(body: unknown) {
    const b = isObject(body) ? body : {};
    const raw = parseItemsArray(b.items, { min: 0, max: MAX_LINES, tooMany: 'Check at most 100 lines at a time' });
    const ctx = new CatalogRequestContext();
    const lines: PlannedLine[] = [];
    await this.resolver.preloadVariants(raw.map((it) => (typeof it.variantId === 'string' ? it.variantId : '')).filter(Boolean), ctx);
    for (let i = 0; i < raw.length; i++) {
      const it = raw[i];
      const prefix = `items[${i}]: `;
      const q = it.quantity;
      // Lines still being typed (quantity missing, empty or 0) are skipped, as before.
      if (q === undefined || q === null || q === '' || q === 0 || q === '0') continue;
      const n = typeof q === 'number' ? q : typeof q === 'string' ? Number(q) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new BadRequestException(`${prefix}quantity must be a whole number from 1 to 100000`);
      const line = parseStaffLine(it, i);
      if (!line.productId && !line.variantId) continue; // custom line: nothing to print
      if (!line.productId && (line.sizeOptionId || line.colourOptionId)) throw new BadRequestException(`${prefix}choose the product for this size or colour`);
      const mapped = mapLegacyVariantId(line, (id) => ctx.variants.get(id) ?? null, prefix);
      const config = mapped.productId ? await this.resolver.loadConfig(mapped.productId, ctx) : null;
      if (!config) throw new BadRequestException(`${prefix}product not found`);
      validatePair(this.resolver.pairContext(config), mapped.sizeOptionId, mapped.colourOptionId, { audience: 'STAFF', prefix });
      lines.push({ productId: config.product.id, sizeOptionId: mapped.sizeOptionId, colourOptionId: mapped.colourOptionId, quantity: n });
    }
    if (!lines.length) return { materials: [], shortages: [], ok: true, warnings: [] };
    const { materials, warnings } = await this.availabilityOf(lines, null, ctx);
    const shortages = materials.filter((m) => !m.hasEnoughStock);
    return { materials, shortages, ok: shortages.length === 0, warnings: dedupe(warnings) };
  }

  /**
   * Non-printed part requirements for an order, netted against stock already
   * reserved by other open orders. Mirrors materialAvailability but in whole
   * pieces rather than grams.
   */
  private async getPartAvailability(
    orderId: string,
    items: Array<{ productId: string | null; quantity: number }>,
  ) {
    const productIds = items.map(i => i.productId).filter((p): p is string => !!p);
    if (productIds.length === 0) return [];

    const bom = await this.prisma.productPart.findMany({
      where: { productId: { in: productIds } },
      include: { part: true },
    });
    if (bom.length === 0) return [];

    // What this order needs
    const needs = new Map<string, { partId: string; name: string; sku: string | null; category: string; unitCost: number; stockQty: number; qtyNeeded: number }>();
    for (const item of items) {
      if (!item.productId) continue;
      for (const line of bom.filter(b => b.productId === item.productId)) {
        const qty = line.quantity * item.quantity;
        const existing = needs.get(line.partId);
        if (existing) {
          existing.qtyNeeded += qty;
        } else {
          needs.set(line.partId, {
            partId: line.partId,
            name: line.part.name,
            sku: line.part.sku,
            category: line.part.category,
            unitCost: line.part.unitCost,
            stockQty: line.part.stockQty,
            qtyNeeded: qty,
          });
        }
      }
    }

    // What other open orders have already spoken for
    const partIds = Array.from(needs.keys());
    const reservingOrders = await this.prisma.order.findMany({
      where: { id: { not: orderId }, status: { in: ['CONFIRMED', 'IN_PRODUCTION'] } },
      select: { items: { select: { productId: true, quantity: true } } },
    });
    const reservingProductIds = new Set<string>();
    for (const ro of reservingOrders) {
      for (const item of ro.items) if (item.productId) reservingProductIds.add(item.productId);
    }
    const reserved = new Map<string, number>();
    if (reservingProductIds.size > 0) {
      const reservingBom = await this.prisma.productPart.findMany({
        where: { productId: { in: Array.from(reservingProductIds) }, partId: { in: partIds } },
        select: { productId: true, partId: true, quantity: true },
      });
      for (const ro of reservingOrders) {
        for (const item of ro.items) {
          if (!item.productId) continue;
          for (const line of reservingBom.filter(b => b.productId === item.productId)) {
            reserved.set(line.partId, (reserved.get(line.partId) || 0) + line.quantity * item.quantity);
          }
        }
      }
    }

    return Array.from(needs.values()).map(need => {
      const reservedQty = reserved.get(need.partId) || 0;
      const freeStock = Math.max(0, need.stockQty - reservedQty);
      return {
        ...need,
        reservedStock: reservedQty,
        freeStock,
        hasEnoughStock: freeStock >= need.qtyNeeded,
      };
    });
  }

  /** Customer "My orders": explicit select (§0.2), no pricing metadata. */
  async findForCustomer(customerId: string) {
    return this.prisma.order.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        total: true,
        createdAt: true,
        items: { select: { description: true, quantity: true, unitPrice: true } },
      },
    });
  }

  /**
   * S5. Customers pay the size's standard price — never a tier, never an
   * override (§3.9) — and their lines carry the server label only. The pair is
   * checked with the CUSTOMER rules after the FOR SHARE locks.
   */
  async createForCustomer(customerId: string, body: unknown) {
    const b = isObject(body) ? body : {};
    const items = parseItemsArray(b.items, { max: 50, tooMany: 'An order can have at most 50 lines' }).map(parseCustomerLine);
    const notes = optionalText(b.notes, 1000);
    const orderNumber = await this.nextOrderNumber();

    const order = await this.prisma.$transaction(async (tx: any) => {
      await lockLineRows(tx, items);
      const lines = await this.pricing.resolveLines(items, { audience: 'CUSTOMER', db: tx, ctx: new CatalogRequestContext() });
      const totals = documentTotals(lines, await taxRateOf(tx));
      const created = await tx.order.create({ data: { orderNumber, customerId, notes, ...totals } });
      for (const l of lines) await tx.orderItem.create({ data: { orderId: created.id, ...orderItemColumns(l) } });
      return tx.order.findUnique({ where: { id: created.id }, select: CUSTOMER_ORDER_SELECT });
    }, TX_OPTS);

    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } }).catch(() => null);
    this.discord?.notifyNewPortalOrder({
      orderNumber: order.orderNumber,
      customerName: customer?.name ?? 'Customer',
      total: order.total,
      itemCount: order.items.length,
    }).catch(() => {});

    return order;
  }

  /**
   * S9. Moving an order to CANCELLED (from any other status) and returning its
   * printed-stock allocations happen in one transaction; the guarded status
   * change comes first, so a second cancel releases nothing.
   */
  async update(id: string, body: unknown) {
    const b = isObject(body) ? body : {};
    const status = b.status === undefined || b.status === null || b.status === '' ? undefined : (requiredEnum(b.status, 'status', ORDER_STATUSES) as OrderStatus);
    const notes = b.notes === undefined ? undefined : b.notes === null ? null : String(b.notes).slice(0, 5000);
    const dueDate = optionalDate(b.dueDate, 'dueDate');

    const existing = await this.prisma.order.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw new NotFoundException('Order not found');

    let released: Array<{ componentId: string; colourKey: string; units: number }> = [];
    if (status === 'CANCELLED' && existing.status !== 'CANCELLED') {
      released = await this.prisma.$transaction(async (tx: any) => {
        const flipped = await tx.order.updateMany({ where: { id, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED', notes, dueDate } });
        if (flipped.count === 0) return [];
        const credits = await this.stock.releaseForOrder(tx, id);
        return credits.map((c) => ({ componentId: c.componentId, colourKey: c.colourKey, units: c.quantity }));
      }, TX_OPTS);
    } else {
      await this.prisma.order.update({ where: { id }, data: { status: status ?? undefined, notes, dueDate } });
    }
    const updated = await this.prisma.order.findUnique({ where: { id }, include: { customer: true, items: true } });
    if (!updated) throw new NotFoundException('Order not found');

    // Fire customer notifications on status transitions
    const prevStatus = existing.status;
    const newStatus = updated.status;
    if (status && newStatus !== prevStatus) {
      const customer = updated.customer as CustomerRecord | null;
      const companyName = await this.settingsService?.get('company_name', 'PrintForge') ?? 'PrintForge';

      if (newStatus === 'CONFIRMED') {
        const enabled = await this.settingsService?.get('notify_order_confirmed', 'true') ?? 'true';
        if (enabled !== 'false') {
          if (customer?.email) this.emailNotifications?.notifyCustomerOrderConfirmed(customer.email, { orderNumber: updated.orderNumber }).catch(() => {});
          if (customer?.phone) this.whatsapp?.sendOrderConfirmed(customer.phone, { customerName: customer.name, orderNumber: updated.orderNumber, companyName }).catch(() => {});
        }
      } else if (newStatus === 'IN_PRODUCTION') {
        const enabled = await this.settingsService?.get('notify_order_production', 'true') ?? 'true';
        if (enabled !== 'false') {
          if (customer?.email) this.emailNotifications?.notifyCustomerOrderProduction(customer.email, { orderNumber: updated.orderNumber }).catch(() => {});
          if (customer?.phone) this.whatsapp?.sendOrderInProduction(customer.phone, { customerName: customer.name, orderNumber: updated.orderNumber, companyName }).catch(() => {});
        }
      } else if (newStatus === 'READY') {
        const enabled = await this.settingsService?.get('notify_order_ready', 'true') ?? 'true';
        if (enabled !== 'false') {
          if (customer?.email) this.emailNotifications?.notifyCustomerOrderReady(customer.email, { orderNumber: updated.orderNumber }).catch(() => {});
          if (customer?.phone) this.whatsapp?.sendOrderReady(customer.phone, { customerName: customer.name, orderNumber: updated.orderNumber, companyName }).catch(() => {});
        }
      }
    }

    this.cache?.invalidate('dashboard:kpis').catch(() => {});
    const stockReleased = (await labelStock(this.prisma, released)).map((r) => ({ componentDescription: r.componentDescription, colourLabel: r.colourLabel, units: r.units }));
    return { ...updated, stockReleased };
  }

  /**
   * S11 for orders (§3.9 "Changing a sold line's colour"). Splits a product line
   * into same-size colour lines without re-pricing. In one transaction: FOR SHARE
   * locks, pair validation on the locked rows, WP6's cancelQueuedJobsForItem
   * (409 if a job of the line has started), releaseForItem, then the line writes.
   * `dryRun` lists the jobs and stock without writing; the write needs `confirm`
   * when either list is non-empty.
   */
  async changeLineColour(orderId: string, itemId: string, body: unknown, dryRun = false, userId?: string | null) {
    const out = await this.prisma.$transaction(async (tx: any) => {
      const item = await tx.orderItem.findUnique({ where: { id: itemId }, include: { order: { select: { id: true, status: true } } } });
      if (!item || item.orderId !== orderId) throw new NotFoundException('Order line not found');
      if (item.order?.status === 'CANCELLED') throw new ConflictException('This order is cancelled');
      if (!item.productId) throw new BadRequestException('Only product lines have colours');
      const input = parseColourSplit(body, item.quantity);

      const ctx = new CatalogRequestContext();
      await this.resolver.preloadVariants([item.variantId, item.sizeOptionId, item.colourOptionId].filter((x: string | null): x is string => !!x), ctx, tx);
      const eff = this.resolver.effectiveOptions(item, ctx);
      if (eff.skip) throw new BadRequestException("This line's size or colour no longer exists");

      if (!(await lockProduct(tx, item.productId, 'SHARE'))) throw new BadRequestException("This line's product no longer exists");
      const optionIds = [...new Set([eff.sizeOptionId, eff.colourOptionId, ...input.colours.map((c) => c.colourOptionId)].filter((x): x is string => !!x))].sort();
      const locked = new Set((await lockOptions(tx, optionIds, 'SHARE')).map((o) => o.id));
      for (const c of input.colours) {
        if (c.colourOptionId && !locked.has(c.colourOptionId)) throw new BadRequestException('That colour no longer exists');
      }

      const config = await this.resolver.requireConfig(item.productId, ctx, tx);
      const pc = this.resolver.pairContext(config);
      const size = eff.sizeOptionId ? config.options.find((o) => o.id === eff.sizeOptionId) ?? null : null;
      if (eff.sizeOptionId && !size) throw new BadRequestException("This line's size no longer exists");
      const oldColour = eff.colourOptionId ? config.options.find((o) => o.id === eff.colourOptionId) ?? null : null;
      const split = splitLineByColour(pc, item, size, oldColour, eff.colourOptionId ? ctx.variants.get(eff.colourOptionId)?.name ?? null : null, input.colours);
      const warnings: Problem[] = [];
      for (const s of split) {
        const bom = this.resolver.resolveWithConfig(config, { sizeOptionId: size?.id ?? null, colourOptionId: s.colourOptionId });
        for (const w of bom.warnings) if (w.code === 'COLOUR_OPTION_NOT_SET_UP') warnings.push(w);
      }

      const jobs: Array<{ id: string; name: string; status: string }> = await tx.productionJob.findMany({
        where: { orderItemId: itemId },
        select: { id: true, name: true, status: true },
        orderBy: { createdAt: 'asc' },
      });
      if (jobs.some((j) => STARTED_JOB.includes(j.status))) throw new ConflictException(LINE_STARTED_MESSAGE);
      const queued = jobs.filter((j) => j.status === 'QUEUED').map((j) => ({ id: j.id, name: j.name }));
      const allocations = await netAllocations(tx, [itemId]);

      if (dryRun) {
        return { dryRun: true as const, cancelledJobs: queued, released: allocations, split, warnings };
      }
      if ((queued.length || allocations.length) && !input.confirm) throw new BadRequestException('Confirm the jobs and stock listed first');

      const cancelledJobs = await cancelQueuedJobsForItem(tx, itemId);
      const credits = await this.stock.releaseForItem(tx, itemId, userId ?? null);

      const sizeOptionId = size?.id ?? null;
      const [first, ...rest] = split;
      await tx.orderItem.update({
        where: { id: itemId },
        data: {
          sizeOptionId,
          colourOptionId: first.colourOptionId,
          variantId: sizeOptionId ?? first.colourOptionId,
          quantity: first.quantity,
          totalPrice: first.totalPrice,
          description: first.description,
        },
      });
      for (const s of rest) {
        await tx.orderItem.create({
          data: {
            orderId,
            productId: item.productId,
            sizeOptionId,
            colourOptionId: s.colourOptionId,
            variantId: sizeOptionId ?? s.colourOptionId,
            description: s.description,
            quantity: s.quantity,
            unitPrice: item.unitPrice,
            totalPrice: s.totalPrice,
            listUnitPrice: item.listUnitPrice,
            priceSource: item.priceSource,
            tierMinQty: item.tierMinQty,
            priceOverrideReason: item.priceOverrideReason,
          },
        });
      }
      return {
        dryRun: false as const,
        cancelledJobs,
        released: credits.map((c) => ({ componentId: c.componentId, colourKey: c.colourKey, units: c.quantity })),
        split,
        warnings,
      };
    }, TX_OPTS);

    const stockReleased = (await labelStock(this.prisma, out.released)).map((r) => ({ componentDescription: r.componentDescription, colourLabel: r.colourLabel, units: r.units }));
    if (out.dryRun) {
      return {
        dryRun: true,
        lines: out.split.map((s) => ({ colourOptionId: s.colourOptionId, quantity: s.quantity, totalPrice: s.totalPrice, description: s.description })),
        cancelledJobs: out.cancelledJobs,
        stockReleased,
        warnings: out.warnings,
      };
    }
    this.cache?.invalidate('dashboard:kpis').catch(() => {});
    const order = await this.findOne(orderId);
    return { ...order, cancelledJobs: out.cancelledJobs, stockReleased, warnings: dedupe([...order.warnings, ...out.warnings]) };
  }
}

function dedupe(list: Problem[]): Problem[] {
  const seen = new Set<string>();
  return list.filter((w) => {
    const k = `${w.code}|${w.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
