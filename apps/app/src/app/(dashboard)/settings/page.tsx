'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { Upload } from 'lucide-react';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  useEffect(() => {
    api.get<Record<string, string>>('/settings').then(setSettings).catch(console.error).finally(() => setLoading(false));
    // Check if logo exists
    fetch('/api/settings/logo', { credentials: 'include' }).then(r => {
      if (r.ok) setLogoUrl('/api/settings/logo');
    }).catch(() => {});
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
      alert('Settings saved');
    } catch (err: any) {
      alert(err.message);
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
      alert(err.message);
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
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Locale</label>
                <select name="locale" defaultValue={settings.locale || 'en-GB'} className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
                  <option value="en-GB">English (UK) — dd/MM/yyyy</option>
                  <option value="en-US">English (US) — MM/dd/yyyy</option>
                  <option value="ar-OM">Arabic (Oman)</option>
                  <option value="ar-SA">Arabic (Saudi Arabia)</option>
                  <option value="ar-AE">Arabic (UAE)</option>
                  <option value="de-DE">German</option>
                  <option value="fr-FR">French</option>
                  <option value="es-ES">Spanish</option>
                  <option value="ja-JP">Japanese</option>
                  <option value="zh-CN">Chinese (Simplified)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date Format</label>
                <select name="date_format" defaultValue={settings.date_format || 'dd MMM yyyy'} className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
                  <option value="dd MMM yyyy">11 Apr 2026</option>
                  <option value="MMM dd, yyyy">Apr 11, 2026</option>
                  <option value="yyyy-MM-dd">2026-04-11</option>
                  <option value="dd/MM/yyyy">11/04/2026</option>
                  <option value="MM/dd/yyyy">04/11/2026</option>
                </select>
              </div>
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
            <p className="text-sm text-gray-500">For Gmail: use smtp.gmail.com, port 587, your Gmail address, and an App Password.</p>
            <div className="grid grid-cols-2 gap-4">
              <Input name="smtp_host" label="SMTP Host" defaultValue={settings.smtp_host || 'smtp.gmail.com'} />
              <Input name="smtp_port" label="SMTP Port" defaultValue={settings.smtp_port || '587'} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input name="smtp_user" label="SMTP Username / Email" defaultValue={settings.smtp_user || ''} />
              <Input name="smtp_pass" label="SMTP Password / App Password" type="password" defaultValue={settings.smtp_pass || ''} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>WhatsApp</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-500">WhatsApp messages open in a new tab using wa.me links. Set a default message template below.</p>
            <Textarea name="whatsapp_template" label="Default WhatsApp Message Template" placeholder="Hello {name}, your order {order} is ready for pickup!" defaultValue={settings.whatsapp_template || 'Hello {name}, this is {company}. '} />
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
    </div>
  );
}
