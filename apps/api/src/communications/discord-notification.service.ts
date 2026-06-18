import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class DiscordNotificationService {
  private readonly logger = new Logger(DiscordNotificationService.name);

  constructor(private settingsService: SettingsService) {}

  async sendMessage(content: string): Promise<boolean> {
    const webhookUrl = await this.settingsService.get('discord_staff_webhook');
    if (!webhookUrl) return false;

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      return res.ok;
    } catch (err) {
      this.logger.warn('Discord webhook failed', err);
      return false;
    }
  }

  async notifyNewPortalOrder(order: {
    orderNumber: string;
    customerName: string;
    total: number;
    itemCount: number;
  }): Promise<void> {
    await this.sendMessage(
      `🛒 **New portal order** ${order.orderNumber}\n` +
      `Customer: ${order.customerName}\n` +
      `Items: ${order.itemCount} · Total: ${order.total.toFixed(3)} OMR`,
    );
  }
}
