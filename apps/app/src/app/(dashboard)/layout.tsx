import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { SidebarProvider } from '@/components/sidebar-provider';
import { AuthProvider } from '@/lib/auth-context';
import { WsStatusBanner } from '@/components/ui/ws-status-banner';

// Staff pages that render inside the dashboard route group but without chrome
// (the QR spool page a phone opens from a label). They still need a login.
const chromelessPathPatterns = [
  /^\/inventory\/spool\/[A-Za-z0-9-]+$/,
];

function isChromeless(pathname: string): boolean {
  return chromelessPathPatterns.some(p => p.test(pathname));
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const headerList = headers();
  const pathname = headerList.get('x-pathname') || '';
  const chromeless = isChromeless(pathname);

  // The middleware normally redirects first; this is the backstop. The path
  // only picks where to come back to, never whether a login is needed.
  const cookieStore = cookies();
  const token = cookieStore.get('token');
  if (!token) {
    redirect(chromeless ? '/staff-login?next=' + encodeURIComponent(pathname) : '/staff-login');
  }

  // Chrome-less pages: minimal layout without sidebar/topbar
  if (chromeless) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-950 p-6">
        {children}
      </main>
    );
  }

  return (
    <AuthProvider>
      <SidebarProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <Topbar />
            <WsStatusBanner />
            <main className="pf-main-offset flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-4 md:p-6">
              {children}
            </main>
          </div>
        </div>
      </SidebarProvider>
    </AuthProvider>
  );
}
