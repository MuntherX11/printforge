import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CustomerSidebar } from '@/components/customer-sidebar';
import { CustomerTopbar } from '@/components/customer-topbar';

// NOTE: This layout checks for a token to gate UI routing only.
// Actual access control is enforced by the API-level CustomerGuard on every endpoint.
// The token here may belong to any role; the API guards reject non-customer tokens.
export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = cookies();
  const token = cookieStore.get('token');

  if (!token) {
    redirect('/login');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <CustomerSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <CustomerTopbar />
        <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
