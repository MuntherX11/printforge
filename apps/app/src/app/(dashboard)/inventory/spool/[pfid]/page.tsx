'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { api } from '@/lib/api';
import { formatDate, formatCurrency } from '@/lib/utils';
import Link from 'next/link';

export default function SpoolByPfidPage() {
  const { pfid } = useParams();
  const [spool, setSpool] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get(`/spools/by-pfid/${pfid}`)
      .then((data) => setSpool(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [pfid]);

  if (loading) return <Loading />;
  if (error) return (
    <div className="text-center py-12 text-red-500 dark:text-red-400">{error}</div>
  );
  if (!spool) return (
    <div className="text-center py-12 text-gray-500 dark:text-gray-400">Spool not found</div>
  );

  const usedWeight = spool.initialWeight - spool.currentWeight;
  const usedPercent = spool.initialWeight > 0
    ? Math.round((usedWeight / spool.initialWeight) * 100)
    : 0;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Spool {spool.printforgeId}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {spool.material.name} {spool.material.color ? `- ${spool.material.color}` : ''}
          </p>
        </div>
        <Badge variant={spool.isActive ? 'success' : 'default'}>
          {spool.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      <Card className="dark:bg-gray-800">
        <CardHeader>
          <CardTitle className="dark:text-gray-100">Spool Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">PrintForge ID</p>
              <p className="font-mono font-bold text-gray-900 dark:text-gray-100">{spool.printforgeId}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Material Type</p>
              <p className="text-gray-900 dark:text-gray-100">{spool.material.type}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Color</p>
              <p className="text-gray-900 dark:text-gray-100">{spool.material.color || '-'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Material Name</p>
              <p className="text-gray-900 dark:text-gray-100">{spool.material.name}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="dark:bg-gray-800">
        <CardHeader>
          <CardTitle className="dark:text-gray-100">Weight</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Initial Weight</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{spool.initialWeight}g</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Current Weight</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{Math.round(spool.currentWeight)}g</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Used</p>
              <p className="text-gray-900 dark:text-gray-100">{Math.round(usedWeight)}g ({usedPercent}%)</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Empty Spool Weight</p>
              <p className="text-gray-900 dark:text-gray-100">{spool.spoolWeight}g</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="dark:bg-gray-800">
        <CardHeader>
          <CardTitle className="dark:text-gray-100">Location & Purchase</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Storage Location</p>
              <p className="text-gray-900 dark:text-gray-100">{spool.location?.name || 'Not assigned'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Lot Number</p>
              <p className="text-gray-900 dark:text-gray-100">{spool.lotNumber || '-'}</p>
            </div>
            {spool.purchasePrice != null && (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Purchase Price</p>
                <p className="text-gray-900 dark:text-gray-100">{formatCurrency(spool.purchasePrice)}</p>
              </div>
            )}
            {spool.purchaseDate && (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Purchase Date</p>
                <p className="text-gray-900 dark:text-gray-100">{formatDate(spool.purchaseDate)}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Added</p>
              <p className="text-gray-900 dark:text-gray-100">{formatDate(spool.createdAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {spool.jobMaterials && spool.jobMaterials.length > 0 && (
        <Card className="dark:bg-gray-800">
          <CardHeader>
            <CardTitle className="dark:text-gray-100">Recent Job Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {spool.jobMaterials.map((jm: any) => (
                <div key={jm.id} className="flex items-center justify-between py-1 border-b last:border-b-0 dark:border-gray-700">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{jm.job?.name || 'Unknown Job'}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(jm.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <Badge variant={jm.job?.status === 'COMPLETED' ? 'success' : 'default'}>
                      {jm.job?.status || 'N/A'}
                    </Badge>
                    {jm.gramsUsed > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{jm.gramsUsed}g used</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {spool.material?.id && (
        <div className="pt-2">
          <Link
            href={`/inventory/${spool.material.id}`}
            className="text-sm text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
          >
            &larr; Back to material detail
          </Link>
        </div>
      )}
    </div>
  );
}
