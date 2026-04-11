import { Controller, Post, Body, Res, HttpCode, HttpStatus, Get, UseGuards, Param } from '@nestjs/common';
import { Response } from 'express';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { StaffGuard } from './guards/staff.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // ============ STAFF AUTH ============

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60000, limit: 5 } }) // 5 login attempts per minute
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body.email, body.password);

    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('token');
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: any) {
    return user;
  }

  // ============ CUSTOMER AUTH ============

  @Post('customer/signup')
  @Throttle({ short: { ttl: 60000, limit: 3 } }) // 3 signups per minute
  async customerSignup(
    @Body() body: { name: string; email: string; phone?: string; password: string },
  ) {
    return this.authService.customerSignup(body);
  }

  @Post('customer/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60000, limit: 5 } }) // 5 login attempts per minute
  async customerLogin(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.customerLogin(body.email, body.password);

    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return result;
  }

  @Get('customer/me')
  @UseGuards(JwtAuthGuard)
  customerMe(@CurrentUser() user: any) {
    return user;
  }

  // ============ ADMIN: CUSTOMER MANAGEMENT ============

  @Get('customers/pending')
  @UseGuards(JwtAuthGuard, StaffGuard, RolesGuard)
  @Roles('ADMIN')
  getPendingCustomers() {
    return this.authService.getPendingCustomers();
  }

  @Post('customers/:id/approve')
  @UseGuards(JwtAuthGuard, StaffGuard, RolesGuard)
  @Roles('ADMIN')
  approveCustomer(@Param('id') id: string) {
    return this.authService.approveCustomer(id);
  }

  @Post('customers/:id/reject')
  @UseGuards(JwtAuthGuard, StaffGuard, RolesGuard)
  @Roles('ADMIN')
  rejectCustomer(@Param('id') id: string) {
    return this.authService.rejectCustomer(id);
  }
}
