'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  FileText,
  Palette,
  User,
  Zap,
  ShoppingCart,
} from 'lucide-react';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Quick Quote', href: '/dashboard/quick-quote', icon: Zap },
  { name: 'My Quotes', href: '/dashboard/quotes', icon: FileText },
  { name: 'Orders', href: '/dashboard/orders', icon: ShoppingCart },
  { name: 'Design Requests', href: '/dashboard/design', icon: Palette },
  { name: 'Profile', href: '/dashboard/profile', icon: User },
];

export function CustomerSidebar() {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-64 flex-col border-r bg-white dark:bg-gray-900 dark:border-gray-700">
      <div className="flex h-16 items-center px-6 border-b dark:border-gray-700">
        <Link href="/dashboard" className="text-xl font-bold text-brand-600 dark:text-brand-400">
          PrintForge
        </Link>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navigation.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/dashboard' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100',
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
