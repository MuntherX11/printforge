import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { SidebarProvider } from '@/components/sidebar-provider';
import { LocaleProvider } from '@/lib/locale-context';
import { WsStatusBanner } from '@/components/ui/ws-status-banner';

// Public pages that render inside the dashboard route group but without chrome
const publicPathPatterns = [
  /^\/inventory\/spool\/[A-Za-z0-9-]+$/,
];

function isPublicPage(pathname: string): boolean {
  return publicPathPatterns.some(p => p.test(pathname));
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const headerList = headers();
  const pathname = headerList.get('x-pathname') || '';
  const isPublic = isPublicPage(pathname);

  if (!isPublic) {
    const cookieStore = cookies();
    const token = cookieStore.get('token');
    if (!token) {
      redirect('/staff-login');
    }
  }

  // Public pages: minimal layout without sidebar/topbar
  if (isPublic) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-950 p-6">
        <LocaleProvider>{children}</LocaleProvider>
      </main>
    );
  }

  return (
    <LocaleProvider>
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
    </LocaleProvider>
  );
}
