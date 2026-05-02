import { Injectable, NotFoundException, BadRequestException, Optional, InternalServerErrorException, ConflictException } from '@nestjs/common';
import { CustomerQuoteRequestDto } from './dto/customer-quote-request.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateQuoteDto, UpdateQuoteDto, SaveQuoteFromAnalysisDto, QuoteStatus, QuoteSource } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';
import { OrdersService } from '../orders/orders.service';
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

@Injectable()
export class QuotesService {
  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
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
      include: { customer: true, items: true },
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
      include: { customer: true, items: true },
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
      include: { customer: true, items: true },
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

  async create(dto: CreateQuoteDto) {
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

    const items = dto.items.map(item => ({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.quantity * item.unitPrice,
      estimatedGrams: item.estimatedGrams,
      estimatedMinutes: item.estimatedMinutes,
      estimatedColors: item.estimatedColors,
      estimatedCost: item.estimatedCost,
      marginPercent: item.marginPercent,
    }));

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
    const taxRateSetting = await this.prisma.systemSetting.findUnique({ where: { key: 'tax_rate' } });
    const taxRate = parseFloat(taxRateSetting?.value || '0') / 100;
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    return this.prisma.quote.create({
      data: {
        quoteNumber,
        customerId: dto.customerId,
        notes: dto.notes,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        subtotal,
        tax,
        total,
        items: { create: items },
      },
      include: { customer: true, items: true },
    });
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

  async findOne(id: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { customer: true, items: true, order: true, attachments: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    return quote;
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

  async convertToOrder(id: string, options?: { autoCreateJobs?: boolean }) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { items: true, order: true, customer: true },
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

    // Atomically flip status to ACCEPTED — guards against concurrent conversion attempts.
    // updateMany only succeeds if status is still SENT/ACCEPTED and no order exists yet.
    // If a concurrent request already created the order, the DB unique constraint on
    // Order.quoteId will surface as a P2002 below; we convert it to a 409.
    if (quote.status === 'SENT') {
      const flipped = await this.prisma.quote.updateMany({
        where: { id, status: 'SENT' },
        data: { status: 'ACCEPTED' },
      });
      if (flipped.count === 0) {
        throw new ConflictException('Quote status changed by a concurrent request — please retry');
      }
    }

    // Create order carrying over productId
    let order: Awaited<ReturnType<typeof this.ordersService.create>>;
    try {
      order = await this.ordersService.create({
        customerId: quote.customerId,
        quoteId: quote.id,
        items: quote.items.map(item => ({
          productId: item.productId || undefined,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      });
    } catch (e: unknown) {
      // P2002 on Order.quoteId unique constraint means a concurrent request beat us
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('Quote already converted to order by a concurrent request');
      }
      throw e;
    }

    // Auto-create production jobs for each order item if requested
    if (options?.autoCreateJobs !== false) {
      const orderWithItems = await this.prisma.order.findUnique({
        where: { id: order.id },
        include: { items: true },
      });

      if (orderWithItems) {
        for (const item of orderWithItems.items) {
          // Load product info for the job name
          let jobName = item.description;
          let colorChanges = 0;

          if (item.productId) {
            const product = await this.prisma.product.findUnique({
              where: { id: item.productId },
            });
            if (product) {
              jobName = product.name;
              colorChanges = product.colorChanges;
            }
          }

          // Create one job per quantity unit
          for (let q = 0; q < item.quantity; q++) {
            await this.prisma.productionJob.create({
              data: {
                name: item.quantity > 1 ? `${jobName} (${q + 1}/${item.quantity})` : jobName,
                orderId: order.id,
                orderItemId: item.id,
                colorChanges,
                status: 'QUEUED',
              },
            });
          }
        }
      }
    }

    return order;
  }
}
