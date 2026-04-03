'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/components/ui/loading';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Send, UserPlus, Upload, FileText } from 'lucide-react';

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  REQUESTED: 'warning', ASSIGNED: 'info', IN_PROGRESS: 'info', REVIEW: 'warning',
  REVISION: 'warning', APPROVED: 'success', QUOTED: 'success', IN_PRODUCTION: 'info',
  COMPLETED: 'success', CANCELLED: 'error',
};

export default function DesignDetailPage() {
  const { id } = useParams();
  const [project, setProject] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  function loadProject() {
    Promise.all([
      api.get<any>(`/design-projects/${id}`),
      api.get<any>('/users').then(r => r.data || r).catch(() => []),
    ]).then(([proj, userList]) => {
      setProject(proj);
      setUsers(Array.isArray(userList) ? userList : []);
    }).catch(console.error).finally(() => setLoading(false));
  }

  useEffect(() => { loadProject(); }, [id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [project?.comments]);

  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setSending(true);
    try {
      await api.post(`/design-projects/${id}/comments`, { content: message });
      setMessage('');
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function handleAssign(userId: string) {
    try {
      await api.post(`/design-projects/${id}/assign`, { userId });
      toast('success', 'Designer assigned');
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to assign');
    }
  }

  async function handleStatusChange(status: string) {
    try {
      await api.patch(`/design-projects/${id}`, { status });
      toast('success', `Status updated to ${status}`);
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to update status');
    }
  }

  async function handleAddRevision() {
    try {
      await api.post(`/design-projects/${id}/revisions`, { description: 'New revision' });
      toast('success', 'Revision added — project moved to REVIEW');
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to add revision');
    }
  }

  async function handleUpdateFee(e: React.FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    try {
      await api.patch(`/design-projects/${id}`, {
        designFeeType: form.get('feeType'),
        designFeeAmount: parseFloat(form.get('feeAmount') as string) || 0,
        designFeeHours: parseFloat(form.get('feeHours') as string) || undefined,
        estimatedDelivery: form.get('delivery') || undefined,
      });
      toast('success', 'Project details updated');
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to update');
    }
  }

  if (loading) return <Loading />;
  if (!project) return <div className="text-red-600">Project not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{project.projectNumber} — {project.title}</h1>
          <p className="text-gray-500">Customer: {project.customer?.name} | Created: {formatDate(project.createdAt)}</p>
        </div>
        <Badge variant={statusVariant[project.status] || 'default'} className="text-sm px-3 py-1">
          {project.status}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Chat */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Messages</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-96 overflow-y-auto space-y-3 mb-4 border rounded-lg p-4 bg-gray-50">
                {project.brief && (
                  <div className="bg-white rounded-lg p-3 border text-sm">
                    <div className="text-xs text-gray-400 mb-1">Design Brief</div>
                    <p className="text-gray-700">{project.brief}</p>
                  </div>
                )}
                {project.comments?.map((c: any) => (
                  <div key={c.id} className={`flex ${c.isCustomer ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[75%] rounded-lg p-3 text-sm ${
                      c.isCustomer ? 'bg-white border' : 'bg-brand-50 border border-brand-200'
                    }`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-xs">{c.authorName}</span>
                        <span className="text-xs text-gray-400">{formatDate(c.createdAt)}</span>
                      </div>
                      <p className="text-gray-700 whitespace-pre-wrap">{c.content}</p>
                    </div>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              <form onSubmit={handleSendMessage} className="flex gap-2">
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 min-h-[40px] max-h-32"
                />
                <Button type="submit" disabled={sending || !message.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Revisions */}
          {project.revisions?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Revisions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {project.revisions.map((r: any) => (
                    <div key={r.id} className="flex justify-between items-center border-b pb-2 last:border-0">
                      <div>
                        <span className="font-medium text-sm">v{r.versionNumber}</span>
                        <span className="text-gray-500 text-sm ml-2">{r.description}</span>
                      </div>
                      <span className="text-xs text-gray-400">{formatDate(r.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: Controls */}
        <div className="space-y-4">
          {/* Assignment */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Assignment</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm">
                <span className="text-gray-500">Assigned to: </span>
                <span className="font-medium">{project.assignedTo?.name || 'Unassigned'}</span>
              </div>
              <Select
                label="Assign Designer"
                onChange={e => { if (e.target.value) handleAssign(e.target.value); }}
                options={[
                  { value: '', label: 'Select operator...' },
                  ...users.filter((u: any) => u.role === 'ADMIN' || u.role === 'OPERATOR')
                    .map((u: any) => ({ value: u.id, label: u.name })),
                ]}
              />
            </CardContent>
          </Card>

          {/* Status Actions */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Actions</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {project.status === 'ASSIGNED' && (
                <Button className="w-full" size="sm" onClick={() => handleStatusChange('IN_PROGRESS')}>
                  Start Working
                </Button>
              )}
              {(project.status === 'IN_PROGRESS' || project.status === 'REVISION') && (
                <Button className="w-full" size="sm" onClick={handleAddRevision}>
                  <Upload className="h-4 w-4 mr-1" /> Upload Revision (Send to Review)
                </Button>
              )}
              {project.status === 'APPROVED' && (
                <Button className="w-full" size="sm" onClick={() => handleStatusChange('QUOTED')}>
                  <FileText className="h-4 w-4 mr-1" /> Mark as Quoted
                </Button>
              )}
              {project.status === 'QUOTED' && (
                <Button className="w-full" size="sm" onClick={() => handleStatusChange('IN_PRODUCTION')}>
                  Move to Production
                </Button>
              )}
              {project.status === 'IN_PRODUCTION' && (
                <Button className="w-full" size="sm" variant="secondary" onClick={() => handleStatusChange('COMPLETED')}>
                  Mark Completed
                </Button>
              )}
              {!['COMPLETED', 'CANCELLED'].includes(project.status) && (
                <Button className="w-full" size="sm" variant="destructive" onClick={() => handleStatusChange('CANCELLED')}>
                  Cancel Project
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Pricing */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Design Fee</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={handleUpdateFee} className="space-y-3">
                <Select
                  label="Fee Type"
                  name="feeType"
                  defaultValue={project.designFeeType || 'FLAT'}
                  options={[
                    { value: 'FLAT', label: 'Flat Fee' },
                    { value: 'HOURLY', label: 'Hourly Rate' },
                  ]}
                />
                <Input
                  label="Amount (OMR)"
                  name="feeAmount"
                  type="number"
                  step="0.001"
                  defaultValue={project.designFeeAmount || ''}
                />
                <Input
                  label="Hours (if hourly)"
                  name="feeHours"
                  type="number"
                  step="0.5"
                  defaultValue={project.designFeeHours || ''}
                />
                <Input
                  label="Estimated Delivery"
                  name="delivery"
                  type="date"
                  defaultValue={project.estimatedDelivery?.split('T')[0] || ''}
                />
                {project.totalDesignFee > 0 && (
                  <div className="text-sm font-medium text-brand-600">
                    Total Fee: {project.totalDesignFee?.toFixed(3)} OMR
                  </div>
                )}
                <Button type="submit" size="sm" variant="outline" className="w-full">
                  Update Fee & Delivery
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Quote info */}
          {project.quote && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Linked Quote</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm">
                  <span className="text-gray-500">Quote: </span>
                  <span className="font-medium">{project.quote.quoteNumber}</span>
                </p>
                <p className="text-sm">
                  <span className="text-gray-500">Total: </span>
                  <span className="font-medium">{project.quote.total?.toFixed(3)} OMR</span>
                </p>
                <Badge variant={project.quote.status === 'ACCEPTED' ? 'success' : 'default'}>
                  {project.quote.status}
                </Badge>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
