import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateQuoteDto, UpdateQuoteDto, SaveQuoteFromAnalysisDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class QuotesService {
  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
  ) {}

  async createFromAnalysis(dto: SaveQuoteFromAnalysisDto, createdById?: string) {
    const quoteNumber = await generateNumber(this.prisma, 'QT', 'quote');

    const cost = dto.costEstimate;
    const suggestedPrice = cost?.suggestedPrice || 0;

    // 3-day validity
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 3);

    const isGcode = !!dto.analysis?.slicer;

    return this.prisma.quote.create({
      data: {
        quoteNumber,
        customerId: dto.customerId,
        source: (dto.source as any) || 'QUICK_QUOTE',
        notes: dto.notes || null,
        validUntil,
        subtotal: suggestedPrice,
        tax: 0,
        total: suggestedPrice,
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
    const quoteNumber = await generateNumber(this.prisma, 'QT', 'quote');

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
    const where = status ? { status: status as any } : {};
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
    await this.findOne(id);
    return this.prisma.quote.update({
      where: { id },
      data: {
        status: dto.status as any,
        notes: dto.notes,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
      },
      include: { customer: true, items: true },
    });
  }

  async convertToOrder(id: string, options?: { autoCreateJobs?: boolean }) {
    const quote = await this.prisma.quote.findUnique({
      where: { id },
      include: { items: true, order: true, customer: true },
    });
    if (!quote) throw new NotFoundException('Quote not found');
    if (quote.order) throw new BadRequestException('Quote already converted to order');

    // Allow conversion from ACCEPTED or SENT status (auto-accept if SENT)
    if (!['ACCEPTED', 'SENT'].includes(quote.status)) {
      throw new BadRequestException('Quote must be SENT or ACCEPTED to convert');
    }

    // Reject expired quotes
    if (quote.validUntil && new Date(quote.validUntil) < new Date()) {
      throw new BadRequestException('Quote has expired and can no longer be converted to an order');
    }

    // Auto-mark as ACCEPTED if currently SENT
    if (quote.status === 'SENT') {
      await this.prisma.quote.update({
        where: { id },
        data: { status: 'ACCEPTED' },
      });
    }

    // Create order carrying over productId
    const order = await this.ordersService.create({
      customerId: quote.customerId,
      quoteId: quote.id,
      items: quote.items.map(item => ({
        productId: item.productId || undefined,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    });

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
