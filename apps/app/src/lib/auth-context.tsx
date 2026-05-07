'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AuthUser } from '@printforge/types';

interface AuthContextValue {
  user: AuthUser | null;
  role: string | null; // null = loading, '' = unauthenticated
  notifCount: number;
  refreshNotifCount: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  role: null,
  notifCount: 0,
  refreshNotifCount: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [notifCount, setNotifCount] = useState(0);

  useEffect(() => {
    api.get<AuthUser>('/auth/me')
      .then(u => { setUser(u); setRole(u.role); })
      .catch(() => setRole(''));
  }, []);

  function refreshNotifCount() {
    api.get<number>('/notifications/count').then(setNotifCount).catch(() => {});
  }

  useEffect(() => {
    refreshNotifCount();
  }, []);

  return (
    <AuthContext.Provider value={{ user, role, notifCount, refreshNotifCount }}>
      {children}
    </AuthContext.Provider>
  );
}
