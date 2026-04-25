'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useFormatCurrency } from '@/lib/locale-context';

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

interface AccountingChartProps {
  trend: any[];
}

export default function AccountingChart({ trend }: AccountingChartProps) {
  if (trend.length === 0) {
    return <p className="text-sm text-gray-500 py-8 text-center">No data yet</p>;
  }
  return (
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
  );
}
