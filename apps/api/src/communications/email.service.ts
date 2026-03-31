import { Injectable, BadRequestException } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  constructor(private settingsService: SettingsService) {}

  private async getTransporter() {
    const smtpHost = await this.settingsService.get('smtp_host', 'smtp.gmail.com');
    const smtpPort = await this.settingsService.get('smtp_port', '587');
    const smtpUser = await this.settingsService.get('smtp_user');
    const smtpPass = await this.settingsService.get('smtp_pass');

    if (!smtpUser || !smtpPass) {
      throw new BadRequestException('Email not configured. Set SMTP credentials in Settings.');
    }

    return nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: smtpPort === '465',
      auth: { user: smtpUser, pass: smtpPass },
    });
  }

  async sendEmail(to: string, subject: string, body: string, attachments?: Array<{ filename: string; content: Buffer }>) {
    const transporter = await this.getTransporter();
    const smtpUser = await this.settingsService.get('smtp_user');
    const companyName = await this.settingsService.get('company_name', 'PrintForge');

    const mailOptions: any = {
      from: `"${companyName}" <${smtpUser}>`,
      to,
      subject,
      html: body,
    };

    if (attachments?.length) {
      mailOptions.attachments = attachments;
    }

    const result = await transporter.sendMail(mailOptions);
    return { messageId: result.messageId, accepted: result.accepted };
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async sendInvoiceEmail(to: string, invoiceNumber: string, pdfBuffer: Buffer) {
    const companyName = this.escapeHtml(await this.settingsService.get('company_name', 'PrintForge'));
    const safeInvoiceNumber = this.escapeHtml(invoiceNumber);
    const subject = `Invoice ${invoiceNumber} from ${companyName}`;
    const body = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a56db;">Invoice ${safeInvoiceNumber}</h2>
        <p>Please find your invoice attached.</p>
        <p>If you have any questions, please don't hesitate to contact us.</p>
        <br/>
        <p>Best regards,<br/>${companyName}</p>
      </div>
    `;

    return this.sendEmail(to, subject, body, [
      { filename: `invoice-${invoiceNumber}.pdf`, content: pdfBuffer },
    ]);
  }
}
