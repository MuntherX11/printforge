'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { useWebSocket, type PrinterStatusEvent } from '@/lib/use-websocket';
import type { DashboardKPIs } from '@printforge/types';
import { Thermometer, Pause, Play, XCircle } from 'lucide-react';
import { Loading } from '@/components/ui/loading';
import { useToast } from '@/components/ui/toast';

function ActivePrintCard({ printerId, status, printerName }: { printerId: string; status: PrinterStatusEvent; printerName: string }) {
  const { toast } = useToast();
  const [controlling, setControlling] = useState(false);
  const isPrinting = status.printStats?.state === 'printing';
  const isPaused = status.printStats?.state === 'paused';
  const progress = status.progress ? Math.round(status.progress * 100) : 0;

  async function control(action: 'pause' | 'resume' | 'cancel') {
    setControlling(true);
    try {
      await api.post(`/moonraker/control/${printerId}/${action}`);
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setControlling(false);
    }
  }

  return (
    <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20">
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Thermometer className="h-4 w-4 text-blue-600" />
            <span className="font-semibold text-sm">{printerName}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              isPrinting ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
            }`}>
              {status.printStats?.state ?? status.printerState ?? 'active'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(isPrinting || isPaused) && (
              <>
                {isPrinting && (
                  <Button variant="outline" size="sm" onClick={() => control('pause')} disabled={controlling}>
                    <Pause className="h-3.5 w-3.5 mr-1" /> Pause
                  </Button>
                )}
                {isPaused && (
                  <Button variant="outline" size="sm" onClick={() => control('resume')} disabled={controlling}>
                    <Play className="h-3.5 w-3.5 mr-1" /> Resume
                  </Button>
                )}
                <Button variant="outline" size="sm" className="text-red-500 border-red-300 hover:bg-red-50 dark:hover:bg-red-950/20" onClick={() => control('cancel')} disabled={controlling}>
                  <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Nozzle</p>
            <p className="font-medium">
              {status.extruder
                ? `${status.extruder.temperature.toFixed(1)}°C / ${status.extruder.target}°C`
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Bed</p>
            <p className="font-medium">
              {status.heaterBed
                ? `${status.heaterBed.temperature.toFixed(1)}°C / ${status.heaterBed.target}°C`
                : '—'}
            </p>
          </div>
          <div className="truncate">
            <p className="text-xs text-gray-500 dark:text-gray-400">File</p>
            <p className="font-medium truncate">{status.printStats?.filename ?? '—'}</p>
          </div>
        </div>

        {/* Progress bar */}
        {(isPrinting || isPaused) && (
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-500 dark:text-gray-400">Progress</span>
              <span className="font-semibold">{progress}%</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
              <div
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Print progress"
                className={`h-2.5 rounded-full transition-all ${isPaused ? 'bg-amber-400' : 'bg-blue-600'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [loading, setLoading] = useState(true);
  const [printerNames, setPrinterNames] = useState<Record<string, string>>({});
  const { printerStatuses } = useWebSocket();
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();

  // Fetch printer names once for the active print cards
  useEffect(() => {
    api.get<any[]>('/printers').then((printers) => {
      const map: Record<string, string> = {};
      for (const p of printers) map[p.id] = p.name;
      setPrinterNames(map);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.get<DashboardKPIs>('/reports/dashboard')
      .then(setKpis)
      .catch((err: any) => toast('error', err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  // Printers actively printing or paused via WebSocket
  const activePrints = Object.entries(printerStatuses).filter(
    ([, s]) => s.printStats?.state === 'printing' || s.printStats?.state === 'paused'
  );

  if (loading) return <Loading text="Loading dashboard..." />;
  if (!kpis) return (
    <div className="text-center py-12 space-y-3">
      <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load dashboard</p>
      <button onClick={() => window.location.reload()} className="text-sm text-brand-600 hover:underline">
        Try again
      </button>
    </div>
  );

  const stats = [
    { name: 'Active Jobs', value: String(kpis.activeJobs), color: 'text-blue-600 dark:text-blue-400' },
    { name: 'Pending Orders', value: String(kpis.pendingOrders), color: 'text-amber-600 dark:text-amber-400' },
    {
      name: 'Low Stock',
      value: String(kpis.lowStockMaterials),
      color: kpis.lowStockMaterials > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400',
    },
    { name: 'Monthly Revenue', value: formatCurrency(kpis.monthlyRevenue), color: 'text-gray-900 dark:text-gray-100' },
    {
      name: 'Monthly Profit',
      value: formatCurrency(kpis.monthlyProfit),
      color: kpis.monthlyProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
    },
    { name: 'Printer Utilization', value: `${Math.round(kpis.printerUtilization)}%`, color: 'text-gray-900 dark:text-gray-100' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>

      {/* Active prints — only shown when something is printing */}
      {activePrints.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
            Printing Now
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {activePrints.map(([id, status]) => (
              <ActivePrintCard
                key={id}
                printerId={id}
                status={status}
                printerName={printerNames[id] ?? 'Printer'}
              />
            ))}
          </div>
        </div>
      )}

      {/* KPI summary strip — ledger row, not hero cards */}
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        {stats.map((stat) => (
          <div key={stat.name} className="px-5 py-4 flex flex-col gap-0.5">
            <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{stat.name}</dt>
            <dd className={`text-xl font-semibold tabular-nums min-w-0 truncate ${stat.color}`}>{stat.value}</dd>
          </div>
        ))}
      </dl>

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
