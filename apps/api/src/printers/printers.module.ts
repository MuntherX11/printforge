import { Module } from '@nestjs/common';
import { PrintersController } from './printers.controller';
import { PrintersService } from './printers.service';
import { MaintenanceService } from './maintenance.service';

@Module({
  controllers: [PrintersController],
  providers: [PrintersService, MaintenanceService],
  exports: [PrintersService, MaintenanceService],
})
export class PrintersModule {}
