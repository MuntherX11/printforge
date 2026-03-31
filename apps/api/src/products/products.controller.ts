import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
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
}
