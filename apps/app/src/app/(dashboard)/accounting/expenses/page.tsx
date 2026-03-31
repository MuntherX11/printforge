'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Plus } from 'lucide-react';

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => Promise.all([
    api.get<any[]>('/accounting/expenses').then(setExpenses),
    api.get<any[]>('/accounting/categories').then(setCategories),
  ]).catch(console.error).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/accounting/expenses', {
        categoryId: form.get('categoryId'),
        description: form.get('description'),
        amount: parseFloat(form.get('amount') as string),
        date: form.get('date'),
        notes: form.get('notes') || undefined,
      });
      setShowAdd(false);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Expenses</h1>
        <Button onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 mr-2" /> Add Expense</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDate(e.date)}</TableCell>
                  <TableCell>{e.category?.name}</TableCell>
                  <TableCell>{e.description}</TableCell>
                  <TableCell className="font-medium">{formatCurrency(e.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add Expense">
        <form onSubmit={handleAdd} className="space-y-4">
          <Select name="categoryId" label="Category" options={[{ value: '', label: 'Select...' }, ...categories.map(c => ({ value: c.id, label: c.name }))]} required />
          <Input name="description" label="Description" required />
          <Input name="amount" label="Amount" type="number" step="0.001" required />
          <Input name="date" label="Date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
          <Textarea name="notes" label="Notes" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit">Add Expense</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
