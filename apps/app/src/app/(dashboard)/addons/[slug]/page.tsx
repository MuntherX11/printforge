'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Loading } from '@/components/ui/loading';
import { Puzzle } from 'lucide-react';

interface AddonMeta {
  slug: string;
  name: string;
  entry: string;
  isActive: boolean;
}

export default function AddonHostPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const slug = String(params?.slug ?? '');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [meta, setMeta] = useState<AddonMeta | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!slug) return;
    api.get<AddonMeta>(`/addons/meta/${slug}`)
      .then(setMeta)
      .catch(() => setNotFound(true));
  }, [slug]);

  // Send the host handshake into the iframe: API origin + current theme.
  function sendInit() {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    win.postMessage(
      { type: 'printforge:init', apiBase: window.location.origin, theme },
      window.location.origin,
    );
  }

  // Listen for messages from the addon (ready / toast / navigate).
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      switch (data.type) {
        case 'printforge:ready':
          setReady(true);
          sendInit();
          break;
        case 'printforge:toast':
          if (data.message) toast(data.level === 'error' ? 'error' : 'success', String(data.message));
          break;
        case 'printforge:navigate':
          if (typeof data.path === 'string' && data.path.startsWith('/')) router.push(data.path);
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center text-gray-500 dark:text-gray-400">
        <Puzzle className="h-12 w-12 mb-3 opacity-30" />
        <p className="font-medium">Addon not found or disabled</p>
        <p className="text-sm mt-1">It may have been removed. Check Settings → Addons.</p>
      </div>
    );
  }

  return (
    // Bleed to the edges of the padded <main> so the addon gets full space.
    <div className="-m-4 md:-m-6 h-[calc(100%+2rem)] md:h-[calc(100%+3rem)] relative bg-white dark:bg-gray-950">
      {!ready && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-gray-950">
          <Loading text={meta ? `Loading ${meta.name}…` : 'Loading addon…'} />
        </div>
      )}
      {meta && (
        <iframe
          ref={iframeRef}
          title={meta.name}
          src={`/api/addons/serve/${meta.slug}/${meta.entry}`}
          className="w-full h-full border-0 block"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups"
          onLoad={sendInit}
        />
      )}
    </div>
  );
}
