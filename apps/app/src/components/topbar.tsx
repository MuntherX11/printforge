'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, LogOut, Sun, Moon, Menu } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getTheme, toggleTheme } from '@/lib/theme';
import { useSidebar } from '@/components/sidebar-provider';
import { useAuth } from '@/lib/auth-context';

export function Topbar() {
  const { user, notifCount } = useAuth();
  const [isDark, setIsDark] = useState(false);
  const router = useRouter();
  const { toggle } = useSidebar();

  useEffect(() => {
    setIsDark(getTheme() === 'dark');
  }, []);

  async function handleLogout() {
    await api.post('/auth/logout');
    router.push('/staff-login');
  }

  const iconBtn =
    'rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1';

  return (
    <header className="pf-topbar flex h-16 items-center justify-between border-b border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-700 px-4 md:px-6">
      <button
        type="button"
        onClick={toggle}
        className={`md:hidden -ml-1 ${iconBtn}`}
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="hidden md:block" />

      <div className="flex items-center gap-1">
        {/* Theme toggle */}
        <button
          onClick={() => { const next = toggleTheme(); setIsDark(next === 'dark'); }}
          className={iconBtn}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="h-4.5 w-4.5 h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>

        {/* Notification bell */}
        <button
          className={`relative ${iconBtn}`}
          aria-label={notifCount > 0 ? `Notifications (${notifCount} unread)` : 'Notifications'}
        >
          <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
          {notifCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-semibold text-white leading-none">
              {notifCount > 9 ? '9+' : notifCount}
            </span>
          )}
        </button>

        {/* User identity */}
        {user && (
          <div className="ml-2 flex items-center gap-2.5 pl-3 border-l border-gray-200 dark:border-gray-700">
            {/* Avatar initial */}
            <div
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300"
              aria-hidden="true"
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            {/* Name + role */}
            <div className="hidden sm:flex flex-col leading-none gap-0.5">
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200 leading-none">{user.name}</span>
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 leading-none">{user.role}</span>
            </div>
            {/* Sign out */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              aria-label="Sign out"
              className="px-2"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
