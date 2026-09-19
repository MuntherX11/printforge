import { Injectable, NotFoundException, BadRequestException, Optional, InternalServerErrorException, ConflictException, Logger } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import type { Problem } from '@printforge/types';
import { CustomerQuoteRequestDto } from './dto/customer-quote-request.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { UpdateQuoteDto, SaveQuoteFromAnalysisDto, QuoteStatus, QuoteSource } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';
import { optionalNumber } from '../common/utils/validate-number';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { round3 } from '../catalog-core/cost-engine';
import { validatePair } from '../catalog-core/option-pair';
import { PricingService } from '../catalog-core/pricing.service';
import { JobPlanningService } from '../production/job-planning.service';
import { lockOptions, lockProduct, TX_OPTS } from '../products/product-locks';
import {
  documentTotals, lineOptionsOf, lockLineRows, MAX_LINES, optionalId, parseColourSplit, parseItemsArray, parseStaffLine,
  priceWarningsOf, quoteItemColumns, splitLineByColour, taxRateOf,
} from '../orders/order-lines';
import { EventsGateway } from '../websocket/events.gateway';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { SettingsService } from '../settings/settings.service';

/** Minimal shape of a customer row returned via Prisma include. */
interface CustomerRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

/**
 * What a customer route returns for a quote (§0.2, S10): the findForCustomer
 * shape. Never the customer row (passwordHash, refreshToken), costs, margins or
 * pricing metadata.
 */
export const CUSTOMER_QUOTE_SELECT = {
  id: true,
  quoteNumber: true,
  status: true,
  total: true,
  validUntil: true,
  createdAt: true,
  gcodeMetadata: true,
  notes: true,
  items: { select: { id: true, description: true, quantity: true, unitPrice: true, totalPrice: true } },
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private prisma: PrismaService,
    private pricing: PricingService,
    private resolver: BomResolverService,
    private planning: JobPlanningService,
    @Optional() private eventsGateway?: EventsGateway,
    @Optional() private emailNotifications?: EmailNotificationService,
    @Optional() private whatsapp?: WhatsAppService,
    @Optional() private settingsService?: SettingsService,
  ) {}

  async createFromAnalysis(dto: SaveQuoteFromAnalysisDto, createdById?: string) {
    let quoteNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        quoteNumber = await generateNumber(this.prisma, 'QT', 'quote');
        break;
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!quoteNumber) throw new InternalServerErrorException('Failed to generate unique document number');

    const cost = dto.costEstimate;
    const suggestedPrice = cost?.suggestedPrice || 0;

    const validityDays = parseInt(
      (await this.prisma.systemSetting.findUnique({ where: { key: 'quote_validity_days' } }))?.value ?? '3',
      10,
    );
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    const taxRateSetting = await this.prisma.systemSetting.findUnique({ where: { key: 'tax_rate' } });
    const taxRate = parseFloat(taxRateSetting?.value || '0') / 100;
    const tax = suggestedPrice * taxRate;

    const isGcode = !!dto.analysis?.slicer;

    return this.prisma.quote.create({
      data: {
        quoteNumber,
        customerId: dto.customerId,
        source: (dto.source as QuoteSource) || QuoteSource.QUICK_QUOTE,
        notes: dto.notes || null,
        validUntil,
        subtotal: suggestedPrice,
        tax,
        total: suggestedPrice + tax,
        gcodeMetadata: isGcode ? dto.analysis : undefined,
        stlMetadata: !isGcode ? dto.analysis : undefined,
        costBreakdown: cost || undefined,
        createdById: createdById || null,
        items: {
          create: [{
            description: dto.description,
            quantity: 1,
            unitPrice: suggestedPrice,
            totalPrice: suggestedPrice,
            estimatedGrams: dto.analysis?.filamentUsedGrams || dto.analysis?.estimatedGrams || null,
            estimatedMinutes: dto.analysis?.estimatedTimeSeconds
              ? Math.round(dto.analysis.estimatedTimeSeconds / 60)
              : dto.analysis?.estimatedMinutes || null,
            estimatedColors: dto.analysis?.toolCount || null,
            estimatedCost: cost?.totalCost || null,
          }],
        },
      },
      include: { customer: true, items: true },
    });
  }

  async customerRequestQuote(customerId: string, dto: CustomerQuoteRequestDto) {
    let quoteNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        quoteNumber = await generateNumber(this.prisma, 'QT', 'quote');
        break;
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!quoteNumber) throw new InternalServerErrorException('Failed to generate unique document number');

    const validityDays = parseInt(
      (await this.prisma.systemSetting.findUnique({ where: { key: 'quote_validity_days' } }))?.value ?? '3',
      10,
    );
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validityDays);

    let items: {
      description: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      estimatedGrams?: number | null;
      estimatedMinutes?: number | null;
      estimatedCost?: number | null;
    }[];
    let total: number;

    if (dto.plates && dto.plates.length > 0) {
      items = dto.plates.map(plate => ({
        description: plate.name,
        quantity: 1,
        unitPrice: plate.breakdown.suggestedPrice,
        totalPrice: plate.breakdown.suggestedPrice,
        estimatedGrams: Math.round(plate.weightGrams),
        estimatedMinutes: Math.round(plate.printSeconds / 60),
        estimatedCost: plate.breakdown.totalCost,
      }));
      total = dto.plates.reduce((sum, p) => sum + p.breakdown.suggestedPrice, 0);
    } else if (dto.analysis && dto.costEstimate) {
      items = [{
        description: dto.analysis.fileName || 'Custom print',
        quantity: 1,
        unitPrice: dto.costEstimate.suggestedPrice,
        totalPrice: dto.costEstimate.suggestedPrice,
        estimatedGrams: dto.analysis.filamentUsedGrams ?? null,
        estimatedMinutes: dto.analysis.estimatedTimeSeconds
          ? Math.round(dto.analysis.estimatedTimeSeconds / 60)
          : null,
        estimatedCost: dto.costEstimate.totalCost,
      }];
      total = dto.costEstimate.suggestedPrice;
    } else {
      throw new BadRequestException('Provide either plates (3MF) or analysis + costEstimate');
    }

    const taxRateSetting = await this.prisma.systemSetting.findUnique({ where: { key: 'tax_rate' } });
    const taxRate = parseFloat(taxRateSetting?.value || '0') / 100;
    const tax = total * taxRate;

    const quote = await this.prisma.quote.create({
      data: {
        quoteNumber,
        customerId,
        source: 'CUSTOMER',
        notes: dto.notes || null,
        validUntil,
        subtotal: total,
        tax,
        total: total + tax,
        // JSON round-trip produces a plain object Prisma's InputJsonValue accepts
        gcodeMetadata: dto.analysis?.slicer ? JSON.parse(JSON.stringify(dto.analysis)) : undefined,
        stlMetadata: dto.analysis && !dto.analysis.slicer ? JSON.parse(JSON.stringify(dto.analysis)) : undefined,
        items: { create: items },
      },
      select: CUSTOMER_QUOTE_SELECT,
    });

    this.eventsGateway?.broadcastNotification({
      type: 'info',
      title: 'New Quote Request',
      message: `New quote request received: ${quote.quoteNumber}`,
    });

    return quote;
  }

  async findForCustomer(customerId: string, query: PaginationDto) {
    const where = { customerId };
    const [data, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          quoteNumber: true,
          status: true,
          total: true,
          validUntil: true,
          createdAt: true,
          gcodeMetadata: true, // keep for customer review
          notes: true,
          items: {
            select: {
              id: true,
              description: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
            },
          },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.quote.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  async customerAccept(quoteId: string, customerId: string) {
    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId } });
    if (!quote || quote.customerId !== customerId) throw new NotFoundException('Quote not found');
    if (quote.status !== 'SENT' && quote.status !== 'DRAFT') {
      throw new BadRequestException('Quote cannot be accepted in its current status');
    }
    if (quote.validUntil && quote.validUntil < new Date()) {
      throw new BadRequestException('Quote has expired');
    }
    return this.prisma.quote.update({
      where: { id: quoteId },
      data: { status: 'ACCEPTED' },
      select: CUSTOMER_QUOTE_SELECT,
    });
  }

  async customerReject(quoteId: string, customerId: string) {
    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId } });
    if (!quote || quote.customerId !== customerId) throw new NotFoundException('Quote not found');
    if (quote.status !== 'SENT' && quote.status !== 'DRAFT') {
      throw new BadRequestException('Quote cannot be rejected in its current status');
    }
    return this.prisma.quote.update({
      where: { id: quoteId },
      data: { status: 'REJECTED' },
      select: CUSTOMER_QUOTE_SELECT,
    });
  }

  async expireOldQuotes() {
    const result = await this.prisma.quote.updateMany({
      where: {
        status: { in: ['DRAFT', 'SENT'] },
        validUntil: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  private async nextNumber(prefix: 'QT' | 'ORD', model: 'quote' | 'order'): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await generateNumber(this.prisma, prefix, model);
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    throw new InternalServerErrorException('Failed to generate unique document number');
  }

  /**
   * S6. Priced by the server exactly like S2 (§3.9, STAFF resolveLines): tiers
   * per product and size across the quote's lines, client prices only for
   * overrides (MANUAL + reason) and custom lines, server labels first.
   */
  async create(body: unknown) {
    const b = isObject(body) ? body : {};
    const customerId = optionalId(b.customerId, 'customerId');
    if (!customerId) throw new BadRequestException('customerId is required');
    const rawItems = parseItemsArray(b.items, { max: MAX_LINES, tooMany: 'A quote can have at most 100 lines' });
    const items = rawItems.map(parseStaffLine);
    const extras = rawItems.map((it, i) => ({
      estimatedGrams: optionalNumber(it.estimatedGrams, `items[${i}].estimatedGrams`, { min: 0, max: 1_000_000 }) ?? null,
      estimatedMinutes: optionalNumber(it.estimatedMinutes, `items[${i}].estimatedMinutes`, { min: 0, max: 10_000_000 }) ?? null,
      estimatedColors: optionalNumber(it.estimatedColors, `items[${i}].estimatedColors`, { min: 0, max: 64, integer: true }) ?? null,
      estimatedCost: optionalNumber(it.estimatedCost, `items[${i}].estimatedCost`, { min: 0, max: 1_000_000 }) ?? null,
      marginPercent: optionalNumber(it.marginPercent, `items[${i}].marginPercent`, { min: -1_000_000, max: 100 }) ?? null,
    }));
    const notes = b.notes === undefined || b.notes === null ? undefined : String(b.notes).slice(0, 5000);
    let validUntil: Date | undefined;
    if (b.validUntil !== undefined && b.validUntil !== null && b.validUntil !== '') {
      validUntil = new Date(String(b.validUntil));
      if (Number.isNaN(validUntil.getTime())) throw new BadRequestException('validUntil must be a date');
    }
    const quoteNumber = await this.nextNumber('QT', 'quote');

    const { quoteId, lines } = await this.prisma.$transaction(async (tx: any) => {
      await lockLineRows(tx, items);
      const lines = await this.pricing.resolveLines(items, { audience: 'STAFF', db: tx, ctx: new CatalogRequestContext() });
      const totals = documentTotals(lines, await taxRateOf(tx));
      const quote = await tx.quote.create({ data: { quoteNumber, customerId, notes, validUntil, ...totals } });
      for (const l of lines) await tx.quoteItem.create({ data: { quoteId: quote.id, ...quoteItemColumns(l), ...extras[l.index] } });
      return { quoteId: quote.id as string, lines };
    }, TX_OPTS);

    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId }, include: { customer: true, items: true } });
    return { ...quote, priceWarnings: priceWarningsOf(lines) };
  }

  async findAll(query: PaginationDto, status?: string) {
    const validStatuses = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'];
    const where = status && validStatuses.includes(status) ? { status: status as QuoteStatus } : {};
    
    const [data, total] = await Promise.all([
      this.prisma.quote.findMany({
        where,
        ...paginate(query),
        include: {
          customer: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.quote.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  /** S8: staff quote view; items carry their size, colour and pair label. */
  async findOne(id: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { customer: true, items: true, order: true, attachments: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    const options = await lineOptionsOf(this.resolver, quote.items as any[], new CatalogRequestContext());
    return { ...quote, items: quote.items.map((i: any) => ({ ...i, ...options.get(i.id) })) };
  }

  async update(id: string, dto: UpdateQuoteDto) {
    const existing = await this.findOne(id);
    const validStatuses = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'];

    const updated = await this.prisma.quote.update({
      where: { id },
      data: {
        status: dto.status ?? undefined,
        notes: dto.notes,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      },
      include: { customer: true, items: true },
    });

    // Fire customer notification when quote is marked SENT
    if (dto.status === 'SENT' && existing.status !== 'SENT') {
      const notifyEnabled = await this.settingsService?.get('notify_quote_sent', 'true') ?? 'true';
      if (notifyEnabled !== 'false') {
        const customer = updated.customer as CustomerRecord | null;
        const companyName = await this.settingsService?.get('company_name', 'PrintForge') ?? 'PrintForge';
        const currency = await this.settingsService?.get('currency', 'OMR') ?? 'OMR';
        const decimals = parseInt(await this.settingsService?.get('currency_decimals', '3') ?? '3');
        const formattedTotal = updated.total.toLocaleString('en-GB', {
          style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
        });

        if (customer?.email) {
          this.emailNotifications?.notifyCustomerQuoteSent(customer.email, {
            quoteNumber: updated.quoteNumber,
            total: updated.total,
          }).catch(() => {});
        }
        if (customer?.phone) {
          this.whatsapp?.sendQuoteSent(customer.phone, {
            customerName: customer.name,
            quoteNumber: updated.quoteNumber,
            total: formattedTotal,
            companyName,
          }).catch(() => {});
        }
      }
    }

    return updated;
  }

  /**
   * S7 (§3.9 "Quote to order conversion"). The quote is the commitment: lines
   * copy their pair, description and every pricing field verbatim (pairs checked
   * for ownership and kind only, allowInactive, no re-pricing) and write the
   * OrderItem variantId mirror, in one transaction with the SENT → ACCEPTED flip
   * and FOR SHARE locks.
   *
   * With autoCreateJobs (default), AFTER the commit: custom lines keep one
   * placeholder job per unit (they have no BOM); product lines are planned by
   * WP6's planWithSuggestions — exactly J4 then J5 without edits. A planning
   * failure never undoes the conversion; it only adds JOBS_NOT_PLANNED.
   */
  async convertToOrder(id: string, options?: { autoCreateJobs?: boolean }, userId?: string | null) {
    const autoCreateJobs = options?.autoCreateJobs !== false;
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' } }, order: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.order) throw new ConflictException('Quote already converted to order');

    // Allow conversion from ACCEPTED or SENT status (auto-accept if SENT)
    if (!['ACCEPTED', 'SENT'].includes(quote.status)) {
      throw new BadRequestException('Quote must be SENT or ACCEPTED to convert');
    }

    // Reject expired quotes
    if (quote.validUntil && new Date(quote.validUntil) < new Date()) {
      throw new BadRequestException('Quote has expired and can no longer be converted to an order');
    }

    const orderNumber = await this.nextNumber('ORD', 'order');
    let orderId: string;
    try {
      orderId = await this.prisma.$transaction(async (tx: any) => {
        // Atomically flip SENT → ACCEPTED; a concurrent conversion either finds
        // the status changed or hits the unique Order.quoteId (P2002 → 409).
        if (quote.status === 'SENT') {
          const flipped = await tx.quote.updateMany({ where: { id, status: 'SENT' }, data: { status: 'ACCEPTED' } });
          if (flipped.count === 0) throw new ConflictException('Quote status changed by a concurrent request — please retry');
        }
        const items = quote.items as any[];
        await lockLineRows(tx, items.map((i) => ({ productId: i.productId, sizeOptionId: i.sizeOptionId, colourOptionId: i.colourOptionId })));
        const ctx = new CatalogRequestContext();
        for (let n = 0; n < items.length; n++) {
          const i = items[n];
          if (!i.productId) continue;
          const config = await this.resolver.loadConfig(i.productId, ctx, tx);
          if (!config) throw new BadRequestException(`Line ${n + 1}: product not found`);
          validatePair(this.resolver.pairContext(config), i.sizeOptionId, i.colourOptionId, { audience: 'STAFF', allowInactive: true, prefix: `Line ${n + 1}: ` });
        }
        const order = await tx.order.create({
          data: {
            orderNumber,
            customerId: quote.customerId,
            quoteId: quote.id,
            subtotal: round3(quote.subtotal),
            tax: round3(quote.tax),
            total: round3(quote.total),
          },
        });
        for (const i of items) {
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              productId: i.productId,
              sizeOptionId: i.sizeOptionId,
              colourOptionId: i.colourOptionId,
              variantId: i.sizeOptionId ?? i.colourOptionId ?? null,
              description: i.description,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              totalPrice: i.totalPrice,
              listUnitPrice: i.listUnitPrice,
              priceSource: i.priceSource,
              tierMinQty: i.tierMinQty,
              priceOverrideReason: i.priceOverrideReason,
            },
          });
        }
        return order.id as string;
      }, TX_OPTS);
    } catch (e: unknown) {
      // P2002 on Order.quoteId unique constraint means a concurrent request beat us
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('Quote already converted to order by a concurrent request');
      }
      throw e;
    }

    const planning: { jobsCreated: number; warnings: Problem[] } = { jobsCreated: 0, warnings: [] };
    if (autoCreateJobs) {
      const lines = await this.prisma.orderItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
      const placeholders: Array<{ name: string; orderId: string; orderItemId: string; colorChanges: number; status: JobStatus }> = [];
      for (const item of lines.filter((l) => !l.productId)) {
        for (let q = 0; q < item.quantity; q++) {
          placeholders.push({
            name: item.quantity > 1 ? `${item.description} (${q + 1}/${item.quantity})` : item.description,
            orderId,
            orderItemId: item.id,
            colorChanges: 0,
            status: JobStatus.QUEUED,
          });
        }
      }
      if (placeholders.length) {
        await this.prisma.productionJob.createMany({ data: placeholders });
        planning.jobsCreated += placeholders.length;
      }
      const productLines = lines.filter((l) => l.productId);
      if (productLines.length) {
        try {
          const result = await this.planning.planWithSuggestions(orderId, userId ?? null);
          planning.jobsCreated += result.jobsCreated;
          planning.warnings.push(...result.warnings);
        } catch (e) {
          const reason = (e as Error)?.message || 'unknown error';
          this.logger.error(`Planning order ${orderNumber} after converting ${quote.quoteNumber} failed: ${reason}`, (e as Error)?.stack);
          planning.warnings.push({
            code: 'JOBS_NOT_PLANNED',
            message: `Production wasn't planned for ${productLines.length} lines (${reason}) — plan it from the order`,
          });
        }
      }
    }

    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, items: true } });
    return { ...order, planning };
  }

  /**
   * S11 for quotes (§3.9 "Changing a sold line's colour"): DRAFT and SENT quotes
   * only. Splits a product line into same-size colour lines with the same unit
   * price, pricing fields and tier; the quote's totals don't change.
   */
  async changeLineColour(quoteId: string, itemId: string, body: unknown, dryRun = false) {
    const out = await this.prisma.$transaction(async (tx: any) => {
      const item = await tx.quoteItem.findUnique({ where: { id: itemId }, include: { quote: { select: { id: true, status: true } } } });
      if (!item || item.quoteId !== quoteId) throw new NotFoundException('Quote line not found');
      if (!['DRAFT', 'SENT'].includes(item.quote?.status)) throw new ConflictException('Only draft or sent quotes can change colours');
      if (!item.productId) throw new BadRequestException('Only product lines have colours');
      const input = parseColourSplit(body, item.quantity);

      if (!(await lockProduct(tx, item.productId, 'SHARE'))) throw new BadRequestException("This line's product no longer exists");
      const optionIds = [...new Set([item.sizeOptionId, item.colourOptionId, ...input.colours.map((c) => c.colourOptionId)].filter((x): x is string => !!x))].sort();
      const locked = new Set((await lockOptions(tx, optionIds, 'SHARE')).map((o) => o.id));
      for (const c of input.colours) {
        if (c.colourOptionId && !locked.has(c.colourOptionId)) throw new BadRequestException('That colour no longer exists');
      }
      const ctx = new CatalogRequestContext();
      const config = await this.resolver.requireConfig(item.productId, ctx, tx);
      const size = item.sizeOptionId ? config.options.find((o) => o.id === item.sizeOptionId) ?? null : null;
      if (item.sizeOptionId && !size) throw new BadRequestException("This line's size no longer exists");
      const oldColour = item.colourOptionId ? config.options.find((o) => o.id === item.colourOptionId) ?? null : null;
      const split = splitLineByColour(this.resolver.pairContext(config), item, size, oldColour, null, input.colours);
      const warnings: Problem[] = [];
      for (const s of split) {
        const bom = this.resolver.resolveWithConfig(config, { sizeOptionId: size?.id ?? null, colourOptionId: s.colourOptionId });
        for (const w of bom.warnings) if (w.code === 'COLOUR_OPTION_NOT_SET_UP') warnings.push(w);
      }
      if (dryRun) return { dryRun: true as const, split, warnings };

      const [first, ...rest] = split;
      await tx.quoteItem.update({
        where: { id: itemId },
        data: { colourOptionId: first.colourOptionId, quantity: first.quantity, totalPrice: first.totalPrice, description: first.description },
      });
      for (const s of rest) {
        await tx.quoteItem.create({
          data: {
            quoteId,
            productId: item.productId,
            sizeOptionId: item.sizeOptionId,
            colourOptionId: s.colourOptionId,
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
      return { dryRun: false as const, split, warnings };
    }, TX_OPTS);

    if (out.dryRun) {
      return {
        dryRun: true,
        lines: out.split.map((s) => ({ colourOptionId: s.colourOptionId, quantity: s.quantity, totalPrice: s.totalPrice, description: s.description })),
        cancelledJobs: [],
        stockReleased: [],
        warnings: out.warnings,
      };
    }
    const quote = await this.findOne(quoteId);
    return { ...quote, cancelledJobs: [], stockReleased: [], warnings: out.warnings };
  }
}
