'use client';

import { notFound, useParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { useProduct } from './useProduct';
import { ProductHeader } from './ProductHeader';
import { PricingCard } from './PricingCard';
import { ProductPartsCard } from './ProductPartsCard';
import { ProductPhotosCard } from './ProductPhotosCard';

/**
 * Product detail page (spec §5.1/§5.2): a composition only. Sections, top to
 * bottom:
 *   A  ProductHeader        (WP8)
 *   B  PricingCard          (WP8)
 *   C  OptionsCard          (WP9b — Sizes & colours; adds page state bomScope/setBomScope)
 *   D  ComponentsCard       (WP9  — Bill of materials, id="bill-of-materials"; opens E PlateLayoutsDialog)
 *   F  ReadinessCard        (WP9  — Production readiness; opens G NewJobDialog)
 *   H  BulkPricingCard      (WP9  — Bulk pricing)
 *   I  ProductPartsCard     (WP8)
 *   J  ProductPhotosCard    (WP8)
 * Sections C–H take `data` (ProductPageData from useProduct) and call
 * data.reload() / data.reloadCost() after writes. Until they land they render
 * nothing, and the page calls none of the routes the backend removed.
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
          <p className="text-sm text-red-600 dark:text-red-400">Couldn&apos;t load the product — {data.error ?? 'unknown error'}.</p>
          <Button variant="outline" onClick={() => void data.reload()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <ProductHeader
        product={product}
        coverUrl={data.images?.[0]?.url ?? product.coverImageUrl}
        photoCount={data.images?.length ?? null}
        canEdit={data.canEdit}
        isAdmin={data.isAdmin}
        onChanged={() => void data.reload()}
      />

      <PricingCard
        product={product}
        cost={data.cost}
        standardCost={data.standardCost}
        costError={data.costError}
        canEdit={data.canEdit}
        loadPrinters={data.loadPrinters}
        onChanged={data.reloadCost}
      />

      {/* C. Sizes & colours — <OptionsCard data={data} … /> (WP9b) */}
      {/* D. Bill of materials — <ComponentsCard data={data} scope={bomScope} … /> (WP9) */}
      {/* F. Production readiness — <ReadinessCard data={data} /> (WP9) */}
      {/* H. Bulk pricing — <BulkPricingCard data={data} /> (WP9) */}

      <ProductPartsCard productId={product.id} canEdit={data.canEdit} onChanged={() => void data.reloadCost()} />

      <ProductPhotosCard
        productId={product.id}
        images={data.images}
        loadError={data.imagesError}
        canEdit={data.canEdit}
        onChanged={data.reloadImages}
      />
    </div>
  );
}
