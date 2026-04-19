'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { useFormatCurrency } from '@/lib/locale-context';
import { TrendingUp, TrendingDown, DollarSign, BarChart2, Package, Percent } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

// ── Recharts custom tooltip ──────────────────────────────────────────────────
function CurrencyTooltip({ active, payload, label }: any) {
  const formatCurrency = useFormatCurrency();
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-sm">
      <p className="font-semibold mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex justify-between gap-6">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-medium">{formatCurrency(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string; sub?: string; icon: any; color: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            {sub && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</p>}
          </div>
          <Icon className={`h-7 w-7 ${color} opacity-40 mt-0.5`} />
        </div>
      </CardContent>
    </Card>
  );
}

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
          {/* KPI cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <KpiCard label="Revenue" value={formatCurrency(report.revenue)}
              sub={`${report.orderCount} paid invoice${report.orderCount !== 1 ? 's' : ''}`}
              icon={TrendingUp} color="text-green-600" />
            <KpiCard label="COGS" value={formatCurrency(report.cogs)}
              sub={`${report.jobCount} completed job${report.jobCount !== 1 ? 's' : ''}`}
              icon={DollarSign} color="text-orange-600" />
            <KpiCard label="Gross Profit" value={formatCurrency(report.grossProfit)}
              sub={`${report.grossMargin.toFixed(1)}% margin`}
              icon={Percent} color={report.grossProfit >= 0 ? 'text-green-600' : 'text-red-600'} />
            <KpiCard label="Operating Expenses" value={formatCurrency(report.expenses)}
              icon={BarChart2} color="text-purple-600" />
            <KpiCard label="Net Profit" value={formatCurrency(report.netProfit)}
              sub={`${report.netMargin.toFixed(1)}% net margin`}
              icon={report.netProfit >= 0 ? TrendingUp : TrendingDown}
              color={report.netProfit >= 0 ? 'text-green-600' : 'text-red-600'} />
            <KpiCard label="Gross Margin" value={`${report.grossMargin.toFixed(1)}%`}
              sub="Revenue − COGS ÷ Revenue"
              icon={Percent} color={grossMarginColor} />
          </div>

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
                {trend.length === 0 ? (
                  <p className="text-sm text-gray-500 py-8 text-center">No data yet</p>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${v.toFixed(0)}`} />
                      <Tooltip content={<CurrencyTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="revenue" name="Revenue" fill="#22c55e" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="cogs" name="COGS" fill="#f97316" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="grossProfit" name="Gross Profit" fill="#2563eb" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
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
