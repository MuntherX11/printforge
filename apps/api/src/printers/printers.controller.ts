import { Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, Res, NotFoundException, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import * as http from 'http';
import * as https from 'https';
import { PrintersService } from './printers.service';
import { MaintenanceService } from './maintenance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreatePrinterDto, UpdatePrinterDto, CreateMaintenanceLogDto, CompleteMaintenanceDto } from '@printforge/types';

/** Reusable SSRF guard — only allows private/Tailscale network addresses */
function isLocalUrl(rawUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    if (!['http:', 'https:'].includes(protocol)) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname.startsWith('192.168.')) return true;
    if (hostname.startsWith('10.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (hostname.endsWith('.local')) return true;
    const o = hostname.split('.').map(Number);
    if (o.length === 4 && o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  } catch { return false; }
}

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

  // ============ CAMERA PROXY ============

  /**
   * Proxy the printer's camera stream to the browser.
   * Supports MJPEG (multipart/x-mixed-replace) and plain JPEG snapshot URLs.
   * The URL is validated against the SSRF guard — only LAN / Tailscale addresses allowed.
   */
  @Get(':id/camera/stream')
  async cameraStream(@Param('id') id: string, @Res() res: Response) {
    const printer = await this.printersService.findOne(id);
    if (!printer.cameraUrl) throw new NotFoundException('No camera URL configured for this printer');
    if (!isLocalUrl(printer.cameraUrl)) throw new BadRequestException('Camera URL must be a local/private network address');

    const lib = printer.cameraUrl.startsWith('https') ? https : http;

    const upstream = lib.get(printer.cameraUrl, { timeout: 10000 }, (upstream) => {
      const contentType = upstream.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering for streams
      upstream.pipe(res);
      res.on('close', () => upstream.destroy());
    });

    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'Camera unavailable' });
    });
    upstream.on('timeout', () => {
      upstream.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Camera timed out' });
    });
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
