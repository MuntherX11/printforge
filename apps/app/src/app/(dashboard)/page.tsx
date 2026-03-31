'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { DashboardKPIs } from '@printforge/types';
import { Package, ShoppingCart, Hammer, Printer, TrendingUp, AlertTriangle } from 'lucide-react';
import { Loading } from '@/components/ui/loading';

export default function DashboardPage() {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<DashboardKPIs>('/reports/dashboard')
      .then(setKpis)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading text="Loading dashboard..." />;
  if (!kpis) return <div className="text-center py-12 text-gray-500">Failed to load dashboard</div>;

  const stats = [
    { name: 'Active Jobs', value: kpis.activeJobs, icon: Hammer, color: 'text-blue-600' },
    { name: 'Pending Orders', value: kpis.pendingOrders, icon: ShoppingCart, color: 'text-yellow-600' },
    { name: 'Low Stock', value: kpis.lowStockMaterials, icon: AlertTriangle, color: kpis.lowStockMaterials > 0 ? 'text-red-600' : 'text-green-600' },
    { name: 'Monthly Revenue', value: formatCurrency(kpis.monthlyRevenue), icon: TrendingUp, color: 'text-green-600' },
    { name: 'Monthly Profit', value: formatCurrency(kpis.monthlyProfit), icon: TrendingUp, color: kpis.monthlyProfit >= 0 ? 'text-green-600' : 'text-red-600' },
    { name: 'Printer Utilization', value: `${Math.round(kpis.printerUtilization)}%`, icon: Printer, color: 'text-indigo-600' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.name}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-500">{stat.name}</p>
                  <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                </div>
                <stat.icon className={`h-8 w-8 ${stat.color} opacity-50`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Recent Jobs</CardTitle></CardHeader>
          <CardContent>
            {kpis.recentJobs.length === 0 ? (
              <p className="text-sm text-gray-500">No jobs yet</p>
            ) : (
              <div className="space-y-3">
                {kpis.recentJobs.map((job) => (
                  <div key={job.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{job.name}</p>
                      {job.printerName && <p className="text-xs text-gray-500">{job.printerName}</p>}
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recent Orders</CardTitle></CardHeader>
          <CardContent>
            {kpis.recentOrders.length === 0 ? (
              <p className="text-sm text-gray-500">No orders yet</p>
            ) : (
              <div className="space-y-3">
                {kpis.recentOrders.map((order) => (
                  <div key={order.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{order.orderNumber}</p>
                      <p className="text-xs text-gray-500">{order.customerName}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{formatCurrency(order.total)}</span>
                      <StatusBadge status={order.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
