'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { FileText, Palette, Plus } from 'lucide-react';

interface CustomerUser {
  id: string;
  name: string;
  email: string;
  userType: string;
}

export default function CustomerDashboard() {
  const [user, setUser] = useState<CustomerUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    api.get<CustomerUser>('/auth/me')
      .then((data) => {
        if (data.userType !== 'customer') {
          router.push('/');
          return;
        }
        setUser(data);
      })
      .catch(() => router.push('/customer-login'))
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome, {user?.name}
        </h1>
        <p className="text-gray-500 mt-1">Manage your quotes and design requests</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-brand-600" />
                My Quotes
              </CardTitle>
              <Link href="/dashboard/quotes">
                <Button variant="outline" size="sm">View All</Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-500">
              View your quotes, accept or request changes.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5 text-brand-600" />
                Design Requests
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
            <p className="text-sm text-gray-500">
              Submit design requests and track their progress.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
