'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Upload } from 'lucide-react';

interface LinkQuotePanelProps {
  materials: any[];
  printers: any[];
  customers: any[];
  formatCurrency: (amount: number) => string;
  onSwitchToFile: () => void;
}

export function LinkQuotePanel({ onSwitchToFile }: LinkQuotePanelProps) {
  const { toast } = useToast();

  const [linkUrl, setLinkUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scrapedData, setScrapedData] = useState<any>(null);
  const [error, setError] = useState('');

  async function handleScrapeUrl() {
    if (!linkUrl.trim()) return;
    setScraping(true);
    setScrapedData(null);
    setError('');
    try {
      const data = await api.post('/file-parser/scrape-url', { url: linkUrl });
      setScrapedData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to scrape URL');
    } finally {
      setScraping(false);
    }
  }

  return (
    <>
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model URL</label>
            <p className="text-xs text-gray-400 mb-2">
              Paste a link from MakerWorld, Thangs, Thingiverse, Printables, MyMiniFactory, or Cults3D
            </p>
            <div className="flex gap-2">
              <Input
                value={linkUrl}
                onChange={e => setLinkUrl(e.target.value)}
                placeholder="https://makerworld.com/en/models/..."
                className="flex-1"
              />
              <Button onClick={handleScrapeUrl} disabled={scraping || !linkUrl.trim()}>
                {scraping ? 'Scraping...' : 'Fetch'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {scrapedData && (
        <Card>
          <CardContent className="p-6">
            <div className="flex gap-4">
              {scrapedData.thumbnailUrl && (
                <Image
                  src={scrapedData.thumbnailUrl}
                  alt={scrapedData.title || 'Model preview'}
                  width={128}
                  height={128}
                  loading="lazy"
                  className="w-32 h-32 object-cover rounded-lg border"
                  unoptimized
                />
              )}
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {scrapedData.siteName && (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{scrapedData.siteName}</span>
                  )}
                </div>
                <h3 className="font-semibold text-lg">{scrapedData.title || 'Unknown Model'}</h3>
                {scrapedData.description && (
                  <p className="text-sm text-gray-500 mt-1 line-clamp-3">{scrapedData.description}</p>
                )}
                <a
                  href={scrapedData.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-brand-600 hover:underline mt-2 inline-block"
                >
                  View on {scrapedData.siteName || 'site'}
                </a>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t space-y-3">
              {scrapedData.isPaid ? (
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded">
                  This model requires purchase on {scrapedData.siteName || 'the source site'}
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-600">
                    To generate an accurate quote, the STL file is needed. You can:
                  </p>
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" onClick={onSwitchToFile}>
                      <Upload className="h-4 w-4 mr-1" /> Upload STL Yourself
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => {
                      toast('success', 'Request noted — admin will handle the STL file');
                    }}>
                      Let Us Handle It
                    </Button>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
