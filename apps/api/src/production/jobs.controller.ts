import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobMaterialsService } from './job-materials.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AddJobMaterialDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

/**
 * Production jobs (spec §4.4 J1–J9). Every body is `unknown` and parsed by an
 * explicit allowlist in the service (production/job-input.ts).
 */
@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(
    private jobsService: JobsService,
    private jobMaterialsService: JobMaterialsService,
  ) {}

  /** J1 */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() body: unknown) {
    return this.jobsService.create(body);
  }

  /** J2 */
  @Post('preview')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  preview(@Body() body: unknown) {
    return this.jobsService.preview(body);
  }

  @Get()
  @UseGuards(StaffGuard)
  findAll(@Query() query: PaginationDto, @Query('status') status?: string) {
    return this.jobsService.findAll(query, status);
  }

  @Get('stats/failures')
  @UseGuards(StaffGuard)
  getFailureStats() {
    return this.jobsService.getFailureStats();
  }

  @Get('queue')
  @UseGuards(StaffGuard)
  getQueue() {
    return this.jobsService.getQueue();
  }

  @Post('auto-assign')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  autoAssign() {
    return this.jobsService.autoAssign();
  }

  /** J4 */
  @Get('plan/:orderId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  previewPlan(@Param('orderId') orderId: string) {
    return this.jobsService.previewPlan(orderId);
  }

  /** J5 */
  @Post('plan/:orderId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  createFromPlan(@Param('orderId') orderId: string, @Body() body: unknown, @CurrentUser() user: any) {
    return this.jobsService.createFromPlan(orderId, body, user?.id ?? null);
  }

  /** J3 */
  @Get(':id')
  @UseGuards(StaffGuard)
  findOne(@Param('id') id: string) {
    return this.jobsService.findOne(id);
  }

  /** J8 */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.jobsService.update(id, body);
  }

  @Post(':id/materials')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  addMaterial(@Param('id') id: string, @Body() dto: AddJobMaterialDto) {
    return this.jobMaterialsService.addMaterial(id, dto);
  }

  // Customer changed colour after the file was sliced — swap this line to a
  // different colour of the same material type so the right spool is deducted.
  @Patch('materials/:lineId/colour')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  swapColour(
    @Param('lineId') lineId: string,
    @Body() body: { materialId: string; spoolId?: string },
  ) {
    return this.jobMaterialsService.swapColour(lineId, body ?? ({} as any));
  }

  @Post(':id/calculate-cost')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  calculateCost(@Param('id') id: string) {
    return this.jobsService.calculateCost(id);
  }

  /** J6 */
  @Post(':id/complete')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  completeJob(@Param('id') id: string, @CurrentUser() user: any) {
    return this.jobsService.completeJob(id, user?.id ?? null);
  }

  /** J9 */
  @Post(':id/fail')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  failJob(@Param('id') id: string, @Body() body: unknown) {
    return this.jobsService.failJob(id, body);
  }

  /** J7 */
  @Post(':id/reprint')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  reprintJob(@Param('id') id: string, @Body() body: unknown) {
    return this.jobsService.reprintJob(id, body);
  }
}
