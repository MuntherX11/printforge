'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { LogOut } from 'lucide-react';

interface CustomerUser {
  id: string;
  name: string;
  email: string;
  userType: 'customer';
}

export function CustomerTopbar() {
  const [user, setUser] = useState<CustomerUser | null>(null);
  const router = useRouter();

  useEffect(() => {
    api.get<CustomerUser>('/auth/customer/me')
      .then(setUser)
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await api.post('/auth/logout');
    router.push('/customer-login');
  }

  return (
    <div className="flex h-16 items-center justify-between border-b bg-white px-6">
      <div />
      <div className="flex items-center gap-4">
        {user && (
          <span className="text-sm text-gray-600">
            {user.name}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4 mr-1" />
          Logout
        </Button>
      </div>
    </div>
  );
}
