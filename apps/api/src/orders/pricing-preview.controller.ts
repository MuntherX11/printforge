import { BadRequestException, Body, Controller, HttpException, Post, UseGuards } from '@nestjs/common';
import type { PriceSource } from '@printforge/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { BomResolverService } from '../catalog-core/bom-resolver.service';
import { CatalogRequestContext } from '../catalog-core/catalog-context';
import { pairLabel } from '../catalog-core/option-pair';
import { PricingService, type LineInput, type ResolvedLine } from '../catalog-core/pricing.service';
import { MAX_LINES, parseItemsArray, parseStaffLine } from './order-lines';

/** One S1 line (spec §4.5). Staff only: it carries tiers, costs and margins. */
export interface PricingPreviewLine {
  listUnitPrice: number | null;
  tierMinQty: number | null;
  tierUnitPrice: number | null;
  tierQuantity: number | null;
  tierLineCount: number | null;
  tierSizeLabel: string | null;
  autoUnitPrice: number | null;
  effectiveUnitPrice: number | null;
  priceSource: PriceSource | null;
  unitCostFloor: number | null;
  marginPct: number | null;
  pairLabel: string | null;
  /** warning messages, in the order of warningCodes */
  warnings: string[];
  warningCodes: string[];
  error: string | null;
}

const EMPTY: Omit<PricingPreviewLine, 'error'> = {
  listUnitPrice: null, tierMinQty: null, tierUnitPrice: null, tierQuantity: null, tierLineCount: null, tierSizeLabel: null,
  autoUnitPrice: null, effectiveUnitPrice: null, priceSource: null, unitCostFloor: null, marginPct: null, pairLabel: null,
  warnings: [], warningCodes: [],
};

const LINE_PREFIX = /^Line (\d+): ([\s\S]*)$/;

/**
 * S1: price a whole order or quote as the server will (§3.9 resolveLines, STAFF),
 * so tiers count across its lines. Per-line problems — every validatePair message,
 * a missing price, a bad quantity — come back in `error` instead of failing the
 * request; the remaining lines are priced (and counted for tiers) without them.
 * Takes no locks.
 */
export async function previewPricingLines(pricing: PricingService, resolver: BomResolverService, body: unknown): Promise<{ lines: PricingPreviewLine[] }> {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const raw = parseItemsArray(b.lines, { min: 0, max: MAX_LINES, tooMany: 'Price at most 100 lines at a time' });
  const errors: Array<string | null> = raw.map(() => null);
  const inputs: Array<LineInput | null> = raw.map((it, i) => {
    try {
      const line = parseStaffLine(it, i);
      // A preview of a custom line needs no description yet.
      if (!line.productId && !line.variantId && !String(line.description ?? '').trim()) line.description = 'Custom line';
      return line;
    } catch (e) {
      errors[i] = e instanceof HttpException ? e.message : 'Invalid line';
      return null;
    }
  });

  const ctx = new CatalogRequestContext();
  const active = inputs.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  let resolved: ResolvedLine[] = [];
  for (let guard = 0; guard <= raw.length; guard++) {
    if (!active.length) break;
    try {
      resolved = await pricing.resolveLines(active.map((i) => inputs[i]!), { audience: 'STAFF', ctx });
      break;
    } catch (e) {
      const m = e instanceof BadRequestException ? LINE_PREFIX.exec(e.message) : null;
      const k = m ? Number(m[1]) - 1 : -1;
      if (!m || k < 0 || k >= active.length) throw e;
      errors[active[k]] = m[2];
      active.splice(k, 1);
    }
  }

  const tierCache = new Map<string, Array<{ minQty: number; unitPrice: number }>>();
  const out: PricingPreviewLine[] = raw.map((_, i) => ({ ...EMPTY, error: errors[i] ?? 'Invalid line' }));
  for (let j = 0; j < resolved.length; j++) {
    const r = resolved[j];
    const i = active[j];
    let tierUnitPrice: number | null = null;
    let label: string | null = null;
    if (r.productId) {
      if (r.tierMinQty !== null) {
        const key = `${r.productId}|${r.sizeOptionId ?? ''}`;
        let tiers = tierCache.get(key);
        if (!tiers) {
          tiers = await pricing.tiersFor(r.productId, r.sizeOptionId);
          tierCache.set(key, tiers);
        }
        tierUnitPrice = tiers.find((t) => t.minQty === r.tierMinQty)?.unitPrice ?? null;
      }
      const config = await resolver.loadConfig(r.productId, ctx);
      if (config) {
        const size = r.sizeOptionId ? config.options.find((o) => o.id === r.sizeOptionId) ?? null : null;
        const colour = r.colourOptionId ? config.options.find((o) => o.id === r.colourOptionId) ?? null : null;
        label = pairLabel(config, size, colour);
      }
    }
    const autoUnitPrice = !r.productId ? null : r.priceSource === 'MANUAL' ? tierUnitPrice ?? r.listUnitPrice : r.unitPrice;
    out[i] = {
      listUnitPrice: r.listUnitPrice,
      tierMinQty: r.tierMinQty,
      tierUnitPrice,
      tierQuantity: r.tierQuantity,
      tierLineCount: r.tierLineCount,
      tierSizeLabel: r.productId ? r.tierSizeLabel : null,
      autoUnitPrice,
      effectiveUnitPrice: r.unitPrice,
      priceSource: r.priceSource,
      unitCostFloor: r.floor,
      marginPct: r.floor !== null && r.unitPrice > 0 ? Math.round(((r.unitPrice - r.floor) / r.unitPrice) * 1000) / 10 : null,
      pairLabel: label,
      warnings: r.warnings.map((w) => w.message),
      warningCodes: r.warnings.map((w) => w.code),
      error: null,
    };
  }
  return { lines: out };
}

@Controller('pricing')
@UseGuards(JwtAuthGuard, StaffGuard, RolesGuard)
export class PricingPreviewController {
  constructor(
    private readonly pricing: PricingService,
    private readonly resolver: BomResolverService,
  ) {}

  /** S1 */
  @Post('lines')
  @Roles('ADMIN', 'OPERATOR')
  previewLines(@Body() body: unknown) {
    return previewPricingLines(this.pricing, this.resolver, body);
  }
}
