import {
  Controller, Get, Post, Param, Body, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ConfiguratorService } from './configurator.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CustomerGuard } from '../auth/guards/customer.guard';

@Controller('configurator')
@UseGuards(JwtAuthGuard)
export class ConfiguratorController {
  constructor(private readonly configurator: ConfiguratorService) {}

  // ---- Preview surface: read-only, no disk writes, any authenticated user ----

  @Get('generators')
  generators() {
    return this.configurator.generators();
  }

  @Get(':key/choices')
  choices(@Param('key') key: string) {
    return this.configurator.choices(key);
  }

  @Get(':key/info')
  info(@Param('key') key: string, @Query() query: Record<string, unknown>) {
    return this.configurator.info(key, query);
  }

  @Get(':key/preview.svg')
  async preview(@Param('key') key: string, @Query() query: Record<string, unknown>, @Res() res: Response) {
    // MUST await: previewSvg runs behind the preview limiter and returns a
    // promise. Sending it unawaited shipped a stringified Promise to the client.
    const svg = await this.configurator.previewSvg(key, query);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    // Defence in depth — the SVG is server-built, but never let a browser treat
    // it as anything else, and block any script if one ever slipped in.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(svg);
  }

  // ---- The only state-changing customer route (rate-limited) ----

  @Post('orders')
  @UseGuards(CustomerGuard)
  @Throttle({ long: { ttl: 60_000, limit: 5 } }) // 5 order submissions per minute
  createOrder(
    @Req() req: any,
    @Body() dto: { generatorKey: string; params: unknown; quantity?: number },
  ) {
    return this.configurator.createOrder(req.user.id, dto);
  }

  // ---- Employee-only: view params/artifacts and download ----

  @Get('orders/:orderId')
  @UseGuards(StaffGuard)
  getForOrder(@Param('orderId') orderId: string) {
    return this.configurator.getForOrder(orderId);
  }

  @Get('artifacts/:id/download')
  @UseGuards(StaffGuard)
  download(@Param('id') id: string, @Res() res: Response) {
    return this.configurator.streamArtifact(id, res);
  }
}
