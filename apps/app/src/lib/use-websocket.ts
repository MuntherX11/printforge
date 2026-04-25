'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export interface PrinterStatusEvent {
  printerId: string;
  hostname?: string;
  printerState?: string;
  progress?: number;
  extruder?: { temperature: number; target: number };
  heaterBed?: { temperature: number; target: number };
  printStats?: { filename?: string; state?: string; total_duration?: number };
}

export interface JobProgressEvent {
  jobId: string;
  progress: number;
  status: string;
}

export interface NotificationEvent {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
}

interface WebSocketState {
  connected: boolean;
  printerStatuses: Record<string, PrinterStatusEvent>;
  jobProgress: Record<string, JobProgressEvent>;
  lastNotification: NotificationEvent | null;
}

let sharedSocket: Socket | null = null;
let refCount = 0;

function getSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io('/ws', {
      path: '/api/socket.io/',
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });
  }
  return sharedSocket;
}

/**
 * Hook that connects to the PrintForge WebSocket gateway.
 * Uses a shared socket instance so multiple components don't create multiple connections.
 */
export function useWebSocket() {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    printerStatuses: {},
    jobProgress: {},
    lastNotification: null,
  });

  const socketRef = useRef<Socket | null>(null);

  const updatePrinterStatus = useCallback((data: PrinterStatusEvent[]) => {
    setState(prev => {
      let changed = false;
      const next = { ...prev.printerStatuses };
      for (const entry of data) {
        if (JSON.stringify(prev.printerStatuses[entry.printerId]) !== JSON.stringify(entry)) {
          next[entry.printerId] = entry;
          changed = true;
        }
      }
      if (!changed) return { ...prev, connected: true };
      return { ...prev, printerStatuses: next, connected: true };
    });
  }, []);

  const updateJobProgress = useCallback((data: JobProgressEvent) => {
    setState(prev => ({
      ...prev,
      jobProgress: { ...prev.jobProgress, [data.jobId]: data },
    }));
  }, []);

  const handleNotification = useCallback((data: NotificationEvent) => {
    setState(prev => ({ ...prev, lastNotification: { ...data } }));
  }, []);

  useEffect(() => {
    refCount++;
    const socket = getSocket();
    socketRef.current = socket;

    const onConnect = () => setState(prev => ({ ...prev, connected: true }));
    const onDisconnect = () => setState(prev => ({ ...prev, connected: false }));

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('printerStatus', updatePrinterStatus);
    socket.on('jobProgress', updateJobProgress);
    socket.on('notification', handleNotification);

    if (socket.connected) {
      setState(prev => ({ ...prev, connected: true }));
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('printerStatus', updatePrinterStatus);
      socket.off('jobProgress', updateJobProgress);
      socket.off('notification', handleNotification);

      refCount--;
      if (refCount === 0 && sharedSocket) {
        sharedSocket.disconnect();
        sharedSocket = null;
      }
    };
  }, [updatePrinterStatus, updateJobProgress, handleNotification]);

  return state;
}
