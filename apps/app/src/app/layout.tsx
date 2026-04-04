import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { ServiceWorkerRegister } from '@/components/sw-register';
import { ToastProvider } from '@/components/ui/toast';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'PrintForge',
  description: 'ERP for 3D Print Farms',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'PrintForge',
  },
  icons: {
    icon: '/icons/icon.svg',
    apple: '/icons/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Inline script to set dark class before first paint (prevents flash)
  const themeScript = `(function(){try{var t=localStorage.getItem('printforge-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={inter.className}>
        <ToastProvider>
          <ServiceWorkerRegister />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
