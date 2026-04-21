'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Captures the browser's beforeinstallprompt event and shows an install button.
 * Dismissed state is persisted in localStorage so the prompt doesn't reappear.
 */
export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Respect a 30-day snooze, not a permanent dismiss
    const snoozed = localStorage.getItem('pwa-install-dismissed');
    if (snoozed && Date.now() < parseInt(snoozed, 10)) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // If already installed (standalone), never show
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setVisible(false);
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!visible || !deferredPrompt) return null;

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'dismissed') {
      localStorage.setItem('pwa-install-dismissed', '1');
    }
    setVisible(false);
    setDeferredPrompt(null);
  }

  function handleDismiss() {
    // Snooze for 30 days
    const snoozeUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
    localStorage.setItem('pwa-install-dismissed', String(snoozeUntil));
    setVisible(false);
  }

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm max-w-sm w-full mx-4">
      <Download className="h-5 w-5 text-brand-600 shrink-0" />
      <div className="flex-1">
        <p className="font-medium text-gray-800 dark:text-gray-100">Install PrintForge</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">Runs as a native desktop app — no browser chrome</p>
      </div>
      <Button size="sm" onClick={handleInstall}>Install</Button>
      <button
        onClick={handleDismiss}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
