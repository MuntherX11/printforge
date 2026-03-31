import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getProfitAndLoss(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);

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

  async getDashboardKPIs() {
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
      }),
      this.prisma.productionJob.findMany({
        where: { status: 'COMPLETED', completedAt: { gte: monthStart } },
      }),
      this.prisma.printer.findMany({ where: { isActive: true } }),
    ]);

    const monthlyRevenue = monthlyInvoices.reduce((sum, inv) => sum + inv.paidAmount, 0);
    const monthlyCost = completedJobsThisMonth.reduce((sum, job) => sum + (job.totalCost || 0), 0);

    // Low stock check
    const materials = await this.prisma.material.findMany({
      include: { spools: { where: { isActive: true } } },
    });
    const lowStockMaterials = materials.filter(m => {
      const totalWeight = m.spools.reduce((sum, s) => sum + s.currentWeight, 0);
      return totalWeight < m.reorderPoint;
    }).length;

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
  }
}
