'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';
import { Loading } from '@/components/ui/loading';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useFormatCurrency } from '@/lib/locale-context';
import { Mail, MessageCircle } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function CustomerDetailPage() {
  const formatCurrency = useFormatCurrency();
  const { id } = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [customer, setCustomer] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    api.get(`/customers/${id}`).then(setCustomer).catch(console.error).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  function openWhatsApp() {
    if (!customer.phone) { toast('error', 'Customer has no phone number'); return; }
    const phone = customer.phone.replace(/[^0-9+]/g, '').replace(/^\+/, '');
    window.open(`https://wa.me/${phone}`, '_blank');
  }

  async function handleSendEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSending(true);
    const form = new FormData(e.currentTarget);
    try {
      await api.post('/communications/send-email', {
        to: form.get('to') as string,
        subject: form.get('subject') as string,
        body: form.get('body') as string,
      });
      setShowEmail(false);
      toast('success', 'Email sent successfully');
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const data = {
      name: form.get('name') as string,
      email: form.get('email') as string || undefined,
      phone: form.get('phone') as string || undefined,
      address: form.get('address') as string || undefined,
      notes: form.get('notes') as string || undefined,
    };
    try {
      const updated = await api.patch<any>(`/customers/${id}`, data);
      setCustomer((prev: any) => ({ ...prev, ...(updated as any) }));
      setEditing(false);
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Loading />;
  if (!customer) return <div className="text-center py-12 text-gray-500">Customer not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{customer.name}</h1>
        <div className="flex gap-2">
          {customer.phone && (
            <Button variant="outline" onClick={openWhatsApp}>
              <MessageCircle className="h-4 w-4 mr-2" /> WhatsApp
            </Button>
          )}
          {customer.email && (
            <Button variant="outline" onClick={() => setShowEmail(true)}>
              <Mail className="h-4 w-4 mr-2" /> Email
            </Button>
          )}
          <Button variant="outline" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent>
            {editing ? (
              <form onSubmit={handleSave} className="space-y-4">
                <Input name="name" label="Name" defaultValue={customer.name} required />
                <Input name="email" label="Email" defaultValue={customer.email || ''} />
                <Input name="phone" label="Phone" defaultValue={customer.phone || ''} />
                <Input name="address" label="Address" defaultValue={customer.address || ''} />
                <Textarea name="notes" label="Notes" defaultValue={customer.notes || ''} />
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
              </form>
            ) : (
              <dl className="space-y-3">
                <div><dt className="text-xs text-gray-500">Email</dt><dd>{customer.email || '-'}</dd></div>
                <div><dt className="text-xs text-gray-500">Phone</dt><dd>{customer.phone || '-'}</dd></div>
                <div><dt className="text-xs text-gray-500">Address</dt><dd>{customer.address || '-'}</dd></div>
                <div><dt className="text-xs text-gray-500">Notes</dt><dd>{customer.notes || '-'}</dd></div>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Orders ({customer._count?.orders || 0})</CardTitle></CardHeader>
          <CardContent>
            {(customer.orders || []).length === 0 ? (
              <p className="text-sm text-gray-500">No orders yet</p>
            ) : (
              <div className="space-y-2">
                {customer.orders.map((o: any) => (
                  <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between p-2 rounded hover:bg-gray-50">
                    <div>
                      <p className="text-sm font-medium">{o.orderNumber}</p>
                      <p className="text-xs text-gray-500">{formatDate(o.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{formatCurrency(o.total)}</span>
                      <StatusBadge status={o.status} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialog open={showEmail} onClose={() => setShowEmail(false)} title="Send Email">
        <form onSubmit={handleSendEmail} className="space-y-4">
          <Input name="to" label="To" defaultValue={customer.email || ''} required />
          <Input name="subject" label="Subject" required />
          <Textarea name="body" label="Message (HTML supported)" rows={6} required />
          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={() => setShowEmail(false)}>Cancel</Button>
            <Button type="submit" disabled={sending}>{sending ? 'Sending...' : 'Send Email'}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
