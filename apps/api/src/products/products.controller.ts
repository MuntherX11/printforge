import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CustomerGuard } from '../auth/guards/customer.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { ProductComponentsService } from './product-components.service';
import { sendImageFile } from './product-images.controller';
import { ProductImagesService } from './product-images.service';
import { flag } from './product-input';
import { ProductsService } from './products.service';

/**
 * Products API (spec §4.1 P1–P21). Options live in VariantsController, colour
 * slots in ColourSlotsController, slicer imports in ProductImportsController,
 * photos in ProductImagesController. Every body goes through an allowlist parser.
 */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly components: ProductComponentsService,
    private readonly images: ProductImagesService,
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() body: unknown) {
    return this.products.create(body);
  }

  /** P1 */
  @Get()
  @UseGuards(StaffGuard)
  findAll(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.products.list(page, limit);
  }

  /** P2 */
  @Get('active')
  @UseGuards(StaffGuard)
  findAllActive() {
    return this.products.active();
  }

  /** P3 */
  @Get('customer/catalog')
  @UseGuards(CustomerGuard)
  findPublicCatalog() {
    return this.products.catalog();
  }

  /** P4 */
  @Get('customer/:id')
  @UseGuards(CustomerGuard)
  findOnePublic(@Param('id') id: string) {
    return this.products.catalogDetail(id);
  }

  @Post('upload-bom')
  @UseGuards(StaffGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async uploadBom(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.originalname?.toLowerCase().endsWith('.xlsx')) throw new BadRequestException('File must be a .xlsx Excel file');
    return this.products.uploadBom(file.buffer);
  }

  /** P10 alias */
  @Patch('components/:componentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  updateComponentAlias(@Param('componentId') componentId: string, @Body() body: unknown, @Query('dryRun') dryRun?: string, @CurrentUser() user?: any) {
    return this.components.update(null, componentId, body, flag(dryRun), user?.id ?? null);
  }

  /** P14 alias */
  @Delete('components/:componentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  removeComponentAlias(@Param('componentId') componentId: string) {
    return this.components.remove(null, componentId);
  }

  /** P5 */
  @Get(':id')
  @UseGuards(StaffGuard)
  findOne(@Param('id') id: string) {
    return this.products.findOne(id);
  }

  /** P6 */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.products.update(id, body);
  }

  /** P7 */
  @Get(':id/history')
  @UseGuards(StaffGuard)
  history(@Param('id') id: string) {
    return this.products.history(id);
  }

  /** P8 */
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }

  /** P9 */
  @Post(':id/components')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  addComponent(@Param('id') id: string, @Body() body: unknown) {
    return this.components.add(id, body);
  }

  /** P12 (declared before the :componentId routes) */
  @Put(':id/components/order')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  reorderComponents(@Param('id') id: string, @Body() body: unknown) {
    return this.components.reorder(id, body);
  }

  /** P10 */
  @Patch(':id/components/:componentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  updateComponent(@Param('id') id: string, @Param('componentId') componentId: string, @Body() body: unknown, @Query('dryRun') dryRun?: string, @CurrentUser() user?: any) {
    return this.components.update(id, componentId, body, flag(dryRun), user?.id ?? null);
  }

  /** P11 */
  @Put(':id/components/:componentId/materials')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setComponentMaterials(@Param('id') id: string, @Param('componentId') componentId: string, @Body() body: unknown, @Query('dryRun') dryRun?: string, @CurrentUser() user?: any) {
    return this.components.setMaterials(id, componentId, body, flag(dryRun), user?.id ?? null);
  }

  /** P13 */
  @Put(':id/components/:componentId/stock')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setComponentStock(@Param('id') id: string, @Param('componentId') componentId: string, @Body() body: unknown, @CurrentUser() user?: any) {
    return this.components.setStock(id, componentId, body, user?.id ?? null);
  }

  /** P14 */
  @Delete(':id/components/:componentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  removeComponent(@Param('id') id: string, @Param('componentId') componentId: string) {
    return this.components.remove(id, componentId);
  }

  /**
   * P15: the component's 3MF plate render, staff only. PNG bytes through the
   * shared image helper (§4.6 headers), authorised on every request. Throttling
   * is skipped for all named tiers, as for the photo route (§0.2).
   */
  @Get(':id/components/:componentId/thumbnail')
  @UseGuards(StaffGuard)
  @SkipThrottle({ short: true, medium: true, long: true })
  async thumbnail(@Param('id') id: string, @Param('componentId') componentId: string, @Res() res: Response): Promise<void> {
    const img = await this.images.resolveComponentThumbnail(id, componentId);
    sendImageFile(res, img.absPath, img.mime);
  }

  /** P16 */
  @Get(':id/cost')
  @UseGuards(StaffGuard)
  cost(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.products.cost(id, query ?? {});
  }

  /** P17 */
  @Post(':id/calculate')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  calculate(@Param('id') id: string) {
    return this.products.calculate(id);
  }

  /** P18 (replaces the removed bulk-costs route) */
  @Get(':id/bulk-floor')
  @UseGuards(StaffGuard)
  bulkFloor(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.products.bulkFloor(id, query ?? {});
  }

  /** P19 */
  @Put(':id/price-tiers')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setPriceTiers(@Param('id') id: string, @Body() body: unknown) {
    return this.products.setPriceTiers(id, body);
  }

  /** P20 */
  @Get(':id/readiness')
  @UseGuards(StaffGuard)
  readiness(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.products.readiness(id, query ?? {});
  }

  /** P21 */
  @Get(':id/parts')
  @UseGuards(StaffGuard)
  listParts(@Param('id') id: string) {
    return this.products.listParts(id);
  }

  @Post(':id/parts')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  setPart(@Param('id') id: string, @Body() body: unknown) {
    return this.products.setPart(id, body);
  }

  @Delete(':id/parts/:partId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  removePart(@Param('id') id: string, @Param('partId') partId: string) {
    return this.products.removePart(id, partId);
  }
}
