import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { OrderPlanJobsResult, OrderPlateDto, OrderPrintPlanDto } from '@printforge/types';
import type { Request, Response } from 'express';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import { pipeline } from 'stream';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { contentDisposition, zipOfFiles } from './order-plate-download';
import { OrderPlateJobsService } from './order-plate-jobs.service';
import { OrderPlatesService } from './order-plates.service';

/**
 * Print files for a whole order (v2.19.0). The plan and its files are readable
 * by every staff role but VIEWER; changing plates, slicing and creating jobs
 * are OPERATOR/ADMIN. Bodies are `unknown`: each is parsed by an allowlist
 * (order-plate-input.ts).
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrderPlatesController {
  constructor(
    private readonly plates: OrderPlatesService,
    private readonly jobs: OrderPlateJobsService,
  ) {}

  @Get('orders/:id/print-plan')
  @Roles('ADMIN', 'OPERATOR', 'ACCOUNTING')
  plan(@Param('id') id: string): Promise<OrderPrintPlanDto> {
    return this.plates.getPlan(id);
  }

  /** "Prepare print files" and "Reset to suggestion". */
  @Post('orders/:id/print-plan/suggest')
  @Roles('ADMIN', 'OPERATOR')
  suggest(@Param('id') id: string, @Body() body: unknown): Promise<OrderPrintPlanDto> {
    return this.plates.suggest(id, body);
  }

  @Post('orders/:id/print-plan/plates')
  @Roles('ADMIN', 'OPERATOR')
  create(@Param('id') id: string, @Body() body: unknown): Promise<OrderPlateDto> {
    return this.plates.createPlate(id, body);
  }

  @Patch('order-plates/:id')
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() body: unknown): Promise<OrderPlateDto> {
    return this.plates.updatePlate(id, body);
  }

  @Delete('order-plates/:id')
  @Roles('ADMIN', 'OPERATOR')
  remove(@Param('id') id: string): Promise<{ deleted: true }> {
    return this.plates.deletePlate(id);
  }

  @Post('orders/:id/print-plan/slice')
  @Roles('ADMIN', 'OPERATOR')
  sliceAll(@Param('id') id: string, @Body() body: unknown): Promise<{ queued: number }> {
    return this.plates.queueAll(id, body);
  }

  @Post('order-plates/:id/slice')
  @Roles('ADMIN', 'OPERATOR')
  sliceOne(@Param('id') id: string, @Body() body: unknown): Promise<OrderPlateDto> {
    return this.plates.queueOne(id, body);
  }

  @Get('order-plates/:id/file')
  @Roles('ADMIN', 'OPERATOR', 'ACCOUNTING')
  async file(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const f = await this.plates.file(id);
    const { size } = await fs.stat(f.abs);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': contentDisposition(f.filename), 'Content-Length': String(size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // pipeline closes the file when the download is given up half-way, and the answer when the file fails.
    pipeline(createReadStream(f.abs), res, () => undefined);
  }

  /**
   * Every plate file of the order in one zip, streamed: a file is opened when
   * its turn comes, and all of it stops when the client goes away. A HEAD (a
   * browser or a proxy asking first) is answered without reading any file.
   */
  @Get('orders/:id/print-plan/files.zip')
  @Roles('ADMIN', 'OPERATOR', 'ACCOUNTING')
  async zip(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { orderNumber, entries } = await this.plates.files(id);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition(`${orderNumber} print files.zip`) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const zip = zipOfFiles(entries);
    res.on('close', () => zip.destroy());
    zip.stream.on('error', () => res.destroy()).pipe(res);
  }

  @Post('orders/:id/print-plan/jobs')
  @Roles('ADMIN', 'OPERATOR')
  createJobs(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: any): Promise<OrderPlanJobsResult> {
    return this.jobs.createJobs(id, body, user?.id ?? null);
  }
}
