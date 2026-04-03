'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/components/ui/loading';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Send, Check, RotateCcw } from 'lucide-react';

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  REQUESTED: 'warning', ASSIGNED: 'info', IN_PROGRESS: 'info', REVIEW: 'warning',
  REVISION: 'warning', APPROVED: 'success', QUOTED: 'success', IN_PRODUCTION: 'info',
  COMPLETED: 'success', CANCELLED: 'error',
};

const statusLabels: Record<string, string> = {
  REQUESTED: 'Your request has been submitted and is awaiting assignment.',
  ASSIGNED: 'A designer has been assigned to your project.',
  IN_PROGRESS: 'Your design is being worked on.',
  REVIEW: 'A new revision is ready for your review. Please approve or request changes.',
  REVISION: 'The designer is working on your requested changes.',
  APPROVED: 'You approved the design. Waiting for quote.',
  QUOTED: 'A quote has been generated for this project.',
  IN_PRODUCTION: 'Your order is in production.',
  COMPLETED: 'Your order has been completed.',
  CANCELLED: 'This project has been cancelled.',
};

export default function CustomerDesignDetailPage() {
  const { id } = useParams();
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  function loadProject() {
    api.get<any>(`/design-projects/${id}`)
      .then(setProject)
      .catch(console.error)
      .finally(() => setLoading(false));
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

  async function handleApprove() {
    try {
      await api.post(`/design-projects/customer/${id}/approve`);
      toast('success', 'Design approved');
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to approve');
    }
  }

  async function handleRequestChanges() {
    if (!feedback.trim()) {
      toast('error', 'Please describe the changes you need');
      return;
    }
    try {
      await api.post(`/design-projects/customer/${id}/request-changes`, { feedback });
      setFeedback('');
      toast('success', 'Change request submitted');
      loadProject();
    } catch (err: any) {
      toast('error', err.message || 'Failed to submit');
    }
  }

  if (loading) return <Loading />;
  if (!project) return <div className="text-red-600">Project not found</div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{project.title}</h1>
          <Badge variant={statusVariant[project.status] || 'default'}>{project.status}</Badge>
        </div>
        <p className="text-gray-500 mt-1">{project.projectNumber}</p>
        <p className="text-sm text-gray-500 mt-2">{statusLabels[project.status] || ''}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chat */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Messages</CardTitle></CardHeader>
            <CardContent>
              <div className="h-96 overflow-y-auto space-y-3 mb-4 border rounded-lg p-4 bg-gray-50">
                {project.brief && (
                  <div className="bg-white rounded-lg p-3 border text-sm">
                    <div className="text-xs text-gray-400 mb-1">Your Brief</div>
                    <p className="text-gray-700">{project.brief}</p>
                  </div>
                )}
                {project.comments?.map((c: any) => (
                  <div key={c.id} className={`flex ${c.isCustomer ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-lg p-3 text-sm ${
                      c.isCustomer ? 'bg-brand-50 border border-brand-200' : 'bg-white border'
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

              {!['COMPLETED', 'CANCELLED'].includes(project.status) && (
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
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Info */}
          <Card>
            <CardHeader><CardTitle className="text-sm">Project Info</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {project.assignedTo && (
                <div><span className="text-gray-500">Designer:</span> {project.assignedTo.name}</div>
              )}
              {project.estimatedDelivery && (
                <div><span className="text-gray-500">Est. Delivery:</span> {formatDate(project.estimatedDelivery)}</div>
              )}
              {project.totalDesignFee > 0 && (
                <div><span className="text-gray-500">Design Fee:</span> {project.totalDesignFee.toFixed(3)} OMR</div>
              )}
              {project.revisions?.length > 0 && (
                <div><span className="text-gray-500">Revisions:</span> {project.revisions.length}</div>
              )}
            </CardContent>
          </Card>

          {/* Review Actions */}
          {project.status === 'REVIEW' && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Review Design</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Button className="w-full" onClick={handleApprove}>
                  <Check className="h-4 w-4 mr-2" /> Approve Design
                </Button>
                <div className="border-t pt-3">
                  <Textarea
                    value={feedback}
                    onChange={e => setFeedback(e.target.value)}
                    placeholder="Describe the changes you need..."
                    rows={3}
                  />
                  <Button variant="outline" className="w-full mt-2" onClick={handleRequestChanges}>
                    <RotateCcw className="h-4 w-4 mr-2" /> Request Changes
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
