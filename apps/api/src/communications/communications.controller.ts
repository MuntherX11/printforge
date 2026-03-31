import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { EmailService } from './email.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('communications')
@UseGuards(JwtAuthGuard)
export class CommunicationsController {
  constructor(private emailService: EmailService) {}

  @Post('send-email')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  async sendEmail(@Body() dto: { to: string; subject: string; body: string }) {
    return this.emailService.sendEmail(dto.to, dto.subject, dto.body);
  }
}
