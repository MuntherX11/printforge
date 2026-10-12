'use client';

import { useCallback, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useFormatCurrency } from '@/lib/locale-context';
import { cn } from '@/lib/utils';
import { BulkPricingBody } from './BulkPricingCard';
import { PartsBody } from './ComponentsCard';
import { OptionsBody } from './OptionsCard';
import { PricingBody } from './PricingCard';
import { HardwareBody } from './ProductPartsCard';
import { PhotosBody } from './ProductPhotosCard';
import { MakeItBody } from './ReadinessCard';
import { componentsInScope } from './bom-model';
import type { ProductLayoutProps } from './layout-props';
import {
  FOLDED_SECTIONS, bulkSummary, hardwareSummary, optionsSummary, partsSummary, photosSummary, pricingSummary, readFolded, writeFolded,
  type FoldedState, type SectionId,
} from './product-layout';
import { verdictOf } from './readiness-model';

/**
 * Layout FOLDED (mock "B"): one column of rows, each a button with the
 * section's name and a live one-line summary. Which rows are open is
 * remembered on this browser (`pf.productFolded`); Make it and Parts and
 * plates start open.
 */
export function ProductFoldedLayout({ data, product, scope, readiness, facts, printers, printerOf, showPlateCosts, onShowPlateCosts, onCreateJob, slices, bulk, pricingAttention }: ProductLayoutProps) {
  const formatCurrency = useFormatCurrency();
  const [open, setOpen] = useState<FoldedState>(readFolded);
  const baseId = useId();

  const setSection = useCallback((id: SectionId, value: boolean | 'toggle') => {
    setOpen(prev => {
      const next = { ...prev, [id]: value === 'toggle' ? !prev[id] : value };
      writeFolded(next);
      return next;
    });
  }, []);

  // A size's Configure: open the parts, then show that size and scroll to it.
  const { onConfigureSize } = scope;
  const configureSize = useCallback((sizeKey: string) => {
    setSection('parts', true);
    onConfigureSize(sizeKey);
  }, [setSection, onConfigureSize]);

  const reloadCost = () => void data.reloadCost();
  const r = readiness.data;
  const summary: Record<SectionId, string> = {
    make: r ? verdictOf(r).brief : readiness.error ? 'Couldn\'t check' : 'Checking…',
    parts: partsSummary(componentsInScope(product, scope.bomScope)),
    options: optionsSummary(product),
    pricing: pricingSummary(facts, formatCurrency, pricingAttention),
    bulk: bulkSummary(product, bulk.dirty && data.canEdit),
    hardware: hardwareSummary(data.standardCost),
    photos: photosSummary(data.images),
  };

  function body(id: SectionId): React.ReactNode {
    switch (id) {
      case 'make':
        return <MakeItBody product={product} readiness={readiness} canEdit={data.canEdit} printerOf={printerOf} onCreateJob={onCreateJob} />;
      case 'parts':
        return (
          <PartsBody variant="full" data={data} product={product} scope={scope.bomScope} onScopeChange={scope.setBomScope}
            printers={printers} showCosts={showPlateCosts} onShowCosts={onShowPlateCosts} slices={slices} />
        );
      case 'options':
        return <OptionsBody data={data} product={product} onConfigureSize={configureSize} />;
      case 'pricing':
        return (
          <PricingBody product={product} cost={data.cost} standardCost={data.standardCost} costError={data.costError}
            canEdit={data.canEdit} loadPrinters={data.loadPrinters} onChanged={data.reloadCost} />
        );
      case 'bulk':
        return <BulkPricingBody product={product} tiers={bulk} costVersion={data.costVersion} canEdit={data.canEdit} onSaved={reloadCost} />;
      case 'hardware':
        return <HardwareBody productId={product.id} canEdit={data.canEdit} onChanged={reloadCost} />;
      case 'photos':
        return <PhotosBody productId={product.id} images={data.images} loadError={data.imagesError} canEdit={data.canEdit} onChanged={data.reloadImages} />;
    }
  }

  return (
    <div>
      {FOLDED_SECTIONS.map(s => {
        const isOpen = open[s.id];
        const panelId = `${baseId}-${s.id}`;
        return (
          <section key={s.id} aria-labelledby={`${panelId}-h`} className="border-t border-gray-200 dark:border-gray-700">
            <h2 id={`${panelId}-h`}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={() => setSection(s.id, 'toggle')}
                className="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <ChevronRight className={cn('h-4 w-4 flex-shrink-0 text-gray-400 motion-safe:transition-transform', isOpen && 'rotate-90')} aria-hidden="true" />
                <span className="font-semibold text-gray-900 dark:text-gray-100">{s.label}</span>
                <span className="ml-auto min-w-0 break-words text-right text-gray-500 dark:text-gray-400">{summary[s.id]}</span>
              </button>
            </h2>
            {isOpen && <div id={panelId} className="pb-5 sm:pl-7">{body(s.id)}</div>}
          </section>
        );
      })}
    </div>
  );
}
