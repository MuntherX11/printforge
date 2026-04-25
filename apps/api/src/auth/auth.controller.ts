import { Controller, Post, Body, Res, Req, HttpCode, HttpStatus, Get, UseGuards, Param } from '@nestjs/common';
import { Response, Request } from 'express';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { TokenBlocklistService } from './token-blocklist.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { StaffGuard } from './guards/staff.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}

class CustomerSignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

class CustomerLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private jwtService: JwtService,
    private blocklist: TokenBlocklistService,
  ) {}

  // ============ STAFF AUTH ============

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60000, limit: 5 } }) // 5 login attempts per minute
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body.email, body.password);

    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
      maxAge: SESSION_MAX_AGE_MS,
    });

    return result;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw: string | undefined = req.cookies?.token;
    if (raw) {
      try {
        const decoded = this.jwtService.decode(raw) as { jti?: string; exp?: number } | null;
        if (decoded?.jti && decoded?.exp) {
          const ttl = decoded.exp - Math.floor(Date.now() / 1000);
          await this.blocklist.block(decoded.jti, ttl);
        }
      } catch { /* ignore decode errors — cookie may be malformed */ }
    }
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
    @Body() body: CustomerSignupDto,
  ) {
    return this.authService.customerSignup(body);
  }

  @Post('customer/login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { ttl: 60000, limit: 5 } }) // 5 login attempts per minute
  async customerLogin(
    @Body() body: CustomerLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.customerLogin(body.email, body.password);

    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
      maxAge: SESSION_MAX_AGE_MS,
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
