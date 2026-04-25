'use client';
import { useWebSocket } from '@/lib/use-websocket';
import { WifiOff } from 'lucide-react';

export function WsStatusBanner() {
  const { connected } = useWebSocket();
  if (connected) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-b border-amber-200 dark:border-amber-800">
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>Live updates disconnected — reconnecting…</span>
    </div>
  );
}
