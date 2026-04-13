'use client';

import { useEffect, useRef } from 'react';
import { useWebSocket } from '@/lib/use-websocket';
import { useToast } from '@/components/ui/toast';

/**
 * Invisible component that listens for WebSocket notification events
 * and surfaces them as toasts. Mount once in the root layout.
 */
export function WsNotifications() {
  const { lastNotification } = useWebSocket();
  const { toast } = useToast();
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!lastNotification) return;
    // Deduplicate by stringifying the notification
    const id = JSON.stringify(lastNotification);
    if (id === lastIdRef.current) return;
    lastIdRef.current = id;

    const type = lastNotification.type === 'info' ? 'success' : lastNotification.type as any;
    toast(type, `${lastNotification.title}: ${lastNotification.message}`);
  }, [lastNotification, toast]);

  return null;
}
