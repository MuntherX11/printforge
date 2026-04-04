'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { LogOut, Sun, Moon } from 'lucide-react';
import { getTheme, toggleTheme } from '@/lib/theme';

interface CustomerUser {
  id: string;
  name: string;
  email: string;
  userType: 'customer';
}

export function CustomerTopbar() {
  const [user, setUser] = useState<CustomerUser | null>(null);
  const [isDark, setIsDark] = useState(false);
  const router = useRouter();

  useEffect(() => {
    api.get<CustomerUser>('/auth/customer/me')
      .then(setUser)
      .catch(() => {});
    setIsDark(getTheme() === 'dark');
  }, []);

  async function handleLogout() {
    await api.post('/auth/logout');
    router.push('/login');
  }

  return (
    <div className="flex h-16 items-center justify-between border-b bg-white dark:bg-gray-900 px-6">
      <div />
      <div className="flex items-center gap-4">
        <button
          onClick={() => { const next = toggleTheme(); setIsDark(next === 'dark'); }}
          className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
        {user && (
          <span className="text-sm text-gray-600 dark:text-gray-300">
            {user.name}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4 mr-1" />
          Logout
        </Button>
      </div>
    </div>
  );
}
