'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AuthUser, UserPreferences } from '@printforge/types';

interface AuthContextValue {
  user: AuthUser | null;
  role: string | null; // null = loading, '' = unauthenticated
  notifCount: number;
  refreshNotifCount: () => void;
  /**
   * Lays `patch` over the signed-in user's preferences in memory only (the
   * caller saves them with PATCH /auth/me/preferences). A no-op until the
   * user has loaded.
   */
  setPreferences: (patch: UserPreferences) => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  role: null,
  notifCount: 0,
  refreshNotifCount: () => {},
  setPreferences: () => {},
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
      // An API from before preferences existed sends none: treat that as {}.
      .then(u => { setUser({ ...u, preferences: u.preferences ?? {} }); setRole(u.role); })
      .catch(() => setRole(''));
  }, []);

  function refreshNotifCount() {
    api.get<number>('/notifications/count').then(setNotifCount).catch(() => {});
  }

  useEffect(() => {
    refreshNotifCount();
  }, []);

  const setPreferences = useCallback((patch: UserPreferences) => {
    setUser(u => (u ? { ...u, preferences: { ...u.preferences, ...patch } } : u));
  }, []);

  return (
    <AuthContext.Provider value={{ user, role, notifCount, refreshNotifCount, setPreferences }}>
      {children}
    </AuthContext.Provider>
  );
}
