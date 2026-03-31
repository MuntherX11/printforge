'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
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
} from 'lucide-react';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Quick Quote', href: '/quick-quote', icon: Zap },
  { name: 'Watch Folder', href: '/watch-folder', icon: FolderOpen },
  { name: 'Orders', href: '/orders', icon: ShoppingCart },
  { name: 'Quotes', href: '/quotes', icon: FileText },
  { name: 'Production', href: '/production', icon: Hammer },
  { name: 'Inventory', href: '/inventory', icon: Package },
  { name: 'Products', href: '/products', icon: Box },
  { name: 'Printers', href: '/printers', icon: Printer },
  { name: 'Customers', href: '/customers', icon: Users },
  { name: 'Accounting', href: '/accounting', icon: DollarSign },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-64 flex-col border-r bg-white">
      <div className="flex h-16 items-center px-6 border-b">
        <Link href="/" className="text-xl font-bold text-brand-600">
          PrintForge
        </Link>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navigation.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
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
