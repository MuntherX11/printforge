'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { BulkPricingBody } from './BulkPricingCard';
import { PartsBody } from './ComponentsCard';
import { OptionsBody } from './OptionsCard';
import { PricingBody } from './PricingCard';
import { HardwareBody } from './ProductPartsCard';
import { PhotosBody } from './ProductPhotosCard';
import { MakeItBody } from './ReadinessCard';
import type { ProductLayoutProps } from './layout-props';
import { DEFAULT_TAB, NEEDS_ATTENTION, TABS, hashOfTab, tabAfterKey, tabFromHash, type TabId } from './product-layout';

function currentTab(): TabId {
  return typeof window === 'undefined' ? DEFAULT_TAB : tabFromHash(window.location.hash);
}

/**
 * Layout TABS (mock "A"): Overview | Parts and plates | Sizes and colours |
 * Pricing | Photos. The selected tab is the URL hash (`#pricing`), so a
 * reload or coming back keeps it.
 */
export function ProductTabsLayout({ data, product, scope, readiness, printers, printerOf, showPlateCosts, onShowPlateCosts, onCreateJob, slices, bulk, pricingAttention }: ProductLayoutProps) {
  const [tab, setTab] = useState<TabId>(currentTab);
  const baseId = useId();
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  useEffect(() => {
    const onHash = () => setTab(currentTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = useCallback((next: TabId) => {
    setTab(next);
    // replaceState, not location.hash: no jump to an element, no extra history entry per tab.
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}${hashOfTab(next)}`);
    // On a phone the bar scrolls sideways: keep the chosen tab in view.
    tabRefs.current.get(next)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    const next = tabAfterKey(tab, e.key);
    if (!next) return;
    e.preventDefault();
    select(next);
    tabRefs.current.get(next)?.focus();
  }

  // A size's Configure: go to the parts, then show that size and scroll to it.
  const { onConfigureSize } = scope;
  const configureSize = useCallback((sizeKey: string) => {
    select('parts');
    onConfigureSize(sizeKey);
  }, [select, onConfigureSize]);

  const reloadCost = () => void data.reloadCost();
  const onParts = tab === 'overview' || tab === 'parts';

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Product sections" onKeyDown={onKeyDown}
        className="-mx-4 flex gap-6 overflow-x-auto overflow-y-hidden border-b border-gray-200 px-4 [scrollbar-width:none] dark:border-gray-700 sm:-mx-5 sm:px-5 [&::-webkit-scrollbar]:hidden">
        {TABS.map(t => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={el => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id); }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(t.id)}
              className={cn(
                'min-h-[40px] whitespace-nowrap border-b-2 px-0.5 pb-2 pt-1 text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                selected
                  ? 'border-brand-600 font-semibold text-gray-900 dark:border-brand-400 dark:text-gray-100'
                  : 'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100',
              )}
            >
              {t.label}
              {/* In words, not colour alone: a pricing warning is showing above, and unsaved tiers wait here. */}
              {t.id === 'pricing' && pricingAttention && <span className="ml-1.5 text-xs font-medium text-red-700 dark:text-red-400">({NEEDS_ATTENTION})</span>}
              {t.id === 'pricing' && bulk.dirty && data.canEdit && <span className="ml-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">(unsaved changes)</span>}
            </button>
          );
        })}
      </div>

      {/* Every section keeps its own slot, so Parts keeps its state between Overview and Parts and plates. */}
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`} tabIndex={0}
        className="space-y-7 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-4 dark:focus-visible:ring-offset-gray-900">
        {tab === 'overview' && (
          <MakeItBody title="Make it" product={product} readiness={readiness} canEdit={data.canEdit} printerOf={printerOf} onCreateJob={onCreateJob} />
        )}
        {onParts && (
          <PartsBody
            title={tab === 'overview' ? 'Parts' : 'Parts and plates'}
            variant={tab === 'overview' ? 'overview' : 'full'}
            data={data}
            product={product}
            scope={scope.bomScope}
            onScopeChange={scope.setBomScope}
            printers={printers}
            showCosts={showPlateCosts}
            onShowCosts={onShowPlateCosts}
            slices={slices}
          />
        )}
        {tab === 'parts' && <HardwareBody title="Hardware" productId={product.id} canEdit={data.canEdit} onChanged={reloadCost} />}
        {tab === 'options' && <OptionsBody title="Sizes and colours" data={data} product={product} onConfigureSize={configureSize} />}
        {tab === 'pricing' && (
          <PricingBody
            title="Pricing"
            product={product}
            cost={data.cost}
            standardCost={data.standardCost}
            costError={data.costError}
            canEdit={data.canEdit}
            loadPrinters={data.loadPrinters}
            onChanged={data.reloadCost}
          />
        )}
        {tab === 'pricing' && (
          <BulkPricingBody title="Bulk pricing" product={product} tiers={bulk} costVersion={data.costVersion} canEdit={data.canEdit} onSaved={reloadCost} />
        )}
        {tab === 'photos' && (
          <PhotosBody title="Photos" productId={product.id} images={data.images} loadError={data.imagesError} canEdit={data.canEdit} onChanged={data.reloadImages} />
        )}
      </div>
    </div>
  );
}
