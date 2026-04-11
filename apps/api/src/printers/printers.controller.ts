import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { PrintersService } from './printers.service';
import { MaintenanceService } from './maintenance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreatePrinterDto, UpdatePrinterDto, CreateMaintenanceLogDto, CompleteMaintenanceDto } from '@printforge/types';

@Controller('printers')
@UseGuards(JwtAuthGuard)
export class PrintersController {
  constructor(
    private printersService: PrintersService,
    private maintenanceService: MaintenanceService,
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  create(@Body() dto: CreatePrinterDto) {
    return this.printersService.create(dto);
  }

  @Get()
  findAll() {
    return this.printersService.findAll();
  }

  // Static routes before :id
  @Get('maintenance/overdue')
  getOverduePrinters() {
    return this.maintenanceService.getOverduePrinters();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.printersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdatePrinterDto) {
    return this.printersService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.printersService.remove(id);
  }

  // ============ MAINTENANCE ============

  @Post(':id/maintenance')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  startMaintenance(@Param('id') id: string, @Body() dto: CreateMaintenanceLogDto) {
    return this.maintenanceService.startMaintenance(id, dto);
  }

  @Patch(':id/maintenance/:logId/complete')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  completeMaintenance(
    @Param('id') id: string,
    @Param('logId') logId: string,
    @Body() dto: CompleteMaintenanceDto,
  ) {
    return this.maintenanceService.completeMaintenance(id, logId, dto);
  }

  @Get(':id/maintenance')
  getMaintenanceHistory(@Param('id') id: string) {
    return this.maintenanceService.getHistory(id);
  }

  @Patch(':id/maintenance-settings')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  updateMaintenanceSettings(
    @Param('id') id: string,
    @Body() body: { maintenanceIntervalHours: number | null },
  ) {
    return this.maintenanceService.updateMaintenanceSettings(id, body.maintenanceIntervalHours);
  }
}
