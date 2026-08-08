'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useFormatCurrency } from '@/lib/locale-context';
import { Plus, Landmark, Wallet, CreditCard, Circle, ArrowLeftRight, PencilLine, History } from 'lucide-react';

interface Account {
  id: string;
  name: string;
  type: 'BANK' | 'CASH' | 'CARD' | 'OTHER';
  reference?: string | null;
  balance: number;
  isDefault: boolean;
  isActive: boolean;
  _count?: { transactions: number };
}

interface Txn {
  id: string;
  amount: number;
  balanceAfter: number;
  type: string;
  description: string;
  reference?: string | null;
  occurredAt: string;
}

const TYPE_ICON = { BANK: Landmark, CASH: Wallet, CARD: CreditCard, OTHER: Circle } as const;
const TYPE_OPTIONS = [
  { value: 'BANK', label: 'Bank account' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'OTHER', label: 'Other' },
];
const TXN_LABEL: Record<string, string> = {
  INVOICE_PAYMENT: 'Invoice payment',
  EXPENSE: 'Expense',
  ADJUSTMENT: 'Adjustment',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
  OPENING_BALANCE: 'Opening balance',
};

export function AccountsPanel() {
  const { toast } = useToast();
  const formatCurrency = useFormatCurrency();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  const [statement, setStatement] = useState<{ account: Account; txns: Txn[] } | null>(null);
  const [adjustFor, setAdjustFor] = useState<Account | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);

  function load() {
    api.get<Account[]>('/accounts')
      .then((r) => setAccounts(Array.isArray(r) ? r : []))
      .catch((err: any) => toast('error', err?.message || 'Could not load accounts'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaving(true);
    try {
      await api.post('/accounts', {
        name: f.get('name'),
        type: f.get('type'),
        reference: f.get('reference') || undefined,
        openingBalance: parseFloat(f.get('openingBalance') as string) || 0,
        isDefault: f.get('isDefault') === 'on',
      });
      setShowAdd(false);
      load();
      toast('success', 'Account added');
    } catch (err: any) {
      toast('error', err?.message || 'Could not add account');
    } finally {
      setSaving(false);
    }
  }

  async function openStatement(a: Account) {
    try {
      const full = await api.get<Account & { transactions: Txn[] }>(`/accounts/${a.id}?limit=200`);
      setStatement({ account: full, txns: full.transactions ?? [] });
    } catch (err: any) {
      toast('error', err?.message || 'Could not load statement');
    }
  }

  async function submitAdjust(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!adjustFor) return;
    const f = new FormData(e.currentTarget);
    const amount = parseFloat(f.get('amount') as string);
    if (!Number.isFinite(amount) || amount === 0) return toast('error', 'Enter a non-zero amount');
    setSaving(true);
    try {
      await api.post(`/accounts/${adjustFor.id}/adjust`, { amount, description: f.get('description') });
      setAdjustFor(null);
      load();
      toast('success', 'Balance adjusted');
    } catch (err: any) {
      toast('error', err?.message || 'Could not adjust');
    } finally {
      setSaving(false);
    }
  }

  async function submitTransfer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaving(true);
    try {
      await api.post('/accounts/transfer', {
        fromAccountId: f.get('from'),
        toAccountId: f.get('to'),
        amount: parseFloat(f.get('amount') as string),
        description: f.get('description') || undefined,
      });
      setShowTransfer(false);
      load();
      toast('success', 'Transfer recorded');
    } catch (err: any) {
      toast('error', err?.message || 'Could not transfer');
    } finally {
      setSaving(false);
    }
  }

  const total = accounts.filter((a) => a.isActive).reduce((s, a) => s + a.balance, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <Landmark className="h-4 w-4" /> Accounts
            {accounts.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                total {formatCurrency(total)}
              </span>
            )}
          </CardTitle>
          <div className="flex gap-2">
            {accounts.length > 1 && (
              <Button variant="outline" size="sm" onClick={() => setShowTransfer(true)}>
                <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" /> Transfer
              </Button>
            )}
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Account
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <p className="py-8 text-center text-sm text-gray-500">Loading…</p>
        ) : accounts.length === 0 ? (
          <div className="py-10 text-center text-gray-500 dark:text-gray-400">
            <Wallet className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm font-medium">No accounts yet</p>
            <p className="text-xs mt-1">
              Add your bank and cash accounts — paid invoices will credit the default one automatically.
            </p>
          </div>
        ) : (
          <div className="divide-y dark:divide-gray-700">
            {accounts.map((a) => {
              const Icon = TYPE_ICON[a.type] ?? Circle;
              return (
                <div key={a.id} className={`flex items-center gap-3 px-4 py-3 ${a.isActive ? '' : 'opacity-50'}`}>
                  <Icon className="h-5 w-5 text-gray-400 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium truncate dark:text-gray-100">{a.name}</p>
                      {a.isDefault && <Badge variant="default" className="text-[10px]">default</Badge>}
                      {!a.isActive && <span className="text-[10px] uppercase text-gray-400">inactive</span>}
                    </div>
                    {a.reference && <p className="text-xs text-gray-400 font-mono">{a.reference}</p>}
                  </div>
                  <p className={`text-lg font-semibold tabular-nums flex-shrink-0 ${
                    a.balance < 0 ? 'text-red-600 dark:text-red-400' : 'dark:text-gray-100'
                  }`}>
                    {formatCurrency(a.balance)}
                  </p>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="outline" size="sm" onClick={() => openStatement(a)} title="Statement">
                      <History className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setAdjustFor(a)} title="Adjust balance">
                      <PencilLine className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            <p className="px-4 py-2.5 text-xs text-gray-400">
              Paid invoices credit the default account; expenses debit whichever account you pick.
            </p>
          </div>
        )}
      </CardContent>

      {/* Add account */}
      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title="Add Account">
        <form onSubmit={addAccount} className="space-y-4">
          <Input name="name" label="Account name" placeholder="e.g. Bank Muscat — Main" required />
          <div className="grid grid-cols-2 gap-4">
            <Select name="type" label="Type" options={TYPE_OPTIONS} defaultValue="BANK" />
            <Input name="openingBalance" label="Opening balance" type="number" step="0.001" defaultValue="0" />
          </div>
          <Input name="reference" label="Reference (optional)" placeholder="IBAN or last 4 digits" />
          <label className="flex items-center gap-2.5 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" name="isDefault" className="rounded border-gray-300 text-brand-600" />
            Paid invoices land here
          </label>
          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add Account'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Adjust */}
      <Dialog open={!!adjustFor} onClose={() => setAdjustFor(null)} title={`Adjust ${adjustFor?.name ?? ''}`}>
        <form onSubmit={submitAdjust} className="space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Current balance {adjustFor ? formatCurrency(adjustFor.balance) : ''}. Use a negative amount to
            reduce it — for a bank fee, a cash count correction, and so on.
          </p>
          <Input name="amount" label="Amount (+ in / − out)" type="number" step="0.001" required />
          <Input name="description" label="Reason" placeholder="e.g. bank charges" />
          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="outline" onClick={() => setAdjustFor(null)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Apply'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Transfer */}
      <Dialog open={showTransfer} onClose={() => setShowTransfer(false)} title="Transfer Between Accounts">
        <form onSubmit={submitTransfer} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Select name="from" label="From" options={accounts.filter(a => a.isActive).map(a => ({ value: a.id, label: `${a.name} (${formatCurrency(a.balance)})` }))} />
            <Select name="to" label="To" options={accounts.filter(a => a.isActive).map(a => ({ value: a.id, label: a.name }))} />
          </div>
          <Input name="amount" label="Amount" type="number" step="0.001" min="0.001" required />
          <Input name="description" label="Note (optional)" />
          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="outline" onClick={() => setShowTransfer(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Moving…' : 'Transfer'}</Button>
          </div>
        </form>
      </Dialog>

      {/* Statement */}
      <Dialog
        open={!!statement}
        onClose={() => setStatement(null)}
        title={`${statement?.account.name ?? ''} — statement`}
        className="max-w-2xl"
      >
        {statement && statement.txns.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">No transactions yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto divide-y dark:divide-gray-700 rounded-md border dark:border-gray-700">
            {statement?.txns.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate dark:text-gray-100">{t.description}</p>
                  <p className="text-xs text-gray-400">
                    {new Date(t.occurredAt).toLocaleDateString()} · {TXN_LABEL[t.type] ?? t.type}
                    {t.reference ? ` · ${t.reference}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`text-sm font-medium tabular-nums ${
                    t.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                  }`}>
                    {t.amount >= 0 ? '+' : ''}{formatCurrency(t.amount)}
                  </p>
                  <p className="text-[11px] text-gray-400 tabular-nums">{formatCurrency(t.balanceAfter)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-4">
          <Button variant="outline" onClick={() => setStatement(null)}>Close</Button>
        </div>
      </Dialog>
    </Card>
  );
}
