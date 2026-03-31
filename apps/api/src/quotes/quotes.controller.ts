import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateQuoteDto, UpdateQuoteDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('quotes')
@UseGuards(JwtAuthGuard)
export class QuotesController {
  constructor(private quotesService: QuotesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateQuoteDto) {
    return this.quotesService.create(dto);
  }

  @Get()
  findAll(@Query() query: PaginationDto, @Query('status') status?: string) {
    return this.quotesService.findAll(query, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.quotesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateQuoteDto) {
    return this.quotesService.update(id, dto);
  }

  @Post(':id/convert')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  convertToOrder(@Param('id') id: string, @Body() body?: { autoCreateJobs?: boolean }) {
    return this.quotesService.convertToOrder(id, body);
  }
}
