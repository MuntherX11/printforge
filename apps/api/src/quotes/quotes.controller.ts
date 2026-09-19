import { Controller, Get, Post, Patch, Put, Param, Body, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { QuotesService } from './quotes.service';
import { PdfService } from '../invoices/pdf.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CustomerGuard } from '../auth/guards/customer.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdateQuoteDto, SaveQuoteFromAnalysisDto } from '@printforge/types';
import { CustomerQuoteRequestDto } from './dto/customer-quote-request.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('quotes')
@UseGuards(JwtAuthGuard)
export class QuotesController {
  constructor(
    private quotesService: QuotesService,
    private pdfService: PdfService,
  ) {}

  @Post()
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() body: unknown) {
    return this.quotesService.create(body);
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
  @UseGuards(StaffGuard)
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
  convertToOrder(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: any) {
    const b = body && typeof body === 'object' ? (body as { autoCreateJobs?: unknown }) : {};
    return this.quotesService.convertToOrder(id, { autoCreateJobs: b.autoCreateJobs !== false }, user?.id ?? null);
  }

  /** S11: split a product line into same-size colour lines (DRAFT/SENT quotes). */
  @Put(':id/items/:itemId/colour')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  changeLineColour(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: unknown, @Query('dryRun') dryRun?: string) {
    return this.quotesService.changeLineColour(id, itemId, body, dryRun === '1' || dryRun === 'true');
  }

  @Get(':id/pdf')
  @UseGuards(StaffGuard)
  async downloadPdf(@Param('id') id: string, @Res() res: Response) {
    const quote = await this.quotesService.findOne(id);
    const pdfBuffer = await this.pdfService.generateQuotePdf(quote);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=quote-${quote.quoteNumber}.pdf`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  // ============ CUSTOMER ENDPOINTS ============

  @Post('customer/request')
  @UseGuards(CustomerGuard)
  customerRequestQuote(@Body() dto: CustomerQuoteRequestDto, @CurrentUser() user: any) {
    return this.quotesService.customerRequestQuote(user.id, dto);
  }

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
