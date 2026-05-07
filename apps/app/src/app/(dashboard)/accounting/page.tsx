'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

const AccountingChart = dynamic(
  () => import('./AccountingChart'),
  { ssr: false, loading: () => <div className="h-60 animate-pulse bg-gray-100 dark:bg-gray-800 rounded" /> }
);
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { BarChart2, Package } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function AccountingPage() {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [report, setReport] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [margins, setMargins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));

  function loadReport() {
    setLoading(true);
    Promise.all([
      api.get<any>(`/reports/pnl?startDate=${startDate}&endDate=${endDate}`),
      api.get<any[]>('/reports/monthly-trend?months=6'),
      api.get<any[]>('/reports/product-margins'),
    ])
      .then(([r, t, m]) => { setReport(r); setTrend(t); setMargins(m); })
      .catch((err) => {
        console.error(err);
        toast('error', 'Failed to load accounting data');
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadReport(); }, []);

  const grossMarginColor = report
    ? report.grossMargin >= 50 ? 'text-green-600' : report.grossMargin >= 25 ? 'text-amber-600' : 'text-red-600'
    : 'text-gray-600';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Accounting</h1>
        <Link href="/accounting/expenses">
          <Button variant="outline">Manage Expenses</Button>
        </Link>
      </div>

      {/* Date range picker */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-4 items-end">
            <Input label="From" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            <Input label="To" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            <Button onClick={loadReport}>Generate Report</Button>
          </div>
        </CardContent>
      </Card>

      {loading ? <Loading /> : report && (
        <>
          {/* P&L ledger strip */}
          <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
            <div className="px-5 py-4 flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Revenue</dt>
              <dd className="text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCurrency(report.revenue)}</dd>
              <p className="text-xs text-gray-400 dark:text-gray-500">{report.orderCount} invoice{report.orderCount !== 1 ? 's' : ''}</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">COGS</dt>
              <dd className="text-xl font-semibold tabular-nums text-orange-600 dark:text-orange-400">{formatCurrency(report.cogs)}</dd>
              <p className="text-xs text-gray-400 dark:text-gray-500">{report.jobCount} job{report.jobCount !== 1 ? 's' : ''}</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Gross Profit</dt>
              <dd className={`text-xl font-semibold tabular-nums ${report.grossProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{formatCurrency(report.grossProfit)}</dd>
              <p className="text-xs text-gray-400 dark:text-gray-500">{report.grossMargin.toFixed(1)}% margin</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Op. Expenses</dt>
              <dd className="text-xl font-semibold tabular-nums text-purple-600 dark:text-purple-400">{formatCurrency(report.expenses)}</dd>
            </div>
            <div className="px-5 py-4 flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Net Profit</dt>
              <dd className={`text-xl font-semibold tabular-nums ${report.netProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{formatCurrency(report.netProfit)}</dd>
              <p className="text-xs text-gray-400 dark:text-gray-500">{report.netMargin.toFixed(1)}% net margin</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-0.5">
              <dt className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Gross Margin</dt>
              <dd className={`text-xl font-semibold tabular-nums ${grossMarginColor}`}>{report.grossMargin.toFixed(1)}%</dd>
              <p className="text-xs text-gray-400 dark:text-gray-500">Revenue − COGS</p>
            </div>
          </dl>

          {/* Monthly trend chart + P&L summary */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Trend chart */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart2 className="h-4 w-4" /> 6-Month Trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                <AccountingChart trend={trend} />
              </CardContent>
            </Card>

            {/* P&L summary */}
            <Card>
              <CardHeader><CardTitle>P&L Summary</CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-2.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Revenue</dt>
                    <dd className="font-medium text-green-600">{formatCurrency(report.revenue)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">COGS (Production)</dt>
                    <dd className="font-medium text-orange-600">−{formatCurrency(report.cogs)}</dd>
                  </div>
                  <div className="flex justify-between border-t dark:border-gray-700 pt-2">
                    <dt className="font-semibold">Gross Profit</dt>
                    <dd className="font-bold">{formatCurrency(report.grossProfit)} <span className="text-gray-400 font-normal">({report.grossMargin.toFixed(1)}%)</span></dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Operating Expenses</dt>
                    <dd className="font-medium text-purple-600">−{formatCurrency(report.expenses)}</dd>
                  </div>
                  <div className="flex justify-between border-t dark:border-gray-700 pt-2">
                    <dt className="font-semibold">Net Profit</dt>
                    <dd className={`font-bold ${report.netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(report.netProfit)} <span className="text-gray-400 font-normal">({report.netMargin.toFixed(1)}%)</span>
                    </dd>
                  </div>
                </dl>

                {/* Expenses by category */}
                {report.expensesByCategory && Object.keys(report.expensesByCategory).length > 0 && (
                  <div className="mt-5 pt-4 border-t dark:border-gray-700">
                    <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Expenses by Category</p>
                    <div className="space-y-1.5">
                      {Object.entries(report.expensesByCategory || {})
                        .sort(([, a]: any, [, b]: any) => (b as number) - (a as number))
                        .map(([cat, amount]: any) => (
                          <div key={cat} className="flex justify-between text-sm">
                            <span className="text-gray-600 dark:text-gray-400">{cat}</span>
                            <span className="font-medium">{formatCurrency(amount)}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Per-product margins */}
          {margins.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Package className="h-4 w-4" /> Product Profitability
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b dark:border-gray-700 text-left">
                        <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Product</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-right">Jobs</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-right">Revenue</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-right">COGS</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-right">Gross Profit</th>
                        <th className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {margins.map((p: any) => (
                        <tr key={p.productId} className="border-b dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-4 py-3 font-medium">{p.productName}</td>
                          <td className="px-4 py-3 text-right text-gray-500">{p.jobCount}</td>
                          <td className="px-4 py-3 text-right">{formatCurrency(p.revenue)}</td>
                          <td className="px-4 py-3 text-right text-orange-600">{formatCurrency(p.cogs)}</td>
                          <td className={`px-4 py-3 text-right font-medium ${p.grossProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(p.grossProfit)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                              p.margin >= 50 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                              : p.margin >= 25 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                              : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                            }`}>
                              {p.margin.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
