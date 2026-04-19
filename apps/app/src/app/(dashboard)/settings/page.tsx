'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { Upload, Send, Database, Download, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/ui/toast';

export default function SettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testingEmail, setTestingEmail] = useState(false);
  const [testWaTo, setTestWaTo] = useState('');
  const [testingWa, setTestingWa] = useState(false);
  const [backups, setBackups] = useState<Array<{ filename: string; sizeBytes: number; createdAt: string }>>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);

  function loadBackups() {
    setLoadingBackups(true);
    api.get<{ backups: Array<{ filename: string; sizeBytes: number; createdAt: string }> }>('/settings/backups')
      .then(r => setBackups(r.backups))
      .catch(() => {})
      .finally(() => setLoadingBackups(false));
  }

  useEffect(() => {
    api.get<Record<string, string>>('/settings').then(setSettings).catch(console.error).finally(() => setLoading(false));
    // Check if logo exists
    fetch('/api/settings/logo', { credentials: 'include' }).then(r => {
      if (r.ok) setLogoUrl('/api/settings/logo');
    }).catch(() => {});
    loadBackups();
  }, []);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const entries = Array.from(form.entries())
      .filter(([key]) => key !== 'logo')
      .map(([key, value]) => ({ key, value: value as string }));
    try {
      await api.put('/settings', { settings: entries });
      toast('success', 'Settings saved');
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      await api.upload('/settings/logo', file, {});
      setLogoUrl('/api/settings/logo?t=' + Date.now());
    } catch (err: any) {
      toast('error', err.message);
    } finally {
      setUploadingLogo(false);
      e.target.value = '';
    }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <div className="flex gap-2">
          <Link href="/settings/users"><Button variant="outline">User Management</Button></Link>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Company</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-6">
              <div className="flex-shrink-0">
                <p className="text-sm font-medium text-gray-700 mb-2">Company Logo</p>
                <div className="w-24 h-24 border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center overflow-hidden bg-gray-50">
                  {logoUrl ? (
                    <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                  ) : (
                    <Upload className="h-8 w-8 text-gray-400" />
                  )}
                </div>
                <label className="cursor-pointer mt-2 block">
                  <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={uploadingLogo} />
                  <span className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 w-24 mt-2">
                    {uploadingLogo ? 'Uploading' : 'Upload'}
                  </span>
                </label>
              </div>
              <div className="flex-1 space-y-4">
                <Input name="company_name" label="Company Name" defaultValue={settings.company_name || ''} />
                <Input name="company_address" label="Address" defaultValue={settings.company_address || ''} />
                <div className="grid grid-cols-2 gap-4">
                  <Input name="company_phone" label="Phone" defaultValue={settings.company_phone || ''} />
                  <Input name="company_email" label="Email" defaultValue={settings.company_email || ''} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Financial</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-4 gap-4">
              <Input name="currency" label="Currency Code" defaultValue={settings.currency || 'OMR'} placeholder="OMR" />
              <Input name="currency_decimals" label="Decimal Places" type="number" min="0" max="4" defaultValue={settings.currency_decimals || '3'} />
              <Input name="tax_rate" label="Tax Rate (%)" type="number" step="0.1" defaultValue={settings.tax_rate || '0'} />
              <Input name="overhead_percent" label="Overhead (%)" type="number" step="0.1" defaultValue={settings.overhead_percent || '15'} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Select name="locale" label="Locale" defaultValue={settings.locale || 'en-GB'} options={[
                { value: 'en-GB', label: 'English (UK) — dd/MM/yyyy' },
                { value: 'en-US', label: 'English (US) — MM/dd/yyyy' },
                { value: 'ar-OM', label: 'Arabic (Oman)' },
                { value: 'ar-SA', label: 'Arabic (Saudi Arabia)' },
                { value: 'ar-AE', label: 'Arabic (UAE)' },
                { value: 'de-DE', label: 'German' },
                { value: 'fr-FR', label: 'French' },
                { value: 'es-ES', label: 'Spanish' },
                { value: 'ja-JP', label: 'Japanese' },
                { value: 'zh-CN', label: 'Chinese (Simplified)' },
              ]} />
              <Select name="date_format" label="Date Format" defaultValue={settings.date_format || 'dd MMM yyyy'} options={[
                { value: 'dd MMM yyyy', label: '11 Apr 2026' },
                { value: 'MMM dd, yyyy', label: 'Apr 11, 2026' },
                { value: 'yyyy-MM-dd', label: '2026-04-11' },
                { value: 'dd/MM/yyyy', label: '11/04/2026' },
                { value: 'MM/dd/yyyy', label: '04/11/2026' },
              ]} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Input name="markup_multiplier" label="Default Markup Multiplier" type="number" step="0.01" defaultValue={settings.markup_multiplier || '2.5'} />
              <Input name="machine_hourly_rate" label="Default Machine Rate (OMR/hr)" type="number" step="0.001" defaultValue={settings.machine_hourly_rate || '0.400'} />
              <Input name="electricity_rate_kwh" label="Electricity Rate (OMR/kWh)" type="number" step="0.001" defaultValue={settings.electricity_rate_kwh || '0.025'} />
            </div>
            <p className="text-xs text-gray-400">
              <strong>Markup &amp; hourly rate</strong> are global defaults — each printer can override them in its own Costing section.
              Filament cost is auto-calculated per material type from spool prices in inventory.
            </p>
            <p className="text-xs text-gray-400">Oman residential electricity: Slab 1 (0-4000 kWh) = 0.010, Slab 2 (4001-6000) = 0.015, Slab 3 (6001+) = 0.025 OMR/kWh.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Invoice</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Textarea name="bank_details" label="Bank / Payment Details (shown on invoice)" defaultValue={settings.bank_details || ''} />
            <Textarea name="invoice_notes" label="Default Invoice Notes" defaultValue={settings.invoice_notes || ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Email (SMTP)</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-500">For Gmail: use smtp.gmail.com, port 587, your Gmail address, and an App Password (not your regular password).</p>
            <div className="grid grid-cols-2 gap-4">
              <Input name="smtp_host" label="SMTP Host" defaultValue={settings.smtp_host || 'smtp.gmail.com'} />
              <Input name="smtp_port" label="SMTP Port" defaultValue={settings.smtp_port || '587'} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input name="smtp_user" label="SMTP Username / Email" defaultValue={settings.smtp_user || ''} />
              <Input name="smtp_pass" label="SMTP Password / App Password" type="password" defaultValue={settings.smtp_pass || ''} />
            </div>
            <Input name="admin_email" label="Admin Email (for internal alerts)" defaultValue={settings.admin_email || ''} />
            <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
              <input
                type="text"
                placeholder="test@example.com"
                value={testEmailTo}
                onChange={e => setTestEmailTo(e.target.value)}
                className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testingEmail || !testEmailTo}
                onClick={async () => {
                  setTestingEmail(true);
                  try {
                    await api.post('/communications/test-email', { to: testEmailTo });
                    toast('success', 'Test email sent!');
                  } catch (err: any) {
                    toast('error', err.message);
                  } finally {
                    setTestingEmail(false);
                  }
                }}
              >
                <Send className="h-3.5 w-3.5 mr-1" />
                {testingEmail ? 'Sending...' : 'Send Test Email'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>WhatsApp Business</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-500">
              Uses the <strong>Meta WhatsApp Business Cloud API</strong>. Requires a Meta Business account, a verified phone number, and a permanent access token.{' '}
              <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Setup guide →</a>
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Input name="whatsapp_phone_id" label="Phone Number ID" placeholder="123456789012345" defaultValue={settings.whatsapp_phone_id || ''} />
              <Input name="whatsapp_token" label="Permanent Access Token" type="password" placeholder="EAAxxxxxxxxxxxxxxx" defaultValue={settings.whatsapp_token || ''} />
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" name="whatsapp_enabled" id="whatsapp_enabled" value="true" defaultChecked={settings.whatsapp_enabled === 'true'} className="rounded border-gray-300 text-brand-600" />
              <label htmlFor="whatsapp_enabled" className="text-sm text-gray-700 dark:text-gray-300">Enable WhatsApp notifications</label>
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              ⚠️ Free-form text messages work only within 24 hours of a customer contacting you. For proactive outbound notifications, create approved Message Templates in Meta Business Manager.
            </p>
            <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
              <input
                type="text"
                placeholder="+96812345678"
                value={testWaTo}
                onChange={e => setTestWaTo(e.target.value)}
                className="flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testingWa || !testWaTo}
                onClick={async () => {
                  setTestingWa(true);
                  try {
                    await api.post('/communications/test-whatsapp', { to: testWaTo });
                    toast('success', 'Test WhatsApp message sent!');
                  } catch (err: any) {
                    toast('error', err.message);
                  } finally {
                    setTestingWa(false);
                  }
                }}
              >
                <Send className="h-3.5 w-3.5 mr-1" />
                {testingWa ? 'Sending...' : 'Send Test Message'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Notification Events</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-500">Choose which events send email and/or WhatsApp messages to customers automatically.</p>
            <div className="space-y-2">
              {[
                { key: 'notify_quote_sent', label: 'Quote sent to customer' },
                { key: 'notify_order_confirmed', label: 'Order confirmed' },
                { key: 'notify_order_production', label: 'Order moved to In Production' },
                { key: 'notify_order_ready', label: 'Order ready for pickup' },
                { key: 'notify_order_completed', label: 'All production jobs completed' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center gap-3 py-1">
                  <input
                    type="checkbox"
                    name={key}
                    id={key}
                    value="true"
                    defaultChecked={settings[key] !== 'false'}
                    className="rounded border-gray-300 text-brand-600"
                  />
                  <label htmlFor={key} className="text-sm text-gray-700 dark:text-gray-300">{label}</label>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Printing</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input name="purge_waste_grams" label="Purge Waste per Color Change (g)" type="number" step="0.1" defaultValue={settings.purge_waste_grams || '5'} />
              <Input name="default_infill_percent" label="Default Infill % (for STL estimation)" type="number" defaultValue={settings.default_infill_percent || '20'} />
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</Button>
      </form>

      {/* Database Backups (outside the settings form — read-only panel) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" /> Database Backups</CardTitle>
            <Button variant="outline" size="sm" onClick={loadBackups} disabled={loadingBackups}>
              <RefreshCw className={`h-4 w-4 mr-1 ${loadingBackups ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {backups.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">No backups found. Backups run automatically every 24 hours.</p>
          ) : (
            <div className="space-y-2">
              {backups.map(b => (
                <div key={b.filename} className="flex items-center justify-between py-2 border-b dark:border-gray-700 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{b.filename}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(b.createdAt).toLocaleString()} &middot; {(b.sizeBytes / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <a
                    href={`/api/settings/backups/${b.filename}`}
                    download={b.filename}
                    className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                </div>
              ))}
              <p className="text-xs text-gray-400 pt-2">Backups are retained for 7 days. Running automatically every 24 hours.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
