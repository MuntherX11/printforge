import { Module } from '@nestjs/common';
import { CommunicationsController } from './communications.controller';
import { EmailService } from './email.service';
import { EmailNotificationService } from './email-notification.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [CommunicationsController],
  providers: [EmailService, EmailNotificationService],
  exports: [EmailService, EmailNotificationService],
})
export class CommunicationsModule {}
