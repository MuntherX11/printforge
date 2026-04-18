import { Module } from '@nestjs/common';
import { CommunicationsController } from './communications.controller';
import { EmailService } from './email.service';
import { EmailNotificationService } from './email-notification.service';
import { WhatsAppService } from './whatsapp.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [CommunicationsController],
  providers: [EmailService, EmailNotificationService, WhatsAppService],
  exports: [EmailService, EmailNotificationService, WhatsAppService],
})
export class CommunicationsModule {}
