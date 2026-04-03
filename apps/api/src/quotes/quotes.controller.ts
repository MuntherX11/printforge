import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CustomerGuard } from '../auth/guards/customer.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreateQuoteDto, UpdateQuoteDto, SaveQuoteFromAnalysisDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('quotes')
@UseGuards(JwtAuthGuard)
export class QuotesController {
  constructor(private quotesService: QuotesService) {}

  @Post()
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateQuoteDto) {
    return this.quotesService.create(dto);
  }

  @Post('from-analysis')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  createFromAnalysis(@Body() dto: SaveQuoteFromAnalysisDto, @CurrentUser() user: any) {
    return this.quotesService.createFromAnalysis(dto, user.id);
  }

  @Get()
  @UseGuards(StaffGuard)
  findAll(@Query() query: PaginationDto, @Query('status') status?: string) {
    return this.quotesService.findAll(query, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.quotesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateQuoteDto) {
    return this.quotesService.update(id, dto);
  }

  @Post(':id/convert')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  convertToOrder(@Param('id') id: string, @Body() body?: { autoCreateJobs?: boolean }) {
    return this.quotesService.convertToOrder(id, body);
  }

  // ============ CUSTOMER ENDPOINTS ============

  @Get('customer/my-quotes')
  @UseGuards(CustomerGuard)
  findMyQuotes(@CurrentUser() user: any, @Query() query: PaginationDto) {
    return this.quotesService.findForCustomer(user.id, query);
  }

  @Post('customer/:id/accept')
  @UseGuards(CustomerGuard)
  customerAccept(@Param('id') id: string, @CurrentUser() user: any) {
    return this.quotesService.customerAccept(id, user.id);
  }

  @Post('customer/:id/reject')
  @UseGuards(CustomerGuard)
  customerReject(@Param('id') id: string, @CurrentUser() user: any) {
    return this.quotesService.customerReject(id, user.id);
  }
}
