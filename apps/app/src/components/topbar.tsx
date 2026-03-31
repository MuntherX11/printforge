'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, LogOut, User } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import type { AuthUser } from '@printforge/types';

export function Topbar() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [notifCount, setNotifCount] = useState(0);
  const router = useRouter();

  useEffect(() => {
    api.get<AuthUser>('/auth/me').then(setUser).catch(() => {});
    api.get<number>('/notifications/count').then(setNotifCount).catch(() => {});
  }, []);

  async function handleLogout() {
    await api.post('/auth/logout');
    router.push('/login');
  }

  return (
    <header className="flex h-16 items-center justify-between border-b bg-white px-6">
      <div />
      <div className="flex items-center gap-4">
        <button className="relative p-2 text-gray-500 hover:text-gray-700">
          <Bell className="h-5 w-5" />
          {notifCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-medium text-white">
              {notifCount > 9 ? '9+' : notifCount}
            </span>
          )}
        </button>
        {user && (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <User className="h-4 w-4" />
            <span>{user.name}</span>
            <span className="text-xs text-gray-400">({user.role})</span>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
