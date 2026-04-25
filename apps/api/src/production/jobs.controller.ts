import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobMaterialsService } from './job-materials.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CreateProductionJobDto, UpdateProductionJobDto, AddJobMaterialDto, FailJobDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(
    private jobsService: JobsService,
    private jobMaterialsService: JobMaterialsService,
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateProductionJobDto) {
    return this.jobsService.create(dto);
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

  @Get(':id')
  @UseGuards(StaffGuard)
  findOne(@Param('id') id: string) {
    return this.jobsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateProductionJobDto) {
    return this.jobsService.update(id, dto);
  }

  @Post(':id/materials')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  addMaterial(@Param('id') id: string, @Body() dto: AddJobMaterialDto) {
    return this.jobMaterialsService.addMaterial(id, dto);
  }

  @Post(':id/calculate-cost')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  calculateCost(@Param('id') id: string) {
    return this.jobsService.calculateCost(id);
  }

  @Get('plan/:orderId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  previewPlan(@Param('orderId') orderId: string) {
    return this.jobsService.previewPlan(orderId);
  }

  @Post('plan/:orderId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  createFromPlan(
    @Param('orderId') orderId: string,
    @Body() body: { overrides?: Array<{ componentId: string; toProduce: number; printerId?: string; spoolId?: string }> },
  ) {
    return this.jobsService.createFromPlan(orderId, body.overrides);
  }

  @Post(':id/complete')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  completeJob(@Param('id') id: string) {
    return this.jobsService.completeJob(id);
  }

  @Post(':id/fail')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  failJob(@Param('id') id: string, @Body() dto: FailJobDto) {
    return this.jobsService.failJob(id, dto);
  }

  @Post(':id/reprint')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  reprintJob(@Param('id') id: string) {
    return this.jobsService.reprintJob(id);
  }
}
