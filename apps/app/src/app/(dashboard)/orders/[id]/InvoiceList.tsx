'use client';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Mail, MessageCircle } from 'lucide-react';

interface InvoiceListProps {
  invoices: any[];
  orderId: string;
  creating: boolean;
  onCreateInvoice: () => void;
  onSendEmail: (invoiceId: string) => void;
  onWhatsApp: (inv: any) => void;
  formatCurrency: (v: number) => string;
  formatDate: (v: string) => string;
}

export function InvoiceList({
  invoices,
  orderId,
  creating,
  onCreateInvoice,
  onSendEmail,
  onWhatsApp,
  formatCurrency,
  formatDate,
}: InvoiceListProps) {
  if (!invoices || invoices.length === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-2">
          {invoices.map((inv: any) => (
            <div key={inv.id} className="flex items-center justify-between p-2 rounded hover:bg-gray-50">
              <div>
                <p className="text-sm font-medium">{inv.invoiceNumber}</p>
                <p className="text-xs text-gray-500">{formatDate(inv.createdAt)}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{formatCurrency(inv.total)}</span>
                <StatusBadge status={inv.status} />
                <a href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm">PDF</Button>
                </a>
                <Button variant="outline" size="sm" onClick={() => onSendEmail(inv.id)} title="Send via Email">
                  <Mail className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => onWhatsApp(inv)} title="WhatsApp">
                  <MessageCircle className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
