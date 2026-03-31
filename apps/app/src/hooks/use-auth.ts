'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { AuthUser } from '@printforge/types';

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    api.get<AuthUser>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<{ user: AuthUser }>('/auth/login', { email, password });
    setUser(result.user);
    router.push('/');
  }, [router]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
    router.push('/login');
  }, [router]);

  return { user, loading, login, logout };
}
