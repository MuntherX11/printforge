import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = cookies();
  const token = cookieStore.get('token');

  if (!token) {
    redirect('/staff-login');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
