'use client';

import { useCallback, useMemo, useState } from 'react';
import { notFound, useParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { useFormatCurrency } from '@/lib/locale-context';
import type { ProductDetail } from '@/lib/types/api';
import { useProduct, type ProductPageData } from './useProduct';
import { ProductHeader } from './ProductHeader';
import { ProductTabsLayout } from './ProductTabsLayout';
import { ProductFoldedLayout } from './ProductFoldedLayout';
import { useBomScope } from './useBomScope';
import { useProductLayout } from './useProductLayout';
import { useReadiness } from './useReadiness';
import { useBulkTiers } from './useBulkTiers';
import { usePartSlices } from './usePartSlices';
import { PricingWarnings } from './PricingCard';
import { usePrinterNames, type ProductLayoutProps } from './layout-props';
import { headerFacts, platePrinterLookup, pricingNeedsAttention } from './product-layout';
import { NewJobDialog, type NewJobPrefill } from './NewJobDialog';
import { defaultPair, pickerOptionsFromDetail } from '@/components/products/OptionPickers';

/**
 * Product detail page: a composition only. The header (name, the one-line
 * price facts, the layout switch, New job / Edit / More) sits above one of
 * two layouts of the same sections, chosen per user (useProductLayout):
 *
 *   TABS    ProductTabsLayout    Overview | Parts and plates | Sizes and colours | Pricing | Photos
 *   FOLDED  ProductFoldedLayout  one column of rows that fold away and show a summary
 *
 * The sections are bodies without card chrome: MakeItBody (ReadinessCard.tsx),
 * PartsBody (ComponentsCard.tsx, id="bill-of-materials"), OptionsBody,
 * PricingBody, BulkPricingBody, HardwareBody (ProductPartsCard.tsx) and
 * PhotosBody. They take `data` (or the fields they need) and call
 * data.reload() / data.reloadCost() after writes.
 *
 * State that must outlive a tab change or a folded row lives here: the BOM
 * scope (useBomScope; a size's Configure sets it), the readiness check
 * (useReadiness), the bulk pricing drafts (useBulkTiers), "Show costs per
 * plate" and the New job dialog, which is opened by the header's `New job`
 * and by Make it's `Create job`.
 *
 * So does everything that must be seen or happen whatever is open: the
 * pricing warnings (PricingWarnings, above the layout) and the page's one
 * `slice-run` subscription (usePartSlices), which reloads the product and
 * its cost when a slice finishes or fails.
 */
export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const data = useProduct(params.id);
  const { product } = data;

  if (data.status === 'notFound') notFound();
  if (data.status === 'loading') return <Loading />;
  if (!product) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t load the product: {data.error ?? 'unknown error'}.</p>
          <Button variant="outline" onClick={() => void data.reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return <ProductPage data={data} product={product} />;
}

function ProductPage({ data, product }: { data: ProductPageData; product: ProductDetail }) {
  const formatCurrency = useFormatCurrency();
  const { layout, setLayout } = useProductLayout();
  const scope = useBomScope(product);
  const readiness = useReadiness(product, data.costVersion);
  const bulk = useBulkTiers(product);
  const { reloadCost } = data;
  const slices = usePartSlices(product.id, useCallback(() => void reloadCost(), [reloadCost]));
  const printers = usePrinterNames(product, data.loadPrinters);
  const [newJob, setNewJob] = useState<NewJobPrefill | null>(null);
  const [showPlateCosts, setShowPlateCosts] = useState(false);

  const facts = headerFacts(product, data.cost, data.standardCost, formatCurrency);
  const printerOf = useMemo(() => platePrinterLookup(product, printers), [product, printers]);

  const pricingAttention = pricingNeedsAttention(data.cost, data.standardCost, data.costError);

  const layoutProps: ProductLayoutProps = {
    data, product, scope, readiness, facts, printers, printerOf,
    showPlateCosts, onShowPlateCosts: setShowPlateCosts, onCreateJob: setNewJob,
    slices, bulk, pricingAttention,
  };

  return (
    <>
      <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:p-5">
        <ProductHeader
          product={product}
          coverUrl={data.images?.[0]?.url ?? product.coverImageUrl}
          photoCount={data.images?.length ?? null}
          facts={facts}
          canEdit={data.canEdit}
          isAdmin={data.isAdmin}
          layout={layout}
          onLayout={setLayout}
          onChanged={() => void data.reload()}
          onNewJob={() => setNewJob({ ...defaultPair(pickerOptionsFromDetail(product)), quantity: 1 })}
        />
        {/* Above both layouts: seen whichever tab or folded row is open. Draws nothing without a warning. */}
        <PricingWarnings product={product} cost={data.cost} standardCost={data.standardCost} costError={data.costError}
          canEdit={data.canEdit} onChanged={data.reloadCost} />
        {layout === 'FOLDED' ? <ProductFoldedLayout {...layoutProps} /> : <ProductTabsLayout {...layoutProps} />}
      </div>

      {data.canEdit && (
        <NewJobDialog product={product} prefill={newJob} loadPrinters={data.loadPrinters} onClose={() => setNewJob(null)} />
      )}
    </>
  );
}
