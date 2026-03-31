import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  CostBreakdown,
  MultiColorCostBreakdown,
  MultiColorEstimateInput,
  ColorCostDetail,
  PurgeTransition,
} from '@printforge/types';

@Injectable()
export class CostingService {
  constructor(private prisma: PrismaService) {}

  private async getSetting(key: string, defaultValue: string): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    return setting?.value ?? defaultValue;
  }

  /**
   * Calculate luminance from hex color (0 = black, 1 = white).
   * Used to estimate purge waste — dark→light transitions need more purging.
   */
  private hexToLuminance(hex: string): number {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return 0.5; // default mid-gray
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    // Relative luminance per sRGB
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Calculate purge waste grams for a color transition.
   * Dark-to-light transitions need more purging than light-to-dark.
   * Base: purge_waste_grams setting. Multiplier: 1x–2.5x based on luminance jump.
   */
  private calculateTransitionPurge(
    fromHex: string | undefined,
    toHex: string | undefined,
    basePurgeGrams: number,
  ): number {
    if (!fromHex || !toHex) return basePurgeGrams;
    const fromLum = this.hexToLuminance(fromHex);
    const toLum = this.hexToLuminance(toHex);
    const lumDiff = toLum - fromLum;
    // dark→light (positive diff) = more purge (up to 2.5x)
    // light→dark (negative diff) = less purge (down to 0.7x)
    const multiplier = lumDiff > 0
      ? 1 + lumDiff * 1.5   // max: 1 + 1*1.5 = 2.5x
      : 1 + lumDiff * 0.3;  // min: 1 + (-1)*0.3 = 0.7x
    return basePurgeGrams * Math.max(0.5, multiplier);
  }

  async calculateJobCost(job: {
    printDuration?: number | null;
    colorChanges: number;
    purgeWasteGrams: number;
    printer?: { hourlyRate: number; wattage?: number } | null;
    materials: Array<{ gramsUsed: number; costPerGram: number }>;
  }): Promise<CostBreakdown> {
    const overheadPercent = parseFloat(await this.getSetting('overhead_percent', '15'));
    const purgeWastePerChange = parseFloat(await this.getSetting('purge_waste_grams', '5'));
    // Oman electricity rate in OMR per kWh (default 0.025 OMR — residential slab 1)
    const electricityRate = parseFloat(await this.getSetting('electricity_rate_kwh', '0.025'));

    // Material cost: sum of all job materials
    const materialCost = job.materials.reduce(
      (sum, m) => sum + m.gramsUsed * m.costPerGram, 0,
    );

    // Machine cost: hourly rate * hours (wear & depreciation)
    const hours = (job.printDuration || 0) / 3600;
    const hourlyRate = job.printer?.hourlyRate || 0;
    const machineCost = hours * hourlyRate;

    // Electricity cost: (wattage / 1000) * hours * rate per kWh
    const wattage = job.printer?.wattage || 200; // default 200W for FDM
    const electricityCost = (wattage / 1000) * hours * electricityRate;

    // Waste cost (multi-color purge)
    const purgeGrams = job.colorChanges * purgeWastePerChange;
    const avgCostPerGram = job.materials.length > 0
      ? job.materials.reduce((sum, m) => sum + m.costPerGram, 0) / job.materials.length
      : 0;
    const wasteCost = purgeGrams * avgCostPerGram;

    // Overhead
    const overheadCost = (materialCost + machineCost + electricityCost + wasteCost) * (overheadPercent / 100);

    // Total
    const totalCost = materialCost + machineCost + electricityCost + wasteCost + overheadCost;

    return {
      materialCost: Math.round(materialCost * 1000) / 1000,
      machineCost: Math.round(machineCost * 1000) / 1000,
      electricityCost: Math.round(electricityCost * 1000) / 1000,
      wasteCost: Math.round(wasteCost * 1000) / 1000,
      overheadCost: Math.round(overheadCost * 1000) / 1000,
      totalCost: Math.round(totalCost * 1000) / 1000,
    };
  }

  async estimateFromParams(params: {
    gramsUsed: number;
    printMinutes: number;
    materialId: string;
    printerId?: string;
    colorChanges?: number;
  }): Promise<CostBreakdown & { suggestedPrice: number; marginPercent: number }> {
    const material = await this.prisma.material.findUnique({ where: { id: params.materialId } });
    const printer = params.printerId
      ? await this.prisma.printer.findUnique({ where: { id: params.printerId } })
      : null;

    const defaultMargin = parseFloat(await this.getSetting('default_margin_percent', '40'));

    const breakdown = await this.calculateJobCost({
      printDuration: params.printMinutes * 60,
      colorChanges: params.colorChanges || 0,
      purgeWasteGrams: 0,
      printer: printer ? { hourlyRate: printer.hourlyRate, wattage: printer.wattage } : null,
      materials: material
        ? [{ gramsUsed: params.gramsUsed, costPerGram: material.costPerGram }]
        : [],
    });

    const suggestedPrice = breakdown.totalCost * (1 + defaultMargin / 100);

    return {
      ...breakdown,
      suggestedPrice: Math.round(suggestedPrice * 1000) / 1000,
      marginPercent: defaultMargin,
    };
  }

  /**
   * Multi-color cost estimate with per-color breakdowns and
   * luminance-aware purge waste per transition.
   */
  async estimateMultiColor(input: MultiColorEstimateInput): Promise<MultiColorCostBreakdown> {
    const overheadPercent = parseFloat(await this.getSetting('overhead_percent', '15'));
    const defaultMargin = parseFloat(await this.getSetting('default_margin_percent', '40'));
    const basePurgeGrams = parseFloat(await this.getSetting('purge_waste_grams', '5'));

    // Fetch all materials in one query
    const materialIds = [...new Set(input.colors.map(c => c.materialId))];
    const materials = await this.prisma.material.findMany({
      where: { id: { in: materialIds } },
    });
    const materialMap = new Map(materials.map(m => [m.id, m]));

    // Fetch printer
    const printer = input.printerId
      ? await this.prisma.printer.findUnique({ where: { id: input.printerId } })
      : null;

    // Per-color cost details
    const colorDetails: ColorCostDetail[] = input.colors
      .sort((a, b) => a.colorIndex - b.colorIndex)
      .map(c => {
        const mat = materialMap.get(c.materialId);
        const costPerGram = mat?.costPerGram || 0;
        return {
          colorIndex: c.colorIndex,
          materialId: c.materialId,
          materialName: mat?.name || 'Unknown',
          colorName: c.colorName || mat?.color || `Color ${c.colorIndex}`,
          gramsUsed: c.gramsUsed,
          costPerGram,
          materialCost: Math.round(c.gramsUsed * costPerGram * 1000) / 1000,
        };
      });

    const materialCost = colorDetails.reduce((sum, d) => sum + d.materialCost, 0);

    // Purge transitions — calculate per color-change pair
    const purgeTransitions: PurgeTransition[] = [];
    const sorted = [...input.colors].sort((a, b) => a.colorIndex - b.colorIndex);
    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i];
      const to = sorted[i + 1];
      const purgeGrams = this.calculateTransitionPurge(
        from.colorHex, to.colorHex, basePurgeGrams,
      );
      // Purge cost uses the "to" color's material (that's what gets wasted in the nozzle)
      const toMat = materialMap.get(to.materialId);
      const purgeCost = purgeGrams * (toMat?.costPerGram || 0);
      purgeTransitions.push({
        fromColorIndex: from.colorIndex,
        toColorIndex: to.colorIndex,
        purgeGrams: Math.round(purgeGrams * 100) / 100,
        purgeCost: Math.round(purgeCost * 1000) / 1000,
      });
    }

    const totalPurgeGrams = purgeTransitions.reduce((sum, t) => sum + t.purgeGrams, 0);
    const wasteCost = purgeTransitions.reduce((sum, t) => sum + t.purgeCost, 0);

    // Machine cost
    const hours = (input.printMinutes || 0) / 60;
    const machineCost = hours * (printer?.hourlyRate || 0);

    // Electricity cost
    const electricityRate = parseFloat(await this.getSetting('electricity_rate_kwh', '0.025'));
    const wattage = printer?.wattage || 200;
    const electricityCost = (wattage / 1000) * hours * electricityRate;

    // Overhead
    const overheadCost = (materialCost + machineCost + electricityCost + wasteCost) * (overheadPercent / 100);
    const totalCost = materialCost + machineCost + electricityCost + wasteCost + overheadCost;
    const suggestedPrice = totalCost * (1 + defaultMargin / 100);

    return {
      materialCost: Math.round(materialCost * 1000) / 1000,
      machineCost: Math.round(machineCost * 1000) / 1000,
      electricityCost: Math.round(electricityCost * 1000) / 1000,
      wasteCost: Math.round(wasteCost * 1000) / 1000,
      overheadCost: Math.round(overheadCost * 1000) / 1000,
      totalCost: Math.round(totalCost * 1000) / 1000,
      colorDetails,
      purgeTransitions,
      totalPurgeGrams: Math.round(totalPurgeGrams * 100) / 100,
      suggestedPrice: Math.round(suggestedPrice * 1000) / 1000,
      marginPercent: defaultMargin,
    };
  }
}
