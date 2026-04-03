'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  phone?: string;
}

export default function CustomerProfilePage() {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.get<CustomerProfile>('/auth/customer/me')
      .then(setProfile)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setSaving(true);
    try {
      const form = new FormData(e.target as HTMLFormElement);
      await api.patch('/customers/me', {
        name: form.get('name'),
        phone: form.get('phone') || null,
      });
      toast('success', 'Profile updated');
    } catch (err: any) {
      toast('error', err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>;
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Profile</h1>
      <Card>
        <CardHeader>
          <CardTitle>Your Information</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Full Name"
              name="name"
              defaultValue={profile?.name}
              required
            />
            <Input
              label="Email"
              type="email"
              value={profile?.email || ''}
              disabled
            />
            <Input
              label="Phone"
              name="phone"
              defaultValue={profile?.phone || ''}
            />
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Update Profile'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
