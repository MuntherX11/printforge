import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PdfService } from './pdf.service';
import { CommunicationsModule } from '../communications/communications.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [CommunicationsModule, AccountingModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, PdfService],
  exports: [InvoicesService, PdfService],
})
export class InvoicesModule {}
