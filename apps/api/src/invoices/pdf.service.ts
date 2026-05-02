import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';

@Injectable()
export class PdfService {
  constructor(private prisma: PrismaService) {}

  async generateInvoicePdf(invoice: any): Promise<Buffer> {
    const settings = await this.prisma.systemSetting.findMany();
    const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const currency = settingsMap['currency'] || 'OMR';
    const companyName = settingsMap['company_name'] || 'PrintForge';
    const companyAddress = settingsMap['company_address'] || '';
    const companyPhone = settingsMap['company_phone'] || '';
    const companyEmail = settingsMap['company_email'] || '';
    const logoPath = settingsMap['company_logo'] || '';
    const bankDetails = settingsMap['bank_details'] || '';
    const invoiceNotes = settingsMap['invoice_notes'] || '';

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // === HEADER WITH LOGO ===
      let headerY = 50;
      const hasLogo = logoPath && fs.existsSync(logoPath);

      if (hasLogo) {
        try {
          doc.image(logoPath, 50, 45, { width: 80 });
          // Company name next to logo
          doc.fontSize(20).font('Helvetica-Bold').text(companyName, 140, 50);
          if (companyAddress) doc.fontSize(9).font('Helvetica').text(companyAddress, 140, 75);
          if (companyPhone) doc.text(companyPhone, 140, 88);
          if (companyEmail) doc.text(companyEmail, 140, 101);
          headerY = 120;
        } catch {
          // Fallback if image fails
          doc.fontSize(20).font('Helvetica-Bold').text(companyName, 50, 50);
          if (companyAddress) doc.fontSize(9).font('Helvetica').text(companyAddress, 50, 76);
          headerY = 100;
        }
      } else {
        doc.fontSize(20).font('Helvetica-Bold').text(companyName, 50, 50);
        let infoY = 76;
        doc.fontSize(9).font('Helvetica');
        if (companyAddress) { doc.text(companyAddress, 50, infoY); infoY += 13; }
        if (companyPhone) { doc.text(companyPhone, 50, infoY); infoY += 13; }
        if (companyEmail) { doc.text(companyEmail, 50, infoY); infoY += 13; }
        headerY = infoY + 5;
      }

      // === INVOICE TITLE AND INFO (right-aligned) ===
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a56db').text('INVOICE', 400, 50, { align: 'right' });
      doc.fillColor('#000000');
      doc.fontSize(10).font('Helvetica')
        .text(`#${invoice.invoiceNumber}`, 400, 78, { align: 'right' })
        .text(`Date: ${new Date(invoice.issuedAt || invoice.createdAt).toLocaleDateString('en-GB')}`, 400, 93, { align: 'right' });

      if (invoice.dueDate) {
        doc.text(`Due: ${new Date(invoice.dueDate).toLocaleDateString('en-GB')}`, 400, 108, { align: 'right' });
      }

      // === SEPARATOR LINE ===
      const sepY = Math.max(headerY, 130);
      doc.moveTo(50, sepY).lineTo(545, sepY).lineWidth(1).strokeColor('#e5e7eb').stroke();

      // === BILL TO ===
      const customer = invoice.order?.customer;
      let billY = sepY + 15;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#6b7280').text('BILL TO', 50, billY);
      billY += 16;
      doc.fillColor('#000000');
      if (customer) {
        doc.fontSize(11).font('Helvetica-Bold').text(customer.name, 50, billY);
        billY += 16;
        doc.fontSize(9).font('Helvetica');
        if (customer.email) { doc.text(customer.email, 50, billY); billY += 13; }
        if (customer.phone) { doc.text(customer.phone, 50, billY); billY += 13; }
        if (customer.address) { doc.text(customer.address, 50, billY); billY += 13; }
      }

      // Order reference on right side
      if (invoice.order?.orderNumber) {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#6b7280').text('ORDER REF', 400, sepY + 15, { align: 'right' });
        doc.fontSize(11).font('Helvetica').fillColor('#000000').text(invoice.order.orderNumber, 400, sepY + 31, { align: 'right' });
      }

      // === ITEMS TABLE ===
      const tableTop = Math.max(billY + 15, sepY + 70);

      // Table header background
      doc.rect(50, tableTop - 5, 495, 22).fillColor('#f3f4f6').fill();
      doc.fillColor('#374151').fontSize(9).font('Helvetica-Bold');
      doc.text('Description', 55, tableTop);
      doc.text('Qty', 310, tableTop, { width: 40, align: 'center' });
      doc.text('Unit Price', 355, tableTop, { width: 80, align: 'right' });
      doc.text('Total', 445, tableTop, { width: 95, align: 'right' });

      let y = tableTop + 22;
      doc.fillColor('#000000').font('Helvetica').fontSize(9);
      const items = invoice.order?.items || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        // Alternate row background
        if (i % 2 === 1) {
          doc.rect(50, y - 3, 495, 20).fillColor('#f9fafb').fill();
          doc.fillColor('#000000');
        }
        doc.text(item.description, 55, y, { width: 250 });
        doc.text(String(item.quantity), 310, y, { width: 40, align: 'center' });
        doc.text(`${currency} ${item.unitPrice.toFixed(3)}`, 355, y, { width: 80, align: 'right' });
        doc.text(`${currency} ${item.totalPrice.toFixed(3)}`, 445, y, { width: 95, align: 'right' });
        y += 20;
      }

      // === TOTALS ===
      y += 8;
      doc.moveTo(350, y).lineTo(545, y).lineWidth(0.5).strokeColor('#d1d5db').stroke();
      y += 10;

      doc.fontSize(9).font('Helvetica');
      doc.text('Subtotal:', 370, y);
      doc.text(`${currency} ${invoice.subtotal.toFixed(3)}`, 445, y, { width: 95, align: 'right' });
      y += 16;
      doc.text('Tax:', 370, y);
      doc.text(`${currency} ${invoice.tax.toFixed(3)}`, 445, y, { width: 95, align: 'right' });
      y += 16;

      // Total box
      doc.rect(350, y - 4, 195, 24).fillColor('#1a56db').fill();
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('TOTAL:', 370, y);
      doc.text(`${currency} ${invoice.total.toFixed(3)}`, 445, y, { width: 95, align: 'right' });
      doc.fillColor('#000000');

      y += 30;

      if (invoice.paidAmount > 0) {
        doc.fontSize(9).font('Helvetica');
        doc.text('Paid:', 370, y);
        doc.text(`${currency} ${invoice.paidAmount.toFixed(3)}`, 445, y, { width: 95, align: 'right' });
        y += 16;
        const balance = invoice.total - invoice.paidAmount;
        doc.font('Helvetica-Bold');
        doc.text('Balance Due:', 370, y);
        doc.text(`${currency} ${balance.toFixed(3)}`, 445, y, { width: 95, align: 'right' });
        y += 20;
      }

      // === PAYMENT / BANK DETAILS ===
      if (bankDetails) {
        y = Math.max(y + 10, 580);
        doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
        y += 10;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#6b7280').text('PAYMENT DETAILS', 50, y);
        y += 14;
        doc.fontSize(8).font('Helvetica').fillColor('#000000').text(bankDetails, 50, y, { width: 300 });
      }

      // === NOTES ===
      if (invoiceNotes) {
        const notesY = bankDetails ? y + 40 : Math.max(y + 10, 620);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#6b7280').text('NOTES', 50, notesY);
        doc.fontSize(8).font('Helvetica').fillColor('#000000').text(invoiceNotes, 50, notesY + 14, { width: 300 });
      }

      // === FOOTER ===
      doc.fontSize(7).font('Helvetica').fillColor('#9ca3af').text(
        `Generated by PrintForge | ${companyName}`,
        50, 770,
        { align: 'center', width: 495 },
      );

      doc.end();
    });
  }

  async generateQuotePdf(quote: any): Promise<Buffer> {
    const settings = await this.prisma.systemSetting.findMany();
    const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const currency = settingsMap['currency'] || 'OMR';
    const companyName = settingsMap['company_name'] || 'PrintForge';
    const companyAddress = settingsMap['company_address'] || '';
    const companyPhone = settingsMap['company_phone'] || '';
    const companyEmail = settingsMap['company_email'] || '';
    const logoPath = settingsMap['company_logo'] || '';

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // === HEADER WITH LOGO ===
      let headerY = 50;
      const hasLogo = logoPath && fs.existsSync(logoPath);

      if (hasLogo) {
        try {
          doc.image(logoPath, 50, 45, { width: 80 });
          doc.fontSize(20).font('Helvetica-Bold').text(companyName, 140, 50);
          if (companyAddress) doc.fontSize(9).font('Helvetica').text(companyAddress, 140, 75);
          if (companyPhone) doc.text(companyPhone, 140, 88);
          if (companyEmail) doc.text(companyEmail, 140, 101);
          headerY = 120;
        } catch {
          doc.fontSize(20).font('Helvetica-Bold').text(companyName, 50, 50);
          if (companyAddress) doc.fontSize(9).font('Helvetica').text(companyAddress, 50, 76);
          headerY = 100;
        }
      } else {
        doc.fontSize(20).font('Helvetica-Bold').text(companyName, 50, 50);
        let infoY = 76;
        doc.fontSize(9).font('Helvetica');
        if (companyAddress) { doc.text(companyAddress, 50, infoY); infoY += 13; }
        if (companyPhone) { doc.text(companyPhone, 50, infoY); infoY += 13; }
        if (companyEmail) { doc.text(companyEmail, 50, infoY); infoY += 13; }
        headerY = infoY + 5;
      }

      // === QUOTATION TITLE AND INFO (right-aligned) ===
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a56db').text('QUOTATION', 380, 50, { align: 'right' });
      doc.fillColor('#000000');
      doc.fontSize(10).font('Helvetica')
        .text(`#${quote.quoteNumber}`, 380, 78, { align: 'right' })
        .text(`Date: ${new Date(quote.createdAt).toLocaleDateString('en-GB')}`, 380, 93, { align: 'right' });

      if (quote.validUntil) {
        doc.text(`Valid Until: ${new Date(quote.validUntil).toLocaleDateString('en-GB')}`, 380, 108, { align: 'right' });
      }

      // === SEPARATOR LINE ===
      const sepY = Math.max(headerY, 130);
      doc.moveTo(50, sepY).lineTo(545, sepY).lineWidth(1).strokeColor('#e5e7eb').stroke();

      // === BILL TO ===
      const customer = quote.customer;
      let billY = sepY + 15;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#6b7280').text('BILL TO', 50, billY);
      billY += 16;
      doc.fillColor('#000000');
      if (customer) {
        doc.fontSize(11).font('Helvetica-Bold').text(customer.name, 50, billY);
        billY += 16;
        doc.fontSize(9).font('Helvetica');
        if (customer.email) { doc.text(customer.email, 50, billY); billY += 13; }
        if (customer.phone) { doc.text(customer.phone, 50, billY); billY += 13; }
        if (customer.address) { doc.text(customer.address, 50, billY); billY += 13; }
      }

      // === ITEMS TABLE ===
      const tableTop = Math.max(billY + 15, sepY + 70);

      doc.rect(50, tableTop - 5, 495, 22).fillColor('#f3f4f6').fill();
      doc.fillColor('#374151').fontSize(9).font('Helvetica-Bold');
      doc.text('Description', 55, tableTop);
      doc.text('Qty', 310, tableTop, { width: 40, align: 'center' });
      doc.text('Unit Price', 355, tableTop, { width: 80, align: 'right' });
      doc.text('Total', 445, tableTop, { width: 95, align: 'right' });

      let y = tableTop + 22;
      doc.fillColor('#000000').font('Helvetica').fontSize(9);
      const items = quote.items || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (i % 2 === 1) {
          doc.rect(50, y - 3, 495, 20).fillColor('#f9fafb').fill();
          doc.fillColor('#000000');
        }
        doc.text(item.description, 55, y, { width: 250 });
        doc.text(String(item.quantity), 310, y, { width: 40, align: 'center' });
        doc.text(`${currency} ${Number(item.unitPrice).toFixed(3)}`, 355, y, { width: 80, align: 'right' });
        doc.text(`${currency} ${Number(item.totalPrice).toFixed(3)}`, 445, y, { width: 95, align: 'right' });
        y += 20;
      }

      // === TOTALS ===
      y += 8;
      doc.moveTo(350, y).lineTo(545, y).lineWidth(0.5).strokeColor('#d1d5db').stroke();
      y += 10;

      doc.fontSize(9).font('Helvetica');
      doc.text('Subtotal:', 370, y);
      doc.text(`${currency} ${Number(quote.subtotal).toFixed(3)}`, 445, y, { width: 95, align: 'right' });
      y += 16;
      doc.text('Tax:', 370, y);
      doc.text(`${currency} ${Number(quote.tax).toFixed(3)}`, 445, y, { width: 95, align: 'right' });
      y += 16;

      doc.rect(350, y - 4, 195, 24).fillColor('#1a56db').fill();
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('TOTAL:', 370, y);
      doc.text(`${currency} ${Number(quote.total).toFixed(3)}`, 445, y, { width: 95, align: 'right' });
      doc.fillColor('#000000');

      y += 35;

      // === NOTES ===
      if (quote.notes) {
        doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
        y += 10;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#6b7280').text('NOTES', 50, y);
        y += 14;
        doc.fontSize(8).font('Helvetica').fillColor('#000000').text(quote.notes, 50, y, { width: 495 });
      }

      // === FOOTER ===
      doc.fontSize(7).font('Helvetica').fillColor('#9ca3af').text(
        `Generated by PrintForge | ${companyName}`,
        50, 770,
        { align: 'center', width: 495 },
      );

      doc.end();
    });
  }
}
