/**
 * The §3.8 worked example: "Box" as a one-component product. PLA Black 0.010/g,
 * 9.4 g, 34 min, ×12 layout (243 min / 112.8 g), printer 200 W / 0.400 h / ×2.5.
 * Optional colour "Red" (Box linked to "Body", Body → PLA Red 0.012/g).
 */
import type { CostSettings } from '../../costing/costing.service';
import { toProductConfig, type ProductConfig } from '../catalog-config';
import { fixtureComponent, fixtureMaterial, M, type FixtureRow } from './sardine-tin';

export const SETTINGS: CostSettings = {
  overheadPercent: 15,
  purgeWasteGrams: 5,
  electricityRateKwh: 0.025,
  machineHourlyRate: 0.4,
  markupMultiplier: 2.5,
  thinMarginPercent: 20,
};

export const BOX_ID = 'p-box';

export function boxRow(opts: { withRed?: boolean; basePrice?: number } = {}): FixtureRow {
  const box = fixtureComponent('box', null, 'Box', 1, 0, 34, [[0, M.black, 9.4, 'slot-body']], [{ id: 'box12', units: 12, minutes: 243, grams: 112.8 }]);
  box.productId = BOX_ID;
  return {
    id: BOX_ID,
    name: 'Box',
    isActive: true,
    basePrice: opts.basePrice ?? 0.93,
    colorChanges: 0,
    baseOptionLabel: null,
    baseOptionSellable: null,
    standardColourLabel: null,
    standardColourSellable: null,
    surplusPolicy: 'KEEP_FOR_STOCK',
    defaultPrinterId: 'pr-1',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    defaultPrinter: { id: 'pr-1', name: 'K1', hourlyRate: 0.4, wattage: 200, markupMultiplier: 2.5 },
    colourSlots: [{ id: 'slot-body', productId: BOX_ID, name: 'Body', sortOrder: 0 }],
    variants: opts.withRed
      ? [{
          id: 'v-box-red', productId: BOX_ID, name: 'Red', sku: null, kind: 'COLOUR', isActive: true, sortOrder: 0, basePrice: null,
          estimatedGrams: null, estimatedMinutes: null, createdAt: new Date(0),
          colourAssignments: [{ colourSlotId: 'slot-body', materialId: M.red, material: fixtureMaterial(M.red) }],
          sizeExclusions: [],
        }]
      : [],
    components: [box],
    parts: [] as any[],
  };
}

export const boxConfig = (opts: { withRed?: boolean; basePrice?: number } = {}, mutate?: (row: FixtureRow) => void): ProductConfig => {
  const row = boxRow(opts);
  mutate?.(row);
  return toProductConfig(row);
};
