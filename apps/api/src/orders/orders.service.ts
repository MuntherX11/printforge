import { Injectable, NotFoundException, Optional, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    @Optional() private emailNotifications?: EmailNotificationService,
    @Optional() private whatsapp?: WhatsAppService,
    @Optional() private settingsService?: SettingsService,
  ) {}

  async create(dto: CreateOrderDto) {
    let orderNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        orderNumber = await generateNumber(this.prisma, 'ORD', 'order');
        break;
      } catch (e: any) {
        if (e.code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!orderNumber) throw new InternalServerErrorException('Failed to generate unique document number');

    const items = dto.items.map(item => ({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.quantity * item.unitPrice,
    }));

    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
    const taxRateSetting = await this.prisma.systemSetting.findUnique({ where: { key: 'tax_rate' } });
    const taxRate = parseFloat(taxRateSetting?.value || '0') / 100;
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    return this.prisma.order.create({
      data: {
        orderNumber,
        customerId: dto.customerId,
        quoteId: dto.quoteId,
        notes: dto.notes,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        subtotal,
        tax,
        total,
        items: { create: items },
      },
      include: { customer: true, items: true },
    });
  }

  async findAll(query: PaginationDto, status?: string) {
    const validStatuses = ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
    const where = status && validStatuses.includes(status) ? { status: status as any } : {};

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

    // Aggregate material requirements across all order items via their products' BOM
    const productIds = order.items
      .map((item: any) => item.productId)
      .filter((pid: any): pid is string => !!pid);

    const materialNeeds = new Map<string, { materialId: string; name: string; type: string; color: string | null; gramsNeeded: number }>();

    if (productIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { components: { include: { material: true } } },
      });
      const productMap = new Map(products.map(p => [p.id, p]));

      for (const item of order.items as any[]) {
        if (!item.productId) continue;
        const product = productMap.get(item.productId);
        if (!product?.components) continue;
        for (const comp of product.components) {
          if (!comp.materialId) continue; // multicolor — handled via ComponentMaterial
          const key = comp.materialId;
          const existing = materialNeeds.get(key);
          const gramsForItem = comp.gramsUsed * comp.quantity * item.quantity;
          if (existing) {
            existing.gramsNeeded += gramsForItem;
          } else {
            materialNeeds.set(key, {
              materialId: comp.materialId,
              name: comp.material?.name || 'Unknown',
              type: comp.material?.type || '',
              color: comp.material?.color || null,
              gramsNeeded: gramsForItem,
            });
          }
        }
      }
    }

    // Fetch active stock for all needed materials in one query
    const materialIds = Array.from(materialNeeds.keys());
    let materialAvailability: any[] = [];
    if (materialIds.length > 0) {
      // 1. Get total available stock
      const stockData = await this.prisma.spool.groupBy({
        by: ['materialId'],
        where: { materialId: { in: materialIds }, isActive: true },
        _sum: { currentWeight: true },
      });
      const stockMap = new Map(stockData.map(s => [s.materialId, s._sum.currentWeight || 0]));

      // 2. Calculate reserved stock from other open orders (CONFIRMED, IN_PRODUCTION)
      const reservingOrders = await this.prisma.order.findMany({
        where: {
          id: { not: id },
          status: { in: ['CONFIRMED', 'IN_PRODUCTION'] },
        },
        select: {
          id: true,
          items: { select: { productId: true, quantity: true } },
        },
      });

      // Gather all product IDs from reserving orders
      const reservingProductIds = new Set<string>();
      for (const ro of reservingOrders) {
        for (const item of ro.items) {
          if (item.productId) reservingProductIds.add(item.productId);
        }
      }

      // Fetch BOM for all reserving products in one query
      const reservingProducts = reservingProductIds.size > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: Array.from(reservingProductIds) } },
            include: { components: { select: { materialId: true, gramsUsed: true, quantity: true } } },
          })
        : [];
      const reservingProductMap = new Map(reservingProducts.map(p => [p.id, p]));

      const reservedByOrders = new Map<string, number>();
      const reservingOrderIds = new Set<string>();
      for (const ro of reservingOrders) {
        reservingOrderIds.add(ro.id);
        for (const item of ro.items) {
          if (!item.productId) continue;
          const product = reservingProductMap.get(item.productId);
          if (!product?.components) continue;
          for (const comp of product.components) {
            if (!comp.materialId || !materialIds.includes(comp.materialId)) continue;
            const grams = comp.gramsUsed * comp.quantity * item.quantity;
            reservedByOrders.set(comp.materialId, (reservedByOrders.get(comp.materialId) || 0) + grams);
          }
        }
      }

      // 3. Add reserved stock from standalone jobs (not tied to reserving orders)
      const reservingJobs = await this.prisma.productionJob.findMany({
        where: {
          status: { in: ['QUEUED', 'IN_PROGRESS', 'PAUSED'] },
          // Exclude jobs tied to the current order
          NOT: { orderId: id },
        },
        select: {
          orderId: true,
          materials: {
            select: { materialId: true, gramsUsed: true },
          },
        },
      });

      for (const job of reservingJobs) {
        // Skip jobs already counted via reserving orders
        if (job.orderId && reservingOrderIds.has(job.orderId)) continue;
        for (const jm of job.materials) {
          if (!materialIds.includes(jm.materialId)) continue;
          reservedByOrders.set(jm.materialId, (reservedByOrders.get(jm.materialId) || 0) + jm.gramsUsed);
        }
      }

      materialAvailability = Array.from(materialNeeds.values()).map(need => {
        const available = stockMap.get(need.materialId) || 0;
        const reserved = reservedByOrders.get(need.materialId) || 0;
        const freeStock = Math.max(0, available - reserved);
        return {
          ...need,
          gramsNeeded: Math.round(need.gramsNeeded),
          totalStock: Math.round(available),
          reservedStock: Math.round(reserved),
          freeStock: Math.round(freeStock),
          hasEnoughStock: freeStock >= need.gramsNeeded,
        };
      });
    }

    return { ...order, materialAvailability };
  }

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

  async update(id: string, dto: UpdateOrderDto) {
    const existing = await this.findOne(id);
    const validStatuses = ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: (dto.status && validStatuses.includes(dto.status)) ? (dto.status as any) : undefined,
        notes: dto.notes,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      include: { customer: true, items: true },
    });

    // Fire customer notifications on status transitions
    const prevStatus = (existing as any).status;
    const newStatus = updated.status;
    if (dto.status && newStatus !== prevStatus) {
      const customer = updated.customer as any;
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

    return updated;
  }
}
