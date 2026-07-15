'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useSidebar } from '@/components/sidebar-provider';
import { useAuth } from '@/lib/auth-context';
import {
  LayoutDashboard,
  Package,
  Box,
  Boxes,
  ShoppingCart,
  FileText,
  Printer,
  Users,
  Settings,
  DollarSign,
  Hammer,
  Zap,
  Palette,
  Puzzle,
  Type,
  PenTool,
  Ruler,
  Shapes,
  Sparkles,
  Wrench,
  Calculator,
  Image as ImageIcon,
  X,
  type LucideIcon,
} from 'lucide-react';

// Curated icon set an addon manifest may reference by name (keeps the bundle
// small vs. importing all of lucide). Unknown names fall back to Puzzle.
const ADDON_ICONS: Record<string, LucideIcon> = {
  Puzzle, Type, PenTool, Ruler, Shapes, Sparkles, Wrench, Calculator,
  Palette, Box, Boxes, Package, FileText, Image: ImageIcon,
};

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  roles?: string[]; // if undefined, visible to all staff
}

interface AddonNav {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
}

const navigation: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Quick Quote', href: '/quick-quote', icon: Zap, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Orders', href: '/orders', icon: ShoppingCart },
  { name: 'Quotes', href: '/quotes', icon: FileText, roles: ['ADMIN', 'ACCOUNTING', 'VIEWER'] },
  { name: 'Production', href: '/production', icon: Hammer, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Design Center', href: '/design', icon: Palette, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Filaments', href: '/inventory', icon: Package, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Products', href: '/products', icon: Box, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Printers', href: '/printers', icon: Printer, roles: ['ADMIN', 'OPERATOR'] },
  { name: 'Customers', href: '/customers', icon: Users, roles: ['ADMIN', 'ACCOUNTING', 'VIEWER'] },
  { name: 'Accounting', href: '/accounting', icon: DollarSign, roles: ['ADMIN', 'ACCOUNTING', 'VIEWER'] },
  { name: 'Settings', href: '/settings', icon: Settings, roles: ['ADMIN'] },
];

export function Sidebar() {
  const pathname = usePathname();
  const { role } = useAuth();
  const { open, setOpen } = useSidebar();
  const [addons, setAddons] = useState<AddonNav[]>([]);

  // Load active addons once the staff session is known; they render inline in
  // the main nav (just before Settings).
  useEffect(() => {
    if (!role) return;
    api.get<AddonNav[]>('/addons')
      .then((list) => setAddons(Array.isArray(list) ? list : []))
      .catch(() => setAddons([]));
  }, [role]);

  // null = still loading (from AuthContext), '' = loaded but no role (error), string = loaded
  const staticNav = role === null
    ? null
    : navigation.filter(item => !item.roles || item.roles.includes(role));

  // Splice addon items in just before Settings so Settings stays at the bottom.
  const addonItems: NavItem[] = addons.map((a) => ({
    name: a.name,
    href: `/addons/${a.slug}`,
    icon: (a.icon && ADDON_ICONS[a.icon]) || Puzzle,
  }));
  let filteredNav: NavItem[] | null = staticNav;
  if (staticNav) {
    const settingsIdx = staticNav.findIndex((i) => i.href === '/settings');
    if (settingsIdx === -1) {
      filteredNav = [...staticNav, ...addonItems];
    } else {
      filteredNav = [
        ...staticNav.slice(0, settingsIdx),
        ...addonItems,
        ...staticNav.slice(settingsIdx),
      ];
    }
  }

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        aria-label="Main navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r bg-white dark:bg-gray-900 dark:border-gray-700 transition-transform duration-200 ease-out',
          'md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between px-6 border-b dark:border-gray-700">
          <Link href="/" className="text-xl font-bold tracking-tight text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300 transition-colors duration-150">
            PrintForge
          </Link>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="md:hidden rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
          {filteredNav === null ? (
            // Skeleton while /auth/me resolves
            Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md px-3 py-2 animate-pulse">
                <div className="h-5 w-5 flex-shrink-0 rounded bg-gray-200 dark:bg-gray-700" />
                <div className="h-4 rounded bg-gray-200 dark:bg-gray-700" style={{ width: `${60 + (i % 3) * 20}px` }} />
              </div>
            ))
          ) : (
            filteredNav.map((item) => {
              const isActive = pathname === item.href ||
                (item.href !== '/' && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 min-h-[44px] text-sm font-medium transition-colors duration-150',
                    isActive
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100',
                  )}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  {item.name}
                </Link>
              );
            })
          )}
        </nav>
      </aside>
    </>
  );
}
