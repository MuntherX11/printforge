'use client';

import { useState } from 'react';
import { Loading } from '@/components/ui/loading';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/lib/locale-context';
import { Upload, Calculator, Link2 } from 'lucide-react';
import { useQuickQuote } from './useQuickQuote';
import { FileQuotePanel } from './FileQuotePanel';
import { LinkQuotePanel } from './LinkQuotePanel';
import { ThreeMfQuotePanel } from './ThreeMfQuotePanel';

type Mode = 'file' | 'multi' | 'link';

export default function QuickQuotePage() {
  const formatCurrency = useFormatCurrency();
  const { materials, printers, customers, loading } = useQuickQuote();
  const [mode, setMode] = useState<Mode>('file');

  if (loading) return <Loading />;

  const panelProps = { materials, printers, customers, formatCurrency };

  return (
    <div className="space-y-6">
      {/* Header + mode tabs */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Quick Quote</h1>
        <div className="flex gap-2">
          <Button
            variant={mode === 'file' ? 'primary' : 'outline'}
            onClick={() => setMode('file')}
          >
            <Upload className="h-4 w-4 mr-2" /> File Upload
          </Button>
          <Button
            variant={mode === 'multi' ? 'primary' : 'outline'}
            onClick={() => setMode('multi')}
          >
            <Calculator className="h-4 w-4 mr-2" /> Multi-Color
          </Button>
          <Button
            variant={mode === 'link' ? 'primary' : 'outline'}
            onClick={() => setMode('link')}
          >
            <Link2 className="h-4 w-4 mr-2" /> Link Quote
          </Button>
        </div>
      </div>

      {mode === 'file' && <FileQuotePanel {...panelProps} />}
      {mode === 'multi' && <ThreeMfQuotePanel {...panelProps} />}
      {mode === 'link' && (
        <LinkQuotePanel {...panelProps} onSwitchToFile={() => setMode('file')} />
      )}
    </div>
  );
}
