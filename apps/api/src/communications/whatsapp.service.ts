import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private settingsService: SettingsService) {}

  /** Strip non-digits from phone number. */
  private formatPhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  /**
   * Send a free-form text message via Meta WhatsApp Business Cloud API.
   * Returns true on success, false when not configured or on error.
   *
   * Note: Free-form text requires the customer to have messaged you within the last 24 hours.
   * For proactive outbound messages, create Message Templates in Meta Business Manager
   * and switch type to 'template' in the body below.
   */
  async sendMessage(to: string, message: string): Promise<boolean> {
    const [token, phoneId, enabled] = await Promise.all([
      this.settingsService.get('whatsapp_token'),
      this.settingsService.get('whatsapp_phone_id'),
      this.settingsService.get('whatsapp_enabled', 'false'),
    ]);

    if (!token || !phoneId || enabled !== 'true') return false;

    const phone = this.formatPhone(to);
    if (!phone) return false;

    try {
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: message },
          }),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        this.logger.warn(`WhatsApp send failed to +${phone}: ${err}`);
        return false;
      }

      this.logger.log(`WhatsApp message sent to +${phone}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`WhatsApp request error: ${err.message}`);
      return false;
    }
  }

  // ─── Typed notification helpers ───────────────────────────────────────────

  async sendQuoteSent(
    to: string,
    data: { customerName: string; quoteNumber: string; total: string; companyName: string },
  ) {
    const msg =
      `Hi ${data.customerName}, your quote ${data.quoteNumber} from ${data.companyName} is ready for review.\n` +
      `Total: ${data.total}. Please log in to the customer portal to accept or request changes.`;
    return this.sendMessage(to, msg);
  }

  async sendOrderConfirmed(
    to: string,
    data: { customerName: string; orderNumber: string; companyName: string },
  ) {
    const msg =
      `Hi ${data.customerName}, your order ${data.orderNumber} has been confirmed by ${data.companyName}. ` +
      `We'll update you when it goes into production.`;
    return this.sendMessage(to, msg);
  }

  async sendOrderInProduction(
    to: string,
    data: { customerName: string; orderNumber: string; companyName: string },
  ) {
    const msg =
      `Hi ${data.customerName}, great news! Your order ${data.orderNumber} has started production. ` +
      `We'll notify you when it's ready.`;
    return this.sendMessage(to, msg);
  }

  async sendOrderReady(
    to: string,
    data: { customerName: string; orderNumber: string; companyName: string },
  ) {
    const msg =
      `Hi ${data.customerName}, your order ${data.orderNumber} is ready! ` +
      `Please contact ${data.companyName} to arrange pickup or delivery.`;
    return this.sendMessage(to, msg);
  }

  async sendOrderCompleted(
    to: string,
    data: { customerName: string; orderNumber: string; companyName: string },
  ) {
    const msg =
      `Hi ${data.customerName}, your order ${data.orderNumber} has been completed. ` +
      `Thank you for choosing ${data.companyName}!`;
    return this.sendMessage(to, msg);
  }
}
