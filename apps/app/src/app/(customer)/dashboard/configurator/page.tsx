'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, ArrowRight } from 'lucide-react';

interface GeneratorSummary {
  key: string;
  name: string;
  description: string;
  source?: 'built-in' | 'addon';
}

/** Lists the parametric products a customer can configure and order. */
export default function ConfiguratorIndexPage() {
  const [generators, setGenerators] = useState<GeneratorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get<GeneratorSummary[]>('/configurator/generators')
      .then((r) => setGenerators(Array.isArray(r) ? r : []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold dark:text-gray-100">Design &amp; Order</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Customise a product and order it directly — we generate the print file for you.
        </p>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-500 dark:text-gray-400">
            <p className="font-medium">Couldn&apos;t load the designers</p>
            <p className="text-sm mt-1">Please try again in a moment.</p>
          </CardContent>
        </Card>
      ) : generators.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-500 dark:text-gray-400">
            <Sparkles className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No designers available yet</p>
            <p className="text-sm mt-1">
              Browse the <Link href="/dashboard/shop" className="underline text-brand-600 dark:text-brand-400">Shop</Link> in the meantime.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {generators.map((g) => (
            <Link key={g.key} href={`/dashboard/configurator/${g.key}`} className="group block">
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="p-5">
                  <h2 className="font-semibold dark:text-gray-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
                    {g.name}
                  </h2>
                  {g.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1.5 line-clamp-3">{g.description}</p>
                  )}
                  <span className="inline-flex items-center gap-1 text-sm text-brand-600 dark:text-brand-400 mt-3">
                    Customise <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
