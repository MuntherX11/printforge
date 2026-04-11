import { Controller, Get, Res, UseGuards, Query } from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExportService } from './export.service';

@Controller('export')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'OPERATOR')
@Throttle({ short: { ttl: 60000, limit: 10 } }) // 10 exports per minute
export class ExportController {
  constructor(private exportService: ExportService) {}

  @Get('materials')
  async exportMaterials(@Res() res: Response) {
    const csv = await this.exportService.exportMaterials();
    this.sendCSV(res, csv, 'materials');
  }

  @Get('spools')
  async exportSpools(@Res() res: Response) {
    const csv = await this.exportService.exportSpools();
    this.sendCSV(res, csv, 'spools');
  }

  @Get('products')
  async exportProducts(@Res() res: Response) {
    const csv = await this.exportService.exportProducts();
    this.sendCSV(res, csv, 'products');
  }

  @Get('orders')
  async exportOrders(@Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const csv = await this.exportService.exportOrders(from, to);
    this.sendCSV(res, csv, 'orders');
  }

  @Get('jobs')
  async exportJobs(@Res() res: Response, @Query('from') from?: string, @Query('to') to?: string) {
    const csv = await this.exportService.exportJobs(from, to);
    this.sendCSV(res, csv, 'jobs');
  }

  @Get('customers')
  @Roles('ADMIN')
  async exportCustomers(@Res() res: Response) {
    const csv = await this.exportService.exportCustomers();
    this.sendCSV(res, csv, 'customers');
  }

  private sendCSV(res: Response, csv: string, name: string) {
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="printforge-${name}-${date}.csv"`);
    res.send(csv);
  }
}
