'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { TrendingUp, TrendingDown, DollarSign } from 'lucide-react';

export default function AccountingPage() {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));

  function loadReport() {
    setLoading(true);
    api.get(`/reports/pnl?startDate=${startDate}&endDate=${endDate}`)
      .then(setReport).catch(console.error).finally(() => setLoading(false));
  }

  useEffect(() => { loadReport(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Accounting</h1>
        <div className="flex gap-2">
          <Link href="/accounting/expenses"><Button variant="outline">Expenses</Button></Link>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4 items-end">
            <Input label="Start Date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            <Input label="End Date" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            <Button onClick={loadReport}>Generate</Button>
          </div>
        </CardContent>
      </Card>

      {loading ? <Loading /> : report && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardContent className="p-6"><div className="flex items-center justify-between"><div><p className="text-sm text-gray-500">Revenue</p><p className="text-2xl font-bold text-green-600">{formatCurrency(report.revenue)}</p></div><TrendingUp className="h-8 w-8 text-green-600 opacity-50" /></div></CardContent></Card>
            <Card><CardContent className="p-6"><div className="flex items-center justify-between"><div><p className="text-sm text-gray-500">COGS</p><p className="text-2xl font-bold text-orange-600">{formatCurrency(report.cogs)}</p></div><DollarSign className="h-8 w-8 text-orange-600 opacity-50" /></div></CardContent></Card>
            <Card><CardContent className="p-6"><div className="flex items-center justify-between"><div><p className="text-sm text-gray-500">Net Profit</p><p className={`text-2xl font-bold ${report.netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(report.netProfit)}</p></div><TrendingDown className="h-8 w-8 text-gray-400 opacity-50" /></div></CardContent></Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between"><dt className="text-gray-500">Revenue</dt><dd className="font-medium">{formatCurrency(report.revenue)}</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">COGS (Production)</dt><dd className="font-medium">-{formatCurrency(report.cogs)}</dd></div>
                  <div className="flex justify-between border-t pt-2"><dt className="text-gray-500">Gross Profit</dt><dd className="font-bold">{formatCurrency(report.grossProfit)} ({report.grossMargin.toFixed(1)}%)</dd></div>
                  <div className="flex justify-between"><dt className="text-gray-500">Expenses</dt><dd className="font-medium">-{formatCurrency(report.expenses)}</dd></div>
                  <div className="flex justify-between border-t pt-2"><dt className="font-medium">Net Profit</dt><dd className="font-bold">{formatCurrency(report.netProfit)} ({report.netMargin.toFixed(1)}%)</dd></div>
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Expenses by Category</CardTitle></CardHeader>
              <CardContent>
                {Object.keys(report.expensesByCategory || {}).length === 0 ? (
                  <p className="text-sm text-gray-500">No expenses in this period</p>
                ) : (
                  <div className="space-y-2">
                    {Object.entries(report.expensesByCategory).sort(([,a]: any, [,b]: any) => b - a).map(([cat, amount]: any) => (
                      <div key={cat} className="flex justify-between text-sm">
                        <span>{cat}</span>
                        <span className="font-medium">{formatCurrency(amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
