import { Controller, Get, Post, Patch, Param, Body, Res, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { InvoicesService } from './invoices.service';
import { PdfService } from './pdf.service';
import { EmailService } from '../communications/email.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CreateInvoiceDto, UpdateInvoiceDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(
    private invoicesService: InvoicesService,
    private pdfService: PdfService,
    private emailService: EmailService,
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() dto: CreateInvoiceDto) {
    return this.invoicesService.create(dto);
  }

  @Get()
  @UseGuards(StaffGuard)
  findAll(@Query() query: PaginationDto) {
    return this.invoicesService.findAll(query);
  }

  @Get(':id')
  @UseGuards(StaffGuard)
  findOne(@Param('id') id: string) {
    return this.invoicesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoicesService.update(id, dto);
  }

  @Get(':id/pdf')
  @UseGuards(StaffGuard)
  async downloadPdf(@Param('id') id: string, @Res() res: Response) {
    const invoice = await this.invoicesService.findOne(id);
    const pdfBuffer = await this.pdfService.generateInvoicePdf(invoice);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  @Post(':id/send-email')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async sendEmail(@Param('id') id: string, @Body() dto?: { email?: string }) {
    const invoice = await this.invoicesService.findOne(id);
    const email = dto?.email || invoice.order?.customer?.email;
    if (!email) throw new BadRequestException('No email address provided and customer has no email');
    const pdfBuffer = await this.pdfService.generateInvoicePdf(invoice);
    return this.emailService.sendInvoiceEmail(email, invoice.invoiceNumber, pdfBuffer);
  }
}
