'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import {
  LayoutDashboard,
  Package,
  Box,
  ShoppingCart,
  FileText,
  Printer,
  Users,
  Settings,
  DollarSign,
  Hammer,
  Zap,
  FolderOpen,
  Palette,
} from 'lucide-react';

interface NavItem {
  name: string;
  href: string;
  icon: any;
  roles?: string[]; // if undefined, visible to all staff
}

const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Quick Quote', href: '/quick-quote', icon: Zap, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Watch Folder', href: '/watch-folder', icon: FolderOpen, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Orders', href: '/orders', icon: ShoppingCart },
  { name: 'Quotes', href: '/quotes', icon: FileText, roles: ['ADMIN', 'VIEWER'] },
  { name: 'Production', href: '/production', icon: Hammer, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Design Center', href: '/design', icon: Palette, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Filaments', href: '/inventory', icon: Package, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Products', href: '/products', icon: Box, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Printers', href: '/printers', icon: Printer, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Customers', href: '/customers', icon: Users, roles: ['ADMIN', 'VIEWER'] },
  { name: 'Accounting', href: '/accounting', icon: DollarSign, roles: ['ADMIN', 'VIEWER'] },
  { name: 'Settings', href: '/settings', icon: Settings, roles: ['ADMIN'] },
];

export function Sidebar() {
  const pathname = usePathname();
  const [role, setRole] = useState<string>('');

  useEffect(() => {
    api.get<{ role: string }>('/auth/me')
      .then(u => setRole(u.role))
      .catch(() => {});
  }, []);

  const filteredNav = role
    ? navigation.filter(item => !item.roles || item.roles.includes(role))
    : [];

  return (
    <div className="flex h-full w-64 flex-col border-r bg-white dark:bg-gray-900 dark:border-gray-700">
      <div className="flex h-16 items-center px-6 border-b dark:border-gray-700">
        <Link href="/" className="text-xl font-bold text-brand-600 dark:text-brand-400">
          PrintForge
        </Link>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {filteredNav.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
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
