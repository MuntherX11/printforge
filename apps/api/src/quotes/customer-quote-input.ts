import { BadRequestException } from '@nestjs/common';
import { round3 } from '../catalog-core/cost-engine';
import { optionalNumber, optionalText, requiredNumber } from '../common/utils/validate-number';
import { MAX_LINES } from '../orders/order-lines';
import type { CustomerQuoteRequestDto } from './dto/customer-quote-request.dto';

/**
 * POST /quotes/customer/request, parsed field by field after the class-validator
 * DTO. The DTO only checked types and `>= 0`, so a customer could send any
 * finite or huge price, weight or time. The prices here come from the
 * customer's own estimate call and are NOT trusted: the quote is saved as a
 * DRAFT the shop reviews, and QuotesService.customerAccept refuses a
 * customer-requested quote until staff have sent it (status SENT).
 */

const MONEY = { min: 0, max: 1_000_000 };
const GRAMS = { min: 0, max: 100_000 };
/** About 115 days of printing. */
const SECONDS = { min: 0, max: 10_000_000 };

export interface CustomerQuoteLine {
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  estimatedGrams: number | null;
  estimatedMinutes: number | null;
  estimatedCost: number | null;
}

export interface CustomerQuoteRequestInput {
  items: CustomerQuoteLine[];
  subtotal: number;
  notes: string | null;
  /** The file analysis to keep with the quote (allowlisted keys only), or null. */
  analysis: { fileName: string; fileType: string; slicer: string | null; estimatedTimeSeconds: number | null; filamentUsedGrams: number | null } | null;
}

function text(raw: unknown, field: string, max: number, fallback: string): string {
  return optionalText(raw ?? null, field, max) ?? fallback;
}

export function parseCustomerQuoteRequest(dto: CustomerQuoteRequestDto): CustomerQuoteRequestInput {
  const notes = optionalText(dto?.notes ?? null, 'notes', 2000) ?? null;

  if (Array.isArray(dto?.plates) && dto.plates.length > 0) {
    if (dto.plates.length > MAX_LINES) throw new BadRequestException(`A quote request can have at most ${MAX_LINES} plates`);
    const items = dto.plates.map((plate, i) => {
      const price = round3(requiredNumber(plate?.breakdown?.suggestedPrice, `plates[${i}].breakdown.suggestedPrice`, MONEY));
      return {
        description: text(plate?.name, `plates[${i}].name`, 200, `Plate ${i + 1}`),
        quantity: 1,
        unitPrice: price,
        totalPrice: price,
        estimatedGrams: Math.round(requiredNumber(plate?.weightGrams, `plates[${i}].weightGrams`, GRAMS)),
        estimatedMinutes: Math.round(requiredNumber(plate?.printSeconds, `plates[${i}].printSeconds`, SECONDS) / 60),
        estimatedCost: round3(requiredNumber(plate?.breakdown?.totalCost, `plates[${i}].breakdown.totalCost`, MONEY)),
      };
    });
    return { items, subtotal: round3(items.reduce((s, it) => s + it.totalPrice, 0)), notes, analysis: null };
  }

  if (dto?.analysis && dto?.costEstimate) {
    const a = dto.analysis;
    const analysis = {
      fileName: text(a.fileName, 'analysis.fileName', 255, 'Custom print'),
      fileType: text(a.fileType, 'analysis.fileType', 20, 'unknown'),
      slicer: optionalText(a.slicer ?? null, 'analysis.slicer', 100) ?? null,
      estimatedTimeSeconds: optionalNumber(a.estimatedTimeSeconds, 'analysis.estimatedTimeSeconds', SECONDS) ?? null,
      filamentUsedGrams: optionalNumber(a.filamentUsedGrams, 'analysis.filamentUsedGrams', GRAMS) ?? null,
    };
    const price = round3(requiredNumber(dto.costEstimate.suggestedPrice, 'costEstimate.suggestedPrice', MONEY));
    const cost = round3(requiredNumber(dto.costEstimate.totalCost, 'costEstimate.totalCost', MONEY));
    return {
      items: [{
        description: analysis.fileName,
        quantity: 1,
        unitPrice: price,
        totalPrice: price,
        estimatedGrams: analysis.filamentUsedGrams,
        estimatedMinutes: analysis.estimatedTimeSeconds ? Math.round(analysis.estimatedTimeSeconds / 60) : null,
        estimatedCost: cost,
      }],
      subtotal: price,
      notes,
      analysis,
    };
  }

  throw new BadRequestException('Provide either plates (3MF) or analysis + costEstimate');
}
