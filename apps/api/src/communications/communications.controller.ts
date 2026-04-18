import { Controller, Post, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { EmailService } from './email.service';
import { WhatsAppService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('communications')
@UseGuards(JwtAuthGuard)
export class CommunicationsController {
  constructor(
    private emailService: EmailService,
    private whatsappService: WhatsAppService,
  ) {}

  @Post('send-email')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async sendEmail(@Body() dto: { to: string; subject: string; body: string }) {
    return this.emailService.sendEmail(dto.to, dto.subject, dto.body);
  }

  /** Send a test email to verify SMTP configuration. */
  @Post('test-email')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async testEmail(@Body() dto: { to: string }) {
    if (!dto.to) throw new BadRequestException('Recipient email required');
    return this.emailService.sendEmail(
      dto.to,
      'PrintForge — Test Email',
      '<p>This is a test email from PrintForge. SMTP is configured correctly!</p>',
    );
  }

  /** Send a test WhatsApp message to verify API configuration. */
  @Post('test-whatsapp')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async testWhatsApp(@Body() dto: { to: string }) {
    if (!dto.to) throw new BadRequestException('Recipient phone number required');
    const sent = await this.whatsappService.sendMessage(
      dto.to,
      'This is a test message from PrintForge. WhatsApp is configured correctly!',
    );
    if (!sent) throw new BadRequestException('WhatsApp not configured or message failed. Check token, phone ID, and enabled settings.');
    return { sent: true };
  }
}
