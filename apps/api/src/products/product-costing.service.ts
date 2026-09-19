import { Injectable, NotFoundException } from '@nestjs/common';
import { PricingService } from '../catalog-core/pricing.service';

/**
 * Thin adapter kept only so the slicer onboarding still compiles (spec §6 WP4
 * "Also"). All costing and pricing lives in catalog-core's PricingService.
 * WP5 deletes this adapter together with `onboardVariantFromGcode`.
 */
@Injectable()
export class ProductCostingService {
  constructor(private readonly pricing: PricingService) {}

  /** Former aggregate recalculation: now the automatic price rule (§3.8). */
  recalculateAggregates(productId: string) {
    return this.pricing.recalcPricing(productId);
  }

  /** A size's cost on its standard colour (used by the legacy variant G-code import only). */
  async calculateVariantCost(productId: string, variantId: string, _fallbackMaterialType?: string) {
    const cost = (await this.pricing.optionCosts(productId)).find((c) => c.sizeOptionId === variantId);
    if (!cost) throw new NotFoundException('Option not found');
    return cost;
  }
}
