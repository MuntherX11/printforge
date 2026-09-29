'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { SPOOL_QR_PATH, safeNextPath } from '@printforge/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';

/**
 * Where to go after signing in: ?next= when it is a safe same-site path (a
 * scanned QR spool page), otherwise null. Reads window.location rather than
 * useSearchParams, so the page needs no Suspense boundary to build.
 */
const nextPath = () => safeNextPath(new URLSearchParams(window.location.search).get('next'));

export default function StaffLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Already signed in as staff (a QR scanner app can open the link without
  // the Strict cookie; this same-origin call sends it): go straight to the
  // spool. Only a QR spool page, so /staff-login?next= can't carry a
  // session through a cross-site link to any other page.
  useEffect(() => {
    const next = nextPath();
    if (!next || !SPOOL_QR_PATH.test(next)) return;
    let live = true;
    api.get<{ userType?: string }>('/auth/me')
      .then((me) => { if (live && me?.userType === 'staff') router.replace(next); })
      .catch(() => { /* not signed in: show the form */ });
    return () => { live = false; };
    // Mount only: next comes from the URL this page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await api.post('/auth/login', { email, password });
      router.push(nextPath() ?? '/');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 text-3xl font-bold text-brand-600 dark:text-brand-400">PrintForge</div>
        <CardTitle>Staff Login</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
          )}
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@printforge.local"
            required
          />
          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-gray-400 dark:text-gray-500">
            <Link href="/login" className="hover:underline">
              Customer portal
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
