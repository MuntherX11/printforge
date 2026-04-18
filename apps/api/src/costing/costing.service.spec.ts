import { Test } from '@nestjs/testing';
import { CostingService } from './costing.service';
import { PrismaService } from '../common/prisma/prisma.service';

describe('CostingService', () => {
  let service: CostingService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      systemSetting: {
        findUnique: jest.fn(({ where }: any) => {
          const defaults: Record<string, string> = {
            overhead_percent: '15',
            purge_waste_grams: '5',
            electricity_rate_kwh: '0.025',
            machine_hourly_rate: '0.400',
            markup_multiplier: '2.5',
          };
          return Promise.resolve(
            defaults[where.key] ? { key: where.key, value: defaults[where.key] } : null,
          );
        }),
      },
      material: { findUnique: jest.fn(), findMany: jest.fn() },
      printer: { findUnique: jest.fn() },
    };

    const module = await Test.createTestingModule({
      providers: [
        CostingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(CostingService);
  });

  describe('calculateJobCost', () => {
    it('should calculate basic single-material job cost', async () => {
      const result = await service.calculateJobCost({
        printDuration: 3600, // 1 hour
        colorChanges: 0,
        purgeWasteGrams: 0,
        printer: { hourlyRate: 0.4, wattage: 200 },
        materials: [{ gramsUsed: 100, costPerGram: 0.025 }],
      });

      // Material: 100 * 0.025 = 2.5
      expect(result.materialCost).toBe(2.5);
      // Machine: 1 hr * 0.4 = 0.4
      expect(result.machineCost).toBe(0.4);
      // Electricity: (200/1000) * 1 * 0.025 = 0.005
      expect(result.electricityCost).toBe(0.005);
      // Waste: 0 color changes = 0
      expect(result.wasteCost).toBe(0);
      // Overhead: (2.5 + 0.4 + 0.005 + 0) * 0.15 = 0.43575 → 0.436
      expect(result.overheadCost).toBe(0.436);
      // Total: 2.5 + 0.4 + 0.005 + 0 + 0.436 = 3.341
      expect(result.totalCost).toBe(3.341);
    });

    it('should calculate waste cost for color changes', async () => {
      const result = await service.calculateJobCost({
        printDuration: 0,
        colorChanges: 10,
        purgeWasteGrams: 0,
        printer: null,
        materials: [{ gramsUsed: 50, costPerGram: 0.030 }],
      });

      // Waste: 10 changes * 5g per change * 0.030 avg cost = 1.5
      expect(result.wasteCost).toBe(1.5);
    });

    it('should use purgeVolumeGrams from gcode over settings-based estimate', async () => {
      const result = await service.calculateJobCost({
        printDuration: 0,
        colorChanges: 100, // high color changes — should be ignored
        purgeWasteGrams: 0,
        purgeVolumeGrams: 20, // actual from gcode
        printer: null,
        materials: [{ gramsUsed: 50, costPerGram: 0.020 }],
      });

      // Waste: 20g * 0.020 = 0.4 (NOT 100 * 5 * 0.020)
      expect(result.wasteCost).toBe(0.4);
    });

    it('should use global hourly rate when no printer specified', async () => {
      const result = await service.calculateJobCost({
        printDuration: 7200, // 2 hours
        colorChanges: 0,
        purgeWasteGrams: 0,
        printer: null,
        materials: [],
      });

      // Machine: 2 hrs * 0.400 (global default) = 0.8
      expect(result.machineCost).toBe(0.8);
    });

    it('should handle zero materials gracefully', async () => {
      const result = await service.calculateJobCost({
        printDuration: 3600,
        colorChanges: 0,
        purgeWasteGrams: 0,
        printer: null,
        materials: [],
      });

      expect(result.materialCost).toBe(0);
      expect(result.wasteCost).toBe(0);
      expect(result.totalCost).toBeGreaterThan(0); // still has machine + electricity cost
    });

    it('should calculate multi-material job cost correctly', async () => {
      const result = await service.calculateJobCost({
        printDuration: 0,
        colorChanges: 0,
        purgeWasteGrams: 0,
        printer: null,
        materials: [
          { gramsUsed: 50, costPerGram: 0.025 },
          { gramsUsed: 30, costPerGram: 0.040 },
        ],
      });

      // Material: (50 * 0.025) + (30 * 0.040) = 1.25 + 1.2 = 2.45
      expect(result.materialCost).toBe(2.45);
    });
  });

  describe('hexToLuminance (via calculateTransitionPurge)', () => {
    it('should calculate black as low luminance', () => {
      // Access private method via bracket notation
      const lum = (service as any).hexToLuminance('#000000');
      expect(lum).toBe(0);
    });

    it('should calculate white as high luminance', () => {
      const lum = (service as any).hexToLuminance('#FFFFFF');
      expect(lum).toBeCloseTo(1, 2);
    });

    it('should handle hex without hash', () => {
      const lum = (service as any).hexToLuminance('FF0000');
      expect(lum).toBeCloseTo(0.2126, 3);
    });

    it('should return 0.5 for invalid hex', () => {
      const lum = (service as any).hexToLuminance('xyz');
      expect(lum).toBe(0.5);
    });
  });

  describe('calculateTransitionPurge', () => {
    it('should increase purge for dark-to-light transitions', () => {
      const base = 5;
      const purge = (service as any).calculateTransitionPurge('#000000', '#FFFFFF', base);
      // dark→light = higher multiplier (up to 2.5x)
      expect(purge).toBeGreaterThan(base);
      expect(purge).toBeLessThanOrEqual(base * 2.5);
    });

    it('should decrease purge for light-to-dark transitions', () => {
      const base = 5;
      const purge = (service as any).calculateTransitionPurge('#FFFFFF', '#000000', base);
      // light→dark = lower multiplier (down to 0.7x)
      expect(purge).toBeLessThan(base);
      expect(purge).toBeGreaterThanOrEqual(base * 0.5);
    });

    it('should use base purge when no hex provided', () => {
      const base = 5;
      const purge = (service as any).calculateTransitionPurge(undefined, undefined, base);
      expect(purge).toBe(base);
    });

    it('should use base purge for same-color transitions', () => {
      const base = 5;
      const purge = (service as any).calculateTransitionPurge('#FF0000', '#FF0000', base);
      expect(purge).toBeCloseTo(base, 1);
    });
  });

  describe('estimatePlates', () => {
    it('should calculate cost for multiple plates and handle multicolor transition average', async () => {
      prisma.material.findUnique.mockResolvedValue({ id: 'mat1', type: 'PLA', costPerGram: 0.025 });
      prisma.material.findMany.mockResolvedValue([
        { type: 'PLA', costPerGram: 0.025 },
        { type: 'PETG', costPerGram: 0.030 },
      ]);
      prisma.printer.findUnique.mockResolvedValue({ id: 'printer1', hourlyRate: 0.5, wattage: 200 });

      const dto = {
        defaultMaterialId: 'mat1',
        printerId: 'printer1',
        plates: [
          {
            plateIndex: 1,
            name: 'Plate 1',
            printSeconds: 3600,
            weightGrams: 100,
            toolChanges: 0,
            tools: [{ filamentGrams: 100, materialType: 'PLA' }],
          },
          {
            plateIndex: 2,
            name: 'Plate 2',
            printSeconds: 3600,
            weightGrams: 50,
            toolChanges: 10,
            // 2 tools: Black (#000000) and White (#FFFFFF)
            tools: [
              { filamentGrams: 25, materialType: 'PLA', colorHex: '#000000' },
              { filamentGrams: 25, materialType: 'PLA', colorHex: '#FFFFFF' },
            ],
          },
        ],
      };

      const result = await service.estimatePlates(dto);

      expect(result.plates).toHaveLength(2);
      // Plate 1: 100g PLA (0.025) + 1hr machine (0.5) + electricity (0.005) + overhead
      // (2.5 + 0.5 + 0.005) * 1.15 = 3.45575 → 3.456
      expect(result.plates[0].breakdown.totalCost).toBeCloseTo(3.456, 2);

      // Plate 2: 50g PLA (0.025) + 1hr machine (0.5) + electricity (0.005) + waste
      // Transition Black→White = purge > 5g, White→Black = purge < 5g.
      expect(result.plates[1].breakdown.wasteCost).toBeGreaterThan(1);
      expect(result.plates[1].isMultiColor).toBe(true);

      // Check cache: findUnique for overhead_percent should only be called once despite 2 plates
      const overheadCalls = prisma.systemSetting.findUnique.mock.calls.filter(
        (c: any) => c[0].where.key === 'overhead_percent'
      );
      expect(overheadCalls.length).toBe(1);
    });
  });
});
