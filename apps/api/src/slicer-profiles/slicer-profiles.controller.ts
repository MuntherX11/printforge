import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SlicerProfilesService } from './slicer-profiles.service';
import { parseProfilePatch } from './profile-input';

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

@Controller('slicer-profiles')
@UseGuards(JwtAuthGuard)
export class SlicerProfilesController {
  constructor(private readonly profiles: SlicerProfilesService) {}

  // Any staff member: the product page needs the list to offer printers/filaments.
  @Get()
  @UseGuards(StaffGuard)
  list() {
    return this.profiles.list();
  }

  // Proxies the sidecar's /health for the Settings badge.
  @Get('health')
  @UseGuards(StaffGuard)
  health() {
    return this.profiles.health();
  }

  @Post('import')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BUNDLE_BYTES } }))
  importBundle(@UploadedFile() file?: Express.Multer.File) {
    return this.profiles.importBundle(file);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.profiles.update(id, parseProfilePatch(body));
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.profiles.remove(id);
  }
}
