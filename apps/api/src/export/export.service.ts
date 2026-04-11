import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { toCSV } from '../common/utils/csv-export';

@Injectable()
export class ExportService {
  constructor(private prisma: PrismaService) {}

  async exportMaterials() {
    const materials = await this.prisma.material.findMany({
      orderBy: { name: 'asc' },
    });
    return toCSV(materials, [
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Type' },
      { key: 'color', label: 'Color' },
      { key: 'brand', label: 'Brand' },
      { key: 'costPerGram', label: 'Cost Per Gram' },
      { key: 'density', label: 'Density' },
      { key: 'reorderPoint', label: 'Reorder Point (g)' },
      { key: 'createdAt', label: 'Created' },
    ]);
  }

  async exportSpools() {
    const spools = await this.prisma.spool.findMany({
      include: {
        material: { select: { name: true, type: true, color: true, brand: true } },
        location: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const rows = spools.map(s => ({
      printforgeId: s.printforgeId,
      materialName: s.material.name,
      materialType: s.material.type,
      materialColor: s.material.color,
      materialBrand: s.material.brand,
      initialWeight: s.initialWeight,
      currentWeight: s.currentWeight,
      spoolWeight: s.spoolWeight,
      location: s.location?.name || '',
      lotNumber: s.lotNumber,
      purchasePrice: s.purchasePrice,
      purchaseDate: s.purchaseDate,
      isActive: s.isActive,
      createdAt: s.createdAt,
    }));
    return toCSV(rows, [
      { key: 'printforgeId', label: 'PF ID' },
      { key: 'materialName', label: 'Material' },
      { key: 'materialType', label: 'Type' },
      { key: 'materialColor', label: 'Color' },
      { key: 'materialBrand', label: 'Brand' },
      { key: 'initialWeight', label: 'Initial Weight (g)' },
      { key: 'currentWeight', label: 'Current Weight (g)' },
      { key: 'spoolWeight', label: 'Spool Weight (g)' },
      { key: 'location', label: 'Location' },
      { key: 'lotNumber', label: 'Lot Number' },
      { key: 'purchasePrice', label: 'Purchase Price' },
      { key: 'purchaseDate', label: 'Purchase Date' },
      { key: 'isActive', label: 'Active' },
      { key: 'createdAt', label: 'Created' },
    ]);
  }

  async exportProducts() {
    const products = await this.prisma.product.findMany({
      include: {
        _count: { select: { components: true } },
        defaultPrinter: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });
    const rows = products.map(p => ({
      name: p.name,
      sku: p.sku,
      description: p.description,
      estimatedGrams: p.estimatedGrams,
      estimatedMinutes: p.estimatedMinutes,
      colorChanges: p.colorChanges,
      basePrice: p.basePrice,
      defaultPrinter: (p as any).defaultPrinter?.name || '',
      components: (p as any)._count.components,
      isActive: p.isActive,
      createdAt: p.createdAt,
    }));
    return toCSV(rows, [
      { key: 'name', label: 'Name' },
      { key: 'sku', label: 'SKU' },
      { key: 'description', label: 'Description' },
      { key: 'estimatedGrams', label: 'Est. Grams' },
      { key: 'estimatedMinutes', label: 'Est. Minutes' },
      { key: 'colorChanges', label: 'Color Changes' },
      { key: 'basePrice', label: 'Base Price' },
      { key: 'defaultPrinter', label: 'Default Printer' },
      { key: 'components', label: 'Components' },
      { key: 'isActive', label: 'Active' },
      { key: 'createdAt', label: 'Created' },
    ]);
  }

  async exportOrders(from?: string, to?: string) {
    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to + 'T23:59:59Z');
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        customer: { select: { name: true, email: true } },
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = orders.map(o => ({
      orderNumber: o.orderNumber,
      customer: o.customer?.name || '',
      customerEmail: o.customer?.email || '',
      status: o.status,
      itemCount: o.items.length,
      total: o.total,
      paidAmount: o.paidAmount,
      balance: o.total - o.paidAmount,
      dueDate: o.dueDate,
      notes: o.notes,
      createdAt: o.createdAt,
    }));
    return toCSV(rows, [
      { key: 'orderNumber', label: 'Order #' },
      { key: 'customer', label: 'Customer' },
      { key: 'customerEmail', label: 'Email' },
      { key: 'status', label: 'Status' },
      { key: 'itemCount', label: 'Items' },
      { key: 'total', label: 'Total' },
      { key: 'paidAmount', label: 'Paid' },
      { key: 'balance', label: 'Balance' },
      { key: 'dueDate', label: 'Due Date' },
      { key: 'notes', label: 'Notes' },
      { key: 'createdAt', label: 'Created' },
    ]);
  }

  async exportJobs(from?: string, to?: string) {
    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to + 'T23:59:59Z');
    }

    const jobs = await this.prisma.productionJob.findMany({
      where,
      include: {
        printer: { select: { name: true } },
        product: { select: { name: true } },
        order: { select: { orderNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = jobs.map(j => ({
      name: j.name,
      status: j.status,
      printer: j.printer?.name || '',
      product: (j as any).product?.name || '',
      order: j.order?.orderNumber || '',
      colorChanges: j.colorChanges,
      materialCost: j.materialCost,
      machineCost: j.machineCost,
      totalCost: j.totalCost,
      printDuration: j.printDuration,
      createdAt: j.createdAt,
    }));
    return toCSV(rows, [
      { key: 'name', label: 'Job Name' },
      { key: 'status', label: 'Status' },
      { key: 'printer', label: 'Printer' },
      { key: 'product', label: 'Product' },
      { key: 'order', label: 'Order #' },
      { key: 'colorChanges', label: 'Color Changes' },
      { key: 'materialCost', label: 'Material Cost' },
      { key: 'machineCost', label: 'Machine Cost' },
      { key: 'totalCost', label: 'Total Cost' },
      { key: 'printDuration', label: 'Duration (s)' },
      { key: 'createdAt', label: 'Created' },
    ]);
  }

  async exportCustomers() {
    const customers = await this.prisma.customer.findMany({
      include: {
        _count: { select: { orders: true, quotes: true } },
      },
      orderBy: { name: 'asc' },
    });
    const rows = customers.map(c => ({
      name: c.name,
      email: c.email,
      phone: c.phone,
      address: c.address,
      orders: (c as any)._count.orders,
      quotes: (c as any)._count.quotes,
      isActive: c.isActive,
      createdAt: c.createdAt,
    }));
    return toCSV(rows, [
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'orders', label: 'Orders' },
      { key: 'quotes', label: 'Quotes' },
      { key: 'isActive', label: 'Active' },
      { key: 'createdAt', label: 'Created' },
    ]);
  }
}
