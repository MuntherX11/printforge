import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);

  constructor(
    private emailService: EmailService,
    private settingsService: SettingsService,
  ) {}

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private async wrapInTemplate(content: string): Promise<string> {
    const companyName = this.escapeHtml(await this.settingsService.get('company_name', 'PrintForge'));
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
        <div style="background: white; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #1a56db; font-size: 24px; margin: 0;">${companyName}</h1>
          </div>
          ${content}
        </div>
        <div style="text-align: center; padding: 16px; color: #9ca3af; font-size: 12px;">
          <p>${companyName} | Powered by PrintForge</p>
        </div>
      </div>
    `;
  }

  private async trySend(to: string, subject: string, htmlContent: string): Promise<void> {
    try {
      const body = await this.wrapInTemplate(htmlContent);
      await this.emailService.sendEmail(to, subject, body);
      this.logger.log(`Email sent: "${subject}" to ${to}`);
    } catch (error: any) {
      this.logger.warn(`Failed to send email "${subject}" to ${to}: ${error.message}`);
    }
  }

  // ============ ADMIN NOTIFICATIONS ============

  async notifyAdminDesignRequested(project: { projectNumber: string; title: string; customerName: string }) {
    const adminEmail = await this.settingsService.get('admin_email');
    if (!adminEmail) return;

    await this.trySend(adminEmail, `New Design Request: ${project.projectNumber}`, `
      <h2 style="color: #1f2937; font-size: 18px;">New Design Request</h2>
      <p style="color: #4b5563;">A new design request has been submitted:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Project</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${this.escapeHtml(project.projectNumber)}</td></tr>
        <tr><td style="padding: 8px; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Title</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${this.escapeHtml(project.title)}</td></tr>
        <tr><td style="padding: 8px; color: #6b7280;">Customer</td><td style="padding: 8px;">${this.escapeHtml(project.customerName)}</td></tr>
      </table>
      <p style="color: #4b5563;">Please review and assign a designer.</p>
    `);
  }

  async notifyAdminDesignFeedback(project: { projectNumber: string; title: string; customerName: string; feedback: string }) {
    const adminEmail = await this.settingsService.get('admin_email');
    if (!adminEmail) return;

    await this.trySend(adminEmail, `Design Feedback: ${project.projectNumber}`, `
      <h2 style="color: #1f2937; font-size: 18px;">Customer Feedback on Design</h2>
      <p style="color: #4b5563;">${this.escapeHtml(project.customerName)} has requested changes on <strong>${this.escapeHtml(project.projectNumber)}</strong>:</p>
      <div style="background: #f3f4f6; border-radius: 6px; padding: 16px; margin: 16px 0;">
        <p style="color: #374151; margin: 0;">${this.escapeHtml(project.feedback)}</p>
      </div>
    `);
  }

  // ============ CUSTOMER NOTIFICATIONS ============

  async notifyCustomerDesignUploaded(to: string, project: { projectNumber: string; title: string; revisionNumber: number }) {
    await this.trySend(to, `Design Update: ${project.projectNumber}`, `
      <h2 style="color: #1f2937; font-size: 18px;">New Design Revision Ready</h2>
      <p style="color: #4b5563;">A new revision (v${project.revisionNumber}) has been uploaded for your project:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px; color: #6b7280; border-bottom: 1px solid #e5e7eb;">Project</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: 600;">${this.escapeHtml(project.projectNumber)}</td></tr>
        <tr><td style="padding: 8px; color: #6b7280;">Title</td><td style="padding: 8px;">${this.escapeHtml(project.title)}</td></tr>
      </table>
      <p style="color: #4b5563;">Please log in to review the design and approve or request changes.</p>
    `);
  }

  async notifyCustomerOrderProduction(to: string, order: { orderNumber: string }) {
    await this.trySend(to, `Order ${order.orderNumber} — In Production`, `
      <h2 style="color: #1f2937; font-size: 18px;">Your Order is in Production</h2>
      <p style="color: #4b5563;">Great news! Your order <strong>${this.escapeHtml(order.orderNumber)}</strong> has started production.</p>
      <p style="color: #4b5563;">We'll notify you once it's ready.</p>
    `);
  }

  async notifyCustomerOrderCompleted(to: string, order: { orderNumber: string }) {
    await this.trySend(to, `Order ${order.orderNumber} — Completed`, `
      <h2 style="color: #1f2937; font-size: 18px;">Your Order is Complete!</h2>
      <p style="color: #4b5563;">Your order <strong>${this.escapeHtml(order.orderNumber)}</strong> has been completed and is ready.</p>
      <p style="color: #4b5563;">Thank you for choosing us!</p>
    `);
  }

  async notifyCustomerApproved(to: string, name: string) {
    await this.trySend(to, 'Account Approved — Welcome!', `
      <h2 style="color: #1f2937; font-size: 18px;">Welcome, ${this.escapeHtml(name)}!</h2>
      <p style="color: #4b5563;">Your account has been approved. You can now log in to the customer portal to:</p>
      <ul style="color: #4b5563; line-height: 1.8;">
        <li>View and accept quotes</li>
        <li>Submit design requests</li>
        <li>Track your orders</li>
      </ul>
    `);
  }
}
