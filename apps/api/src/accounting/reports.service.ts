import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private cache: RedisCacheService,
  ) {}

  async getProfitAndLoss(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date format — expected ISO 8601 (e.g. 2026-01-01)');
    }

    // Revenue: sum of paid invoices in period
    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: 'PAID',
        paidAt: { gte: start, lte: end },
      },
    });
    const revenue = invoices.reduce((sum, inv) => sum + inv.paidAmount, 0);

    // COGS: sum of production costs for completed jobs in period
    const jobs = await this.prisma.productionJob.findMany({
      where: {
        status: 'COMPLETED',
        completedAt: { gte: start, lte: end },
      },
    });
    const cogs = jobs.reduce((sum, job) => sum + (job.totalCost || 0), 0);

    // Expenses in period
    const expenses = await this.prisma.expense.findMany({
      where: { date: { gte: start, lte: end } },
      include: { category: true },
    });
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

    // Breakdown by category
    const expensesByCategory = expenses.reduce((acc, exp) => {
      const cat = exp.category.name;
      acc[cat] = (acc[cat] || 0) + exp.amount;
      return acc;
    }, {} as Record<string, number>);

    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - totalExpenses;

    return {
      period: { startDate, endDate },
      revenue,
      cogs,
      grossProfit,
      grossMargin: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
      expenses: totalExpenses,
      expensesByCategory,
      netProfit,
      netMargin: revenue > 0 ? (netProfit / revenue) * 100 : 0,
      orderCount: invoices.length,
      jobCount: jobs.length,
    };
  }

  /**
   * Returns revenue, COGS, and gross profit for each of the last N months.
   * Used to power the trend chart on the accounting page.
   */
  async getMonthlyTrend(months = 6) {
    return this.cache.getOrSet(`reports:monthly:${months}`, 300, async () => {
      const result: Array<{
        month: string; revenue: number; cogs: number; grossProfit: number;
      }> = [];

      const now = new Date();
      for (let i = months - 1; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

        const [invoices, jobs] = await Promise.all([
          this.prisma.invoice.findMany({
            where: { status: 'PAID', paidAt: { gte: start, lte: end } },
            select: { paidAmount: true },
          }),
          this.prisma.productionJob.findMany({
            where: { status: 'COMPLETED', completedAt: { gte: start, lte: end } },
            select: { totalCost: true },
          }),
        ]);

        const revenue = invoices.reduce((s, inv) => s + inv.paidAmount, 0);
        const cogs = jobs.reduce((s, j) => s + (j.totalCost || 0), 0);
        result.push({
          month: start.toLocaleString('default', { month: 'short', year: '2-digit' }),
          revenue,
          cogs,
          grossProfit: revenue - cogs,
        });
      }
      return result;
    });
  }

  /**
   * Returns per-product profitability: revenue contribution vs COGS.
   * Only includes products that have at least one completed job.
   */
  async getProductMargins() {
    return this.cache.getOrSet('reports:margins', 300, async () => {
      const jobs = await this.prisma.productionJob.findMany({
        where: { status: 'COMPLETED', totalCost: { not: null } },
        select: {
          totalCost: true,
          product: { select: { id: true, name: true, basePrice: true } },
          orderItem: { select: { totalPrice: true } },
          quantityToProduce: true,
        },
      });

      const map = new Map<string, {
        productId: string; productName: string;
        revenue: number; cogs: number; jobCount: number;
      }>();

      for (const job of jobs) {
        if (!job.product) continue;
        const key = job.product.id;
        const revenue = job.orderItem?.totalPrice ?? 0;
        const cogs = job.totalCost ?? 0;
        const existing = map.get(key);
        if (existing) {
          existing.revenue += revenue;
          existing.cogs += cogs;
          existing.jobCount += 1;
        } else {
          map.set(key, {
            productId: job.product.id,
            productName: job.product.name,
            revenue,
            cogs,
            jobCount: 1,
          });
        }
      }

      return Array.from(map.values())
        .map(p => ({
          ...p,
          grossProfit: p.revenue - p.cogs,
          margin: p.revenue > 0 ? ((p.revenue - p.cogs) / p.revenue) * 100 : 0,
        }))
        .sort((a, b) => b.grossProfit - a.grossProfit);
    });
  }

  async getDashboardKPIs() {
    return this.cache.getOrSet('dashboard:kpis', 60, async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [
        activeJobs,
        pendingOrders,
        monthlyInvoices,
        completedJobsThisMonth,
        printers,
      ] = await Promise.all([
        this.prisma.productionJob.count({ where: { status: { in: ['QUEUED', 'IN_PROGRESS'] } } }),
        this.prisma.order.count({ where: { status: { in: ['PENDING', 'CONFIRMED'] } } }),
        this.prisma.invoice.findMany({
          where: { status: 'PAID', paidAt: { gte: monthStart } },
          select: { paidAmount: true },
        }),
        this.prisma.productionJob.findMany({
          where: { status: 'COMPLETED', completedAt: { gte: monthStart } },
          select: { totalCost: true },
        }),
        this.prisma.printer.findMany({ where: { isActive: true } }),
      ]);

      const monthlyRevenue = monthlyInvoices.reduce((sum, inv) => sum + inv.paidAmount, 0);
      const monthlyCost = completedJobsThisMonth.reduce((sum, job) => sum + (job.totalCost || 0), 0);

      // Low stock check
      const [materials, stockByMaterial] = await Promise.all([
        this.prisma.material.findMany({ select: { id: true, reorderPoint: true } }),
        this.prisma.spool.groupBy({
          by: ['materialId'],
          where: { isActive: true },
          _sum: { currentWeight: true },
        }),
      ]);
      const stockMap = new Map(stockByMaterial.map(s => [s.materialId, s._sum.currentWeight ?? 0]));
      const lowStockMaterials = materials.filter(m => (stockMap.get(m.id) ?? 0) < m.reorderPoint).length;

      // Printer utilization: how many are currently printing
      const printingCount = printers.filter(p => p.status === 'PRINTING').length;
      const printerUtilization = printers.length > 0 ? (printingCount / printers.length) * 100 : 0;

      // Recent items
      const recentJobs = await this.prisma.productionJob.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { printer: { select: { name: true } } },
      });

      const recentOrders = await this.prisma.order.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: { select: { name: true } } },
      });

      return {
        activeJobs,
        pendingOrders,
        lowStockMaterials,
        monthlyRevenue,
        monthlyProfit: monthlyRevenue - monthlyCost,
        printerUtilization,
        recentJobs: recentJobs.map(j => ({
          id: j.id,
          name: j.name,
          status: j.status,
          printerName: j.printer?.name,
        })),
        recentOrders: recentOrders.map(o => ({
          id: o.id,
          orderNumber: o.orderNumber,
          customerName: o.customer.name,
          status: o.status,
          total: o.total,
        })),
      };
    });
  }
}
