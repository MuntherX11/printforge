import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { CostingService } from './costing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { MultiColorEstimateInput, EstimatePlatesDto } from '@printforge/types';

@Controller('costing')
@UseGuards(JwtAuthGuard, StaffGuard)
export class CostingController {
  constructor(private costingService: CostingService) {}

  @Post('estimate')
  estimate(@Body() body: {
    gramsUsed: number;
    printMinutes: number;
    materialId: string;
    printerId?: string;
    colorChanges?: number;
  }) {
    return this.costingService.estimateFromParams(body);
  }

  /**
   * Multi-color cost estimate with per-color breakdowns and
   * luminance-aware purge waste per color transition.
   */
  @Post('estimate-multicolor')
  estimateMultiColor(@Body() body: MultiColorEstimateInput) {
    return this.costingService.estimateMultiColor(body);
  }

  /**
   * Estimate cost for one or more 3MF plates.
   * Each plate is costed independently; multicolor plates auto-resolve
   * material cost by materialType, falling back to defaultMaterialId.
   */
  @Post('estimate-plates')
  estimatePlates(@Body() body: EstimatePlatesDto) {
    return this.costingService.estimatePlates(body);
  }
}
