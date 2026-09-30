import { Controller, Get, Post, Patch, Param, Body, Res, Query, UseGuards, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { InvoicesService } from './invoices.service';
import { PdfService } from './pdf.service';
import { EmailService } from '../communications/email.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreateInvoiceDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';
import type { InvoiceActor } from './invoice-input';

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

  /**
   * The body is parsed by invoice-input.ts (status, paidAt); paidAmount is set
   * only by marking PAID. ACCOUNTING may only mark PAID (the service says 403
   * to anything else).
   */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTING')
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: InvoiceActor) {
    return this.invoicesService.update(id, body, user);
  }

  /** Undo payment: PAID back to ISSUED, reversing the order credit and the ledger entries. Writes its own audit row. */
  @Post(':id/unpay')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTING')
  unpay(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: InvoiceActor) {
    return this.invoicesService.unpay(id, body, user);
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
