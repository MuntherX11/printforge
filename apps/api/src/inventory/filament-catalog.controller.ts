import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { FilamentCatalogService } from './filament-catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';

/**
 * Swatch lookup behind the Add Filament form. Reference data, staff only —
 * nothing here is stock, and nothing here is customer-facing.
 */
@Controller('filament-catalog')
@UseGuards(JwtAuthGuard, StaffGuard)
export class FilamentCatalogController {
  constructor(private catalog: FilamentCatalogService) {}

  @Get()
  search(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('brand') brand?: string,
  ) {
    return this.catalog.search(q, type, Number(limit) || 25, brand);
  }

  /** Catalogue brands unioned with brands already used in this workshop. */
  @Get('brands')
  brands() {
    return this.catalog.brands();
  }

  /** Every catalogue brand with an on/off flag, for the Settings screen. */
  @Get('brand-settings')
  brandSettings() {
    return this.catalog.brandSettings();
  }

  @Post('brand-settings')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setBrandSettings(@Body() body: { brands?: string[] }) {
    return this.catalog.setEnabledBrands(body?.brands ?? []);
  }

  @Get('nearest')
  nearest(@Query('hex') hex: string, @Query('limit') limit?: string) {
    return this.catalog.nearest(hex, Number(limit) || 5);
  }

  /** Which existing materials could have a hex filled in, and from what. */
  @Get('suggest-hex')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  suggestHex() {
    return this.catalog.suggestHexForMaterials();
  }

  @Post('apply-hex')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  applyHex(@Body() body: { updates?: Array<{ materialId: string; hex: string }> }) {
    return this.catalog.applyHex(body?.updates ?? []);
  }

  /** Re-read the bundled snapshot after it has been refreshed on disk. */
  @Post('reseed')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  reseed() {
    return this.catalog.seed();
  }
}
