'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import {
  LayoutDashboard,
  FileText,
  Palette,
  User,
  Zap,
  ShoppingCart,
  Store,
  MessageCircle,
  Puzzle,
  Type,
  PenTool,
  Ruler,
  Shapes,
  Sparkles,
  Wrench,
  Calculator,
  Shirt,
  Box,
  Boxes,
  Package,
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react';

// Same curated set the staff sidebar uses; unknown names fall back to Puzzle.
const ADDON_ICONS: Record<string, LucideIcon> = {
  Puzzle, Type, PenTool, Ruler, Shapes, Sparkles, Wrench, Calculator,
  Palette, Box, Boxes, Package, FileText, Shirt, Image: ImageIcon,
};

interface CustomerAddon {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
}

const navigation = [
  { name: 'Shop', href: '/dashboard/shop', icon: Store },
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Quick Quote', href: '/dashboard/quick-quote', icon: Zap },
  { name: 'My Quotes', href: '/dashboard/quotes', icon: FileText },
  { name: 'Orders', href: '/dashboard/orders', icon: ShoppingCart },
  { name: 'Design Requests', href: '/dashboard/design', icon: Palette },
  { name: 'Profile', href: '/dashboard/profile', icon: User },
];

export function CustomerSidebar() {
  const pathname = usePathname();
  const [addons, setAddons] = useState<CustomerAddon[]>([]);

  // Only addons an admin has published to the portal come back here.
  useEffect(() => {
    api.get<CustomerAddon[]>('/addons/customer')
      .then((list) => setAddons(Array.isArray(list) ? list : []))
      .catch(() => setAddons([]));
  }, []);

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

        {/* Addons published to the portal */}
        {addons.length > 0 && (
          <div className="pt-3 mt-3 border-t dark:border-gray-700 space-y-1">
            <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
              Design Tools
            </p>
            {addons.map((addon) => {
              const Icon = (addon.icon && ADDON_ICONS[addon.icon]) || Puzzle;
              const href = `/dashboard/tools/${addon.slug}`;
              const isActive = pathname === href;
              return (
                <Link
                  key={addon.id}
                  href={href}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100',
                  )}
                >
                  <Icon className="h-5 w-5 flex-shrink-0" />
                  {addon.name}
                </Link>
              );
            })}
          </div>
        )}
      </nav>
      <div className="px-3 py-4 border-t dark:border-gray-700">
        <a
          href="https://wa.me/968"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 transition-colors"
        >
          <MessageCircle className="h-5 w-5 flex-shrink-0 text-green-500" />
          Chat with us
        </a>
      </div>
    </div>
  );
}
