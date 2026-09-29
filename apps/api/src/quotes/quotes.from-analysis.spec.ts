import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CUSTOMER_ID, allKeys, ordersHarness, setTaxRate, type OrdersHarness } from '../orders/__fixtures__/orders-harness';
import { QuotesController } from './quotes.controller';

/**
 * POST /quotes/from-analysis (the staff Quick Quote's "Save as quote") used to
 * store its body as sent: an unbounded price, any source, and the analysis and
 * cost estimate as arbitrary JSON, gcodeMetadata going back to the customer.
 */

/** What quick-quote/FileQuotePanel.tsx sends for a G-code file: the file-parser result as returned. */
const gcodeBody = (price = 4.25) => ({
  customerId: CUSTOMER_ID,
  description: 'bracket.gcode',
  analysis: {
    type: 'gcode', slicer: 'OrcaSlicer', estimatedTimeSeconds: 3600, filamentUsedMm: 14000, filamentUsedGrams: 42.5,
    layerHeight: 0.2, layerCount: 120, nozzleTemp: 220, bedTemp: 60, filamentType: 'PLA', totalFilamentChanges: 3, toolCount: 2,
    tools: [{ index: 0, filamentGrams: 30 }, { index: 1, filamentGrams: 12.5 }], filamentColors: ['#000000', '#FFFFFF'],
    objectCount: 4, objectModels: [{ model: 'bracket', count: 4 }], objectLabelSource: 'EXCLUDE_OBJECT', ignoredLabels: [],
  },
  costEstimate: {
    materialCost: 1, machineCost: 0.5, electricityCost: 0.1, wasteCost: 0.05, overheadCost: 0.25, totalCost: 1.9,
    suggestedPrice: price, markupMultiplier: 2.5,
  },
  source: 'QUICK_QUOTE',
});

/** ...and for an STL file. */
const stlBody = () => ({
  customerId: CUSTOMER_ID,
  description: 'clip.stl',
  analysis: { type: 'stl', triangleCount: 1200, volumeCm3: 8.5, surfaceAreaCm2: 40, boundingBox: { x: 20, y: 10, z: 5 }, estimatedGrams: 10.5, estimatedMinutes: 45 },
  costEstimate: { materialCost: 0.5, machineCost: 0.2, electricityCost: 0.05, wasteCost: 0, overheadCost: 0.1, totalCost: 0.85, suggestedPrice: 2.125, markupMultiplier: 2.5 },
  source: 'QUICK_QUOTE',
});

async function badRequestOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).message;
}

const itemsOf = (h: OrdersHarness, id: string) => h.db.t('quoteItem').filter((i: any) => i.quoteId === id);

describe('POST /quotes/from-analysis', () => {
  it.each<[string, Record<string, unknown>]>([
    ['status', { status: 'ACCEPTED' }],
    ['items', { items: { create: [{ description: 'free', quantity: 1, unitPrice: 0, totalPrice: 0 }] } }],
    ['total', { total: 0 }],
    ['validUntil', { validUntil: '2099-01-01' }],
    ['createdById', { createdById: 'someone-else' }],
  ])('%s → 400 and no quote', async (_label, extra) => {
    const h = ordersHarness();
    expect(await badRequestOf(h.quotes.createFromAnalysis({ ...gcodeBody(), ...extra }))).toBe(`property ${Object.keys(extra)[0]} should not exist`);
    expect(h.db.t('quote')).toHaveLength(0);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a negative price', { costEstimate: { suggestedPrice: -5 } }, '"costEstimate.suggestedPrice" must be between 0 and 1000000'],
    ['an Infinity price', { costEstimate: { suggestedPrice: Infinity } }, '"costEstimate.suggestedPrice" must be a number'],
    ['an absurd price', { costEstimate: { suggestedPrice: 1e12 } }, '"costEstimate.suggestedPrice" must be between 0 and 1000000'],
    ['no cost estimate', { costEstimate: undefined }, '"costEstimate" is required'],
    ['a negative cost', { costEstimate: { suggestedPrice: 3, totalCost: -1 } }, '"costEstimate.totalCost" must be between 0 and 1000000'],
    ['the CUSTOMER source', { source: 'CUSTOMER' }, '"source" must be one of: QUICK_QUOTE, MANUAL, LINK, DESIGN'],
    ['an unknown source', { source: 'HACKED' }, '"source" must be one of: QUICK_QUOTE, MANUAL, LINK, DESIGN'],
    ['no description', { description: '  ' }, 'description is required'],
    ['no customer', { customerId: undefined }, 'customerId is required'],
    ['absurd grams', { analysis: { type: 'gcode', slicer: 'Orca', filamentUsedGrams: 1e9 } }, '"analysis.filamentUsedGrams" must be between 0 and 100000'],
    ['a text analysis', { analysis: 'lots' }, '"analysis" must be an object'],
    ['notes that are not text', { notes: { a: 1 } }, '"notes" must be text'],
  ])('%s → 400 and no quote', async (_label, patch, message) => {
    const h = ordersHarness();
    expect(await badRequestOf(h.quotes.createFromAnalysis({ ...gcodeBody(), ...patch }))).toBe(message);
    expect(h.db.t('quote')).toHaveLength(0);
  });

  it('an unknown customer → 404 and no quote', async () => {
    const h = ordersHarness();
    await expect(h.quotes.createFromAnalysis({ ...gcodeBody(), customerId: 'cust-nope' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.db.t('quote')).toHaveLength(0);
  });

  it('the G-code save still works: price, tax, line estimates, and only the parser and estimate fields are kept', async () => {
    const h = ordersHarness();
    setTaxRate(h, '5');
    const body: any = gcodeBody(4.25);
    body.analysis.injected = 'x'.repeat(10_000);
    body.costEstimate.secretMargin = 99;
    const q: any = await h.quotes.createFromAnalysis(body, 'user-1');
    // status is left to the column default (DRAFT), as before.
    expect(q).toMatchObject({ source: 'QUICK_QUOTE', subtotal: 4.25, tax: 0.213, total: 4.463, createdById: 'user-1', notes: null });
    expect(q.customer).toMatchObject({ id: CUSTOMER_ID, name: 'Ali' });
    expect(itemsOf(h, q.id)).toEqual([expect.objectContaining({
      description: 'bracket.gcode', quantity: 1, unitPrice: 4.25, totalPrice: 4.25,
      estimatedGrams: 42.5, estimatedMinutes: 60, estimatedColors: 2, estimatedCost: 1.9,
    })]);
    const row = h.db.t('quote').find((r: any) => r.id === q.id);
    expect(row.gcodeMetadata).toEqual({
      type: 'gcode', slicer: 'OrcaSlicer', estimatedTimeSeconds: 3600, filamentUsedMm: 14000, filamentUsedGrams: 42.5, layerHeight: 0.2,
      layerCount: 120, nozzleTemp: 220, bedTemp: 60, totalFilamentChanges: 3, toolCount: 2, objectCount: 4, filamentType: 'PLA',
    });
    expect(row.stlMetadata).toBeUndefined();
    expect(row.costBreakdown).toEqual({
      suggestedPrice: 4.25, materialCost: 1, machineCost: 0.5, electricityCost: 0.1, wasteCost: 0.05, overheadCost: 0.25, totalCost: 1.9, markupMultiplier: 2.5,
    });
    // What the customer sees of it carries none of the dropped keys.
    const mine: any = await h.quotes.findForCustomer(CUSTOMER_ID, { page: 1, limit: 20 } as any);
    expect(allKeys(mine).has('injected')).toBe(false);
    expect(allKeys(mine).has('secretMargin')).toBe(false);
  });

  it('the STL save still works and keeps the STL metadata', async () => {
    const h = ordersHarness();
    const q: any = await h.quotes.createFromAnalysis(stlBody());
    expect(q).toMatchObject({ subtotal: 2.125, total: 2.125 });
    expect(itemsOf(h, q.id)[0]).toMatchObject({ estimatedGrams: 10.5, estimatedMinutes: 45, estimatedColors: null, estimatedCost: 0.85 });
    const row = h.db.t('quote').find((r: any) => r.id === q.id);
    expect(row.stlMetadata).toEqual({
      type: 'stl', triangleCount: 1200, volumeCm3: 8.5, surfaceAreaCm2: 40, estimatedGrams: 10.5, estimatedMinutes: 45, boundingBox: { x: 20, y: 10, z: 5 },
    });
    expect(row.gcodeMetadata).toBeUndefined();
  });

  it('stays ADMIN/OPERATOR', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, QuotesController.prototype.createFromAnalysis)).toEqual([StaffGuard, RolesGuard]);
    expect(reflector.get(ROLES_KEY, QuotesController.prototype.createFromAnalysis)).toEqual(['ADMIN', 'OPERATOR']);
  });
});
