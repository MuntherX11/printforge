import { Injectable, NotFoundException, BadRequestException, Optional, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateOrderDto, UpdateOrderDto, OrderStatus, CustomerCreateOrderDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import { generateNumber } from '../common/utils/number-generator';
import { EmailNotificationService } from '../communications/email-notification.service';
import { WhatsAppService } from '../communications/whatsapp.service';
import { DiscordNotificationService } from '../communications/discord-notification.service';
import { SettingsService } from '../settings/settings.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';

/** Minimal shape of a customer row returned via Prisma include. */
interface CustomerRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    @Optional() private emailNotifications?: EmailNotificationService,
    @Optional() private whatsapp?: WhatsAppService,
    @Optional() private settingsService?: SettingsService,
    @Optional() private discord?: DiscordNotificationService,
    @Optional() private cache?: RedisCacheService,
  ) {}

  async create(dto: CreateOrderDto) {
    let orderNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        orderNumber = await generateNumber(this.prisma, 'ORD', 'order');
        break;
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!orderNumber) throw new InternalServerErrorException('Failed to generate unique document number');

    const items = dto.items.map(item => ({
      productId: item.productId,
      variantId: item.variantId,
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

    const order = await this.prisma.order.create({
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
    this.cache?.invalidate('dashboard:kpis').catch(() => {});

    // Advisory only. The order stands; staff just need to know they have to
    // buy filament before this one can be printed.
    const stock = await this.checkStock(items).catch(() => null);
    return { ...order, stockWarnings: stock?.shortages ?? [] };
  }

  async findAll(query: PaginationDto, status?: string) {
    const validStatuses = ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
    const where = status && validStatuses.includes(status) ? { status: status as OrderStatus } : {};

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

    const materialAvailability = await this.computeMaterialAvailability(order.items, id);
    const partAvailability = await this.getPartAvailability(id, order.items);
    const printFiles = await this.getPrintFiles(order.items);

    return { ...order, materialAvailability, partAvailability, printFiles };
  }

  /**
   * Filament needed by a set of order lines, netted against what is actually
   * free: total active spool weight minus what other open orders and queued
   * jobs have already spoken for.
   *
   * `excludeOrderId` keeps an order from reserving against itself. Pass null
   * when checking an order that does not exist yet.
   */
  private async computeMaterialAvailability(
    items: Array<{ productId: string | null; quantity: number }>,
    excludeOrderId: string | null,
  ) {
    // Aggregate material requirements across all order items via their products' BOM
    const productIds = items
      .map((item) => item.productId)
      .filter((pid): pid is string => !!pid);

    const materialNeeds = new Map<string, { materialId: string; name: string; type: string; color: string | null; gramsNeeded: number }>();

    if (productIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { components: { include: { material: true } } },
      });
      const productMap = new Map(products.map(p => [p.id, p]));

      for (const item of items) {
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
    type MaterialAvailability = {
      materialId: string; name: string; type: string; color: string | null;
      gramsNeeded: number; totalStock: number; reservedStock: number;
      freeStock: number; hasEnoughStock: boolean;
    };
    let materialAvailability: MaterialAvailability[] = [];
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
          ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
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
          ...(excludeOrderId ? { NOT: { orderId: excludeOrderId } } : {}),
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

    return materialAvailability;
  }

  /**
   * Preflight for the New Order screen: what would be short if this order were
   * placed right now. Advisory, not a block — a print farm takes the order and
   * buys filament, it does not turn the customer away.
   */
  async checkStock(items: Array<{ productId?: string | null; quantity: number }>) {
    const normalised = (items || [])
      .filter(i => i && Number.isFinite(i.quantity) && i.quantity > 0)
      .map(i => ({ productId: i.productId ?? null, quantity: i.quantity }));
    if (normalised.length === 0) return { materials: [], shortages: [], ok: true };

    const materials = await this.computeMaterialAvailability(normalised, null);
    const shortages = materials.filter(m => !m.hasEnoughStock);
    return { materials, shortages, ok: shortages.length === 0 };
  }

  /**
   * The slicer files needed to actually print this order, so the operator does
   * not have to go hunting through the product catalogue for them. One entry
   * per component that was onboarded from a 3MF/G-code upload.
   */
  private async getPrintFiles(items: Array<{ id: string; productId: string | null; quantity: number }>) {
    const productIds = Array.from(
      new Set(items.map(i => i.productId).filter((p): p is string => !!p)),
    );
    if (productIds.length === 0) return [];

    const components = await this.prisma.productComponent.findMany({
      where: { productId: { in: productIds }, attachmentId: { not: null } },
      select: {
        id: true, productId: true, description: true, gcodeFilename: true,
        colorChanges: true, attachmentId: true,
        product: { select: { name: true } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    if (components.length === 0) return [];

    // The attachment may have been deleted out from under the component; only
    // offer links that will actually resolve.
    const attachments = await this.prisma.attachment.findMany({
      where: { id: { in: components.map(c => c.attachmentId!) } },
      select: { id: true, originalName: true, sizeBytes: true },
    });
    const byId = new Map(attachments.map(a => [a.id, a]));

    return components.flatMap(c => {
      const file = byId.get(c.attachmentId!);
      if (!file) return [];
      return items
        .filter(i => i.productId === c.productId)
        .map(i => ({
          orderItemId: i.id,
          productName: c.product?.name ?? 'Product',
          component: c.description,
          quantity: i.quantity,
          attachmentId: c.attachmentId!,
          filename: c.gcodeFilename || file.originalName,
          sizeBytes: file.sizeBytes,
          colorChanges: c.colorChanges,
        }));
    });
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

  async createForCustomer(customerId: string, dto: CustomerCreateOrderDto) {
    if (!dto.items?.length) throw new BadRequestException('Order must have at least one item');

    for (const item of dto.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
        throw new BadRequestException('Quantity must be a whole number between 1 and 50');
      }
    }

    // Resolve prices from DB — never trust client-supplied prices
    const resolvedItems = await Promise.all(
      dto.items.map(async item => {
        if (item.variantId) {
          const variant = await this.prisma.productVariant.findFirst({
            where: { id: item.variantId, isActive: true },
            select: { id: true, name: true, basePrice: true, product: { select: { id: true, name: true } } },
          });
          if (!variant) throw new BadRequestException('Selected option is no longer available');
          const variantPrice = variant.basePrice ?? 0;
          if (variantPrice <= 0) throw new BadRequestException(`"${variant.name}" has no price set — please contact us for a quote`);
          return {
            productId: variant.product.id,
            variantId: variant.id,
            description: `${variant.product.name} — ${variant.name}`,
            quantity: item.quantity,
            unitPrice: variantPrice,
            totalPrice: Math.round(item.quantity * variantPrice * 1000) / 1000,
          };
        } else if (item.productId) {
          const product = await this.prisma.product.findFirst({
            where: { id: item.productId, isActive: true },
            select: { id: true, name: true, basePrice: true },
          });
          if (!product) throw new BadRequestException('Selected product is no longer available');
          if (product.basePrice <= 0) throw new BadRequestException(`"${product.name}" has no price set — please contact us for a quote`);
          return {
            productId: product.id,
            variantId: undefined,
            description: product.name,
            quantity: item.quantity,
            unitPrice: product.basePrice,
            totalPrice: Math.round(item.quantity * product.basePrice * 1000) / 1000,
          };
        }
        throw new BadRequestException('Each item must have variantId or productId');
      }),
    );

    let orderNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        orderNumber = await generateNumber(this.prisma, 'ORD', 'order');
        break;
      } catch (e: unknown) {
        if ((e as { code?: string }).code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!orderNumber) throw new InternalServerErrorException('Failed to generate unique document number');

    const subtotal = Math.round(resolvedItems.reduce((sum, item) => sum + item.totalPrice, 0) * 1000) / 1000;
    const taxRateSetting = await this.prisma.systemSetting.findUnique({ where: { key: 'tax_rate' } });
    const taxRateRaw = parseFloat(taxRateSetting?.value || '0');
    const taxRate = (taxRateRaw >= 0 && taxRateRaw <= 100) ? taxRateRaw / 100 : 0;
    const tax = Math.round(subtotal * taxRate * 1000) / 1000;
    const total = Math.round((subtotal + tax) * 1000) / 1000;
    const sanitizedNotes = dto.notes
      ? dto.notes.replace(/<[^>]*>/g, '').trim().slice(0, 1000) || undefined
      : undefined;

    const order = await this.prisma.order.create({
      data: {
        orderNumber,
        customerId,
        notes: sanitizedNotes,
        subtotal,
        tax,
        total,
        items: { create: resolvedItems },
      },
      include: {
        items: true,
        customer: { select: { name: true } },
      },
    });

    this.discord?.notifyNewPortalOrder({
      orderNumber: order.orderNumber,
      customerName: (order.customer as { name: string } | null)?.name ?? 'Customer',
      total: order.total,
      itemCount: order.items.length,
    }).catch(() => {});

    return order;
  }

  async update(id: string, dto: UpdateOrderDto) {
    const existing = await this.findOne(id);
    const validStatuses = ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: dto.status ?? undefined,
        notes: dto.notes,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      include: { customer: true, items: true },
    });

    // Fire customer notifications on status transitions
    const prevStatus = existing.status;
    const newStatus = updated.status;
    if (dto.status && newStatus !== prevStatus) {
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
    return updated;
  }
}
