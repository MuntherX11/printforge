import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import * as path from 'path';
import { AddonsService } from './addons.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

// Content-Security-Policy for the sandboxed addon document. Overrides the API's
// global helmet policy (script-src 'self') so WebAssembly-based addons work,
// while still allowing only same-origin framing.
const ADDON_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.data': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

@Controller('addons')
@UseGuards(JwtAuthGuard)
export class AddonsController {
  constructor(private readonly addons: AddonsService) {}

  // Active addons for the sidebar — any authenticated staff member.
  @Get()
  @UseGuards(StaffGuard)
  list() {
    return this.addons.listActive();
  }

  // Full registry for the admin management screen.
  @Get('manage')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  listAll() {
    return this.addons.listAll();
  }

  // Metadata for a single addon (host page needs name + entry).
  @Get('meta/:slug')
  @UseGuards(StaffGuard)
  meta(@Param('slug') slug: string) {
    return this.addons.getBySlug(slug);
  }

  @Post('upload')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.addons.install(file);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body() body: { isActive?: boolean; name?: string; sortOrder?: number },
  ) {
    return this.addons.update(id, body);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.addons.remove(id);
  }

  // Serve addon static files (the iframe document + its assets). Guarded so only
  // logged-in staff can load proprietary addon code. Uses @Res directly, which
  // bypasses the global TransformInterceptor envelope. @SkipThrottle because a
  // single addon (e.g. a 3D app) loads a burst of assets that would otherwise
  // trip the global rate limiter and 429 mid-load.
  @Get('serve/:slug/*')
  @SkipThrottle()
  @UseGuards(StaffGuard)
  async serve(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    const assetPath = (req.params as Record<string, string>)['0'] ?? '';
    const resolved = await this.addons.resolveAsset(slug, assetPath);
    if (!resolved) throw new NotFoundException('Asset not found');

    const type = MIME[path.extname(resolved).toLowerCase()];
    if (type) res.setHeader('Content-Type', type);
    res.setHeader('Content-Security-Policy', ADDON_CSP);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(resolved);
  }
}
