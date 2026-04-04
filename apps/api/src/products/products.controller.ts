import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, UseInterceptors, UploadedFile, UploadedFiles, BadRequestException } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CreateProductDto,
  UpdateProductDto,
  AddProductComponentDto,
  UpdateProductComponentDto,
} from '@printforge/types';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Get()
  findAll() {
    return this.productsService.findAll();
  }

  @Get('active')
  findAllActive() {
    return this.productsService.findAllActive();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Post(':id/components')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  addComponent(@Param('id') id: string, @Body() dto: AddProductComponentDto) {
    return this.productsService.addComponent(id, dto);
  }

  @Patch('components/:componentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  updateComponent(
    @Param('componentId') componentId: string,
    @Body() dto: UpdateProductComponentDto,
  ) {
    return this.productsService.updateComponent(componentId, dto);
  }

  @Delete('components/:componentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  removeComponent(@Param('componentId') componentId: string) {
    return this.productsService.removeComponent(componentId);
  }

  @Post(':id/calculate')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  calculateCost(@Param('id') id: string) {
    return this.productsService.calculateCost(id);
  }

  @Post(':id/onboard-gcode')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 200 * 1024 * 1024 } }))
  async onboardGcode(@Param('id') id: string, @UploadedFiles() files: any[]) {
    if (!files?.length) throw new BadRequestException('No files uploaded');
    return this.productsService.onboardFromGcode(id, files);
  }

  @Post(':id/images')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadImages(@Param('id') id: string, @UploadedFiles() files: any[]) {
    if (!files?.length) throw new BadRequestException('No files uploaded');
    return this.productsService.uploadImages(id, files);
  }

  @Delete(':id/images/:attachmentId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  removeImage(@Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return this.productsService.removeImage(id, attachmentId);
  }
}
