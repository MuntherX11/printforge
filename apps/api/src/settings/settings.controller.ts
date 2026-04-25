import { Controller, Get, Put, Post, Param, Body, UseGuards, UseInterceptors, UploadedFile, Res, BadRequestException, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';
import * as fs from 'fs';
import * as path from 'path';

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  // Public — frontend needs locale/currency before auth
  @Get('locale')
  async getLocale() {
    const [currency, locale, decimals, dateFormat] = await Promise.all([
      this.settingsService.get('currency', 'OMR'),
      this.settingsService.get('locale', 'en-GB'),
      this.settingsService.get('currency_decimals', '3'),
      this.settingsService.get('date_format', 'dd MMM yyyy'),
    ]);
    return { currency, locale, currencyDecimals: parseInt(decimals), dateFormat };
  }

  @Get()
  @UseGuards(JwtAuthGuard, StaffGuard)
  getAll() {
    return this.settingsService.getAll();
  }

  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  update(@Body() body: { settings: Array<{ key: string; value: string }> }) {
    return this.settingsService.setBulk(body.settings);
  }

  @Post('logo')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) return cb(new BadRequestException('Only JPG, PNG, WebP allowed'), false);
      cb(null, true);
    },
  }))
  async uploadLogo(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const ext = path.extname(file.originalname).toLowerCase();
    const logoPath = path.join(UPLOAD_DIR, `company-logo${ext}`);
    fs.writeFileSync(logoPath, file.buffer);
    await this.settingsService.set('company_logo', logoPath);
    return { path: logoPath };
  }

  @Get('logo')
  async getLogo(@Res() res: Response) {
    const logoPath = await this.settingsService.get('company_logo');
    if (!logoPath || !fs.existsSync(logoPath)) {
      res.status(404).json({ error: 'No logo uploaded' });
      return;
    }
    // H-3: Restrict sendFile to uploads directory only (prevent path traversal)
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const resolved = path.resolve(logoPath);
    if (!resolved.startsWith(uploadsDir)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.sendFile(resolved, { root: '/' });
  }

  // ── Backup management ────────────────────────────────────────────────────────

  @Get('backups')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return { backups: [], directory: BACKUP_DIR };

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.match(/^printforge_.*\.sql\.gz$/))
      .map(f => {
        const fullPath = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(fullPath);
        return {
          filename: f,
          sizeBytes: stat.size,
          createdAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { backups: files, directory: BACKUP_DIR };
  }

  @Get('backups/:filename')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  downloadBackup(@Param('filename') filename: string, @Res() res: Response) {
    // Prevent path traversal
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new BadRequestException('Invalid filename');
    }
    if (!filename.match(/^printforge_.*\.sql\.gz$/)) {
      throw new BadRequestException('Invalid backup filename');
    }

    const fullPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(fullPath)) throw new NotFoundException('Backup file not found');

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/gzip');
    res.sendFile(fullPath);
  }
}
