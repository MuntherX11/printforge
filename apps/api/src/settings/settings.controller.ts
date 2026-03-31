import { Controller, Get, Put, Post, Body, UseGuards, UseInterceptors, UploadedFile, Res, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import * as fs from 'fs';
import * as path from 'path';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  getAll() {
    return this.settingsService.getAll();
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  update(@Body() body: { settings: Array<{ key: string; value: string }> }) {
    return this.settingsService.setBulk(body.settings);
  }

  @Post('logo')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file'))
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
    res.sendFile(logoPath);
  }
}
