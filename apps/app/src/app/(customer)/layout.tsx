import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CustomerSidebar } from '@/components/customer-sidebar';
import { CustomerTopbar } from '@/components/customer-topbar';

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = cookies();
  const token = cookieStore.get('token');

  if (!token) {
    redirect('/customer-login');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <CustomerSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <CustomerTopbar />
        <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
