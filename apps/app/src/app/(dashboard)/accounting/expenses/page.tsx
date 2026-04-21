'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog } from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, Tag, ArrowLeft, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function ExpensesPage() {
  const formatCurrency = useFormatCurrency();
  const { toast } = useToast();
  const [expenses, setExpenses] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState<string | null>(null);

  const load = () => Promise.all([
    api.get<any[]>('/accounting/expenses').then(setExpenses),
    api.get<any[]>('/accounting/categories').then(setCategories),
  ]).catch((err) => {
    console.error(err);
    toast('error', 'Failed to load expenses');
  }).finally(() => setLoading(false));

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
      toast('success', 'Expense added');
      setShowAdd(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function handleAddCategory(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/accounting/categories', {
        name: form.get('name'),
        description: form.get('description') || undefined,
      });
      toast('success', 'Category created');
      setShowAddCategory(false);
      load();
    } catch (err: any) {
      toast('error', err.message);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await api.delete(`/accounting/expenses/${id}`);
      toast('success', 'Expense deleted');
      setShowDelete(null);
      load();
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setDeleting(null);
    }
  }

  const total = expenses.reduce((s, e) => s + e.amount, 0);

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/accounting">
            <Button variant="outline" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Expenses</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowAddCategory(true)}>
            <Tag className="h-4 w-4 mr-2" /> Add Category
          </Button>
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4 mr-2" /> Add Expense
          </Button>
        </div>
      </div>

      {/* Category pills */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {categories.map(c => (
            <span key={c.id} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              {c.name}
            </span>
          ))}
        </div>
      )}

      <Card>
        {expenses.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-gray-500">
            No expenses recorded yet. Add your first expense above.
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {expenses.map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-gray-500">{formatDate(e.date)}</TableCell>
                    <TableCell>
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700">
                        {e.category?.name ?? '—'}
                      </span>
                    </TableCell>
                    <TableCell>{e.description}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(e.amount)}</TableCell>
                    <TableCell className="text-right">
                      <button
                        onClick={() => setShowDelete(e.id)}
                        disabled={deleting === e.id}
                        className="text-gray-400 hover:text-red-500 transition-colors"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
                {/* Total row */}
                <TableRow className="bg-gray-50 dark:bg-gray-800/50 font-semibold">
                  <td colSpan={3} className="p-4 text-right text-sm text-gray-600 dark:text-gray-400">Total</td>
                  <td className="p-4 text-right">{formatCurrency(total)}</td>
                  <td className="p-4" />
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog open={!!showDelete} onClose={() => setShowDelete(null)} title="Delete Expense">
        <div className="space-y-4 pt-2">
          <p className="text-sm text-gray-500">
            Are you sure you want to delete this expense? This action cannot be undone.
          </p>
          <div className="flex gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => setShowDelete(null)}>Cancel</Button>
            <Button 
              variant="destructive" 
              onClick={() => showDelete && handleDelete(showDelete)}
              disabled={!!deleting}
            >
              {deleting ? 'Deleting...' : 'Delete Expense'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Add expense dialog */}
      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add Expense">
        <form onSubmit={handleAdd} className="space-y-4">
          {categories.length === 0 ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              No categories yet. Create one first using "Add Category".
            </p>
          ) : (
            <Select name="categoryId" label="Category" required
              options={[{ value: '', label: 'Select category...' }, ...categories.map(c => ({ value: c.id, label: c.name }))]} />
          )}
          <Input name="description" label="Description" required />
          <div className="grid grid-cols-2 gap-4">
            <Input name="amount" label="Amount (OMR)" type="number" step="0.001" min="0" required />
            <Input name="date" label="Date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
          </div>
          <Textarea name="notes" label="Notes (optional)" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" disabled={categories.length === 0}>Add Expense</Button>
          </div>
        </form>
      </Dialog>

      {/* Add category dialog */}
      <Dialog open={showAddCategory} onClose={() => setShowAddCategory(false)} title="New Expense Category">
        <form onSubmit={handleAddCategory} className="space-y-4">
          <Input name="name" label="Category Name" placeholder="e.g. Electricity, Maintenance, Shipping" required />
          <Textarea name="description" label="Description (optional)" />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowAddCategory(false)}>Cancel</Button>
            <Button type="submit">Create Category</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
