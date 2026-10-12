import { Controller, Post, Patch, Body, Res, Req, HttpCode, HttpStatus, Get, UseGuards, Param, Logger } from '@nestjs/common';
import { Response, Request } from 'express';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import type { UserPreferences } from '@printforge/types';
import { AuthService } from './auth.service';
import { TokenBlocklistService } from './token-blocklist.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { StaffGuard } from './guards/staff.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// COOKIE_SECURE explicitly overrides; NODE_ENV=production is the fallback.
// Using || would make COOKIE_SECURE=false a no-op when NODE_ENV=production.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

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
  private readonly logger = new Logger(AuthController.name);
  /** The preferences fallback is logged once per process, not on every page load. */
  private preferencesWarned = false;

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
      secure: COOKIE_SECURE,
      maxAge: SESSION_MAX_AGE_MS,
    });

    return { user: result.user };
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
  async me(@CurrentUser() user: any) {
    // Customers share this route (the customer portal reads it); only staff carry preferences.
    if (user?.userType !== 'staff') return user;
    // The session must survive preferences that cannot be read (the column
    // may not exist yet while a deploy is between the code and the schema):
    // the defaults then, never a 500 that signs everyone out of the app.
    let preferences: UserPreferences = {};
    try {
      preferences = await this.authService.getPreferences(user.id);
    } catch (e) {
      if (!this.preferencesWarned) {
        this.preferencesWarned = true;
        this.logger.warn(`Could not load user preferences, using the defaults: ${(e as Error)?.message}`);
      }
    }
    return { ...user, preferences };
  }

  /**
   * The signed-in staff user's own UI settings, so every staff role may write
   * them (VIEWER included). The body is an interface, so it is allowlisted in
   * the service (allowedBody) rather than by the ValidationPipe.
   */
  @Patch('me/preferences')
  @UseGuards(JwtAuthGuard, StaffGuard)
  updateMyPreferences(@CurrentUser() user: { id: string }, @Body() body: unknown): Promise<UserPreferences> {
    return this.authService.updatePreferences(user.id, body);
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
      secure: COOKIE_SECURE,
      maxAge: SESSION_MAX_AGE_MS,
    });

    return { user: result.user };
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
