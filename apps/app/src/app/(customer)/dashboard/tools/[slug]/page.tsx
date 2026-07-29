'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Puzzle } from 'lucide-react';

interface CustomerAddon {
  id: string;
  slug: string;
  name: string;
  entry: string;
}

/**
 * Customer-facing addon host. Only addons an admin has published to the portal
 * are listed by /addons/customer, and the API's serve route independently
 * refuses customer requests for unpublished addons — so guessing a slug here
 * yields nothing.
 */
export default function CustomerAddonPage() {
  const params = useParams();
  const slug = String(params?.slug ?? '');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [addon, setAddon] = useState<CustomerAddon | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!slug) return;
    api.get<CustomerAddon[]>('/addons/customer')
      .then((list) => {
        const match = Array.isArray(list) ? list.find((a) => a.slug === slug) : null;
        if (match) setAddon(match);
        else setNotFound(true);
      })
      .catch(() => setNotFound(true));
  }, [slug]);

  function sendInit() {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    win.postMessage(
      { type: 'printforge:init', apiBase: window.location.origin, theme, role: 'customer' },
      window.location.origin,
    );
  }

  function handleLoaded() {
    setReady(true);
    sendInit();
  }

  if (notFound) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-gray-500 dark:text-gray-400">
          <Puzzle className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">This tool isn&apos;t available</p>
          <p className="text-sm mt-1">
            Head back to the{' '}
            <Link href="/dashboard/shop" className="text-brand-600 dark:text-brand-400 hover:underline">
              Shop
            </Link>{' '}
            to browse our products.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="-m-4 md:-m-6 h-[calc(100%+2rem)] md:h-[calc(100%+3rem)] relative bg-white dark:bg-gray-950">
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-gray-950">
          <div className="text-center">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Loading {addon?.name ?? 'tool'}…
            </p>
          </div>
        </div>
      )}
      {addon && (
        <iframe
          ref={iframeRef}
          title={addon.name}
          src={`/api/addons/serve/${addon.slug}/${addon.entry}`}
          className="w-full h-full border-0 block"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups"
          onLoad={handleLoaded}
        />
      )}
    </div>
  );
}
