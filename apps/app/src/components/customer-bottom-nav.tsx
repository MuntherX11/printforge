'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Store, ShoppingCart, FileText, User } from 'lucide-react';

const tabs = [
  { name: 'Shop', href: '/dashboard/shop', icon: Store },
  { name: 'Orders', href: '/dashboard/orders', icon: ShoppingCart },
  { name: 'Quotes', href: '/dashboard/quotes', icon: FileText },
  { name: 'Profile', href: '/dashboard/profile', icon: User },
];

export function CustomerBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 border-t bg-white dark:bg-gray-900 dark:border-gray-700">
      <div className="flex">
        {tabs.map(tab => {
          const isActive = pathname === tab.href || (tab.href !== '/dashboard' && pathname.startsWith(tab.href));
          return (
            <Link
              key={tab.name}
              href={tab.href}
              className={cn(
                'flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium transition-colors',
                isActive
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'text-gray-500 dark:text-gray-400',
              )}
            >
              <tab.icon className="h-5 w-5" />
              {tab.name}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
