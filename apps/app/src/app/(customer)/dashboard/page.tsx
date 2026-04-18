'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { FileText, Palette, Plus } from 'lucide-react';

interface CustomerUser {
  id: string;
  name: string;
  email: string;
  userType: string;
}

interface Quote {
  id: string;
  quoteNumber: string;
  status: string;
  total: number;
  createdAt: string;
}

interface DesignProject {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'error'> = {
  DRAFT: 'default',
  SENT: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'error',
  EXPIRED: 'default',
};

export default function CustomerDashboard() {
  const [user, setUser] = useState<CustomerUser | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quotesTotal, setQuotesTotal] = useState(0);
  const [designs, setDesigns] = useState<DesignProject[]>([]);
  const [designsTotal, setDesignsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    async function load() {
      try {
        const me = await api.get<CustomerUser>('/auth/me');
        if (me.userType !== 'customer') {
          router.push('/');
          return;
        }
        setUser(me);
        const [quotesRes, designsRes] = await Promise.all([
          api.get<any>('/quotes/customer/my-quotes?limit=3'),
          api.get<any>('/design-projects/customer/my-projects?limit=3'),
        ]);
        setQuotes(quotesRes?.data || []);
        setQuotesTotal(quotesRes?.total || 0);
        setDesigns(designsRes?.data || []);
        setDesignsTotal(designsRes?.total || 0);
      } catch {
        router.push('/customer-login');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [router]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Welcome, {user?.name}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">Manage your quotes and design requests</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-brand-600" />
                My Quotes
                {quotesTotal > 0 && (
                  <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                    ({quotesTotal})
                  </span>
                )}
              </CardTitle>
              <Link href="/dashboard/quotes">
                <Button variant="outline" size="sm">View All</Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {quotes.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No quotes yet. Use Quick Quote to get an estimate.
              </p>
            ) : (
              <div className="space-y-2">
                {quotes.map(q => (
                  <Link key={q.id} href={`/dashboard/quotes/${q.id}`} className="block">
                    <div className="flex items-center justify-between py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium dark:text-gray-200">{q.quoteNumber}</span>
                        <Badge variant={STATUS_VARIANT[q.status] ?? 'default'}>{q.status}</Badge>
                      </div>
                      <span className="text-sm text-gray-600 dark:text-gray-400">
                        {q.total.toFixed(3)} OMR
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5 text-brand-600" />
                Design Requests
                {designsTotal > 0 && (
                  <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                    ({designsTotal})
                  </span>
                )}
              </CardTitle>
              <Link href="/dashboard/design">
                <Button variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1" />
                  New Request
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {designs.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No design requests yet. Submit one to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {designs.map(d => (
                  <Link key={d.id} href={`/dashboard/design/${d.id}`} className="block">
                    <div className="flex items-center justify-between py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1 transition-colors">
                      <span className="text-sm font-medium dark:text-gray-200 truncate">{d.title}</span>
                      <Badge variant={STATUS_VARIANT[d.status] ?? 'default'}>{d.status}</Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
