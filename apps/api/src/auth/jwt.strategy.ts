import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { TokenBlocklistService } from './token-blocklist.service';

function extractFromCookie(req: Request): string | null {
  if (req?.cookies?.token) {
    return req.cookies.token;
  }
  return null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private blocklist: TokenBlocklistService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        extractFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: config.get<string>('SECRET_KEY'),
    });
  }

  async validate(payload: { sub: string; email: string; role?: string; type?: string; jti?: string; exp?: number }) {
    if (payload.jti) {
      const blocked = await this.blocklist.isBlocked(payload.jti);
      if (blocked) throw new UnauthorizedException('Token has been revoked');
    }

    // Customer token
    if (payload.type === 'customer') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, phone: true, isApproved: true, isActive: true },
      });

      if (!customer || !customer.isActive) {
        throw new UnauthorizedException();
      }

      if (!customer.isApproved) {
        throw new UnauthorizedException('Account pending approval');
      }

      return {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        isApproved: customer.isApproved,
        userType: 'customer' as const,
      };
    }

    // Staff token (default for backward compatibility)
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException();
    }

    return {
      ...user,
      userType: 'staff' as const,
    };
  }
}
