import { Injectable, UnauthorizedException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailNotificationService } from '../communications/email-notification.service';
import { JwtPayload, Role, UserPreferences } from '@printforge/types';
import { mergePreferences, parsePreferencesPatch, storedPreferences } from './user-preferences';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private emailNotification: EmailNotificationService,
  ) {}

  // ============ STAFF AUTH ============

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }

  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role as Role,
      type: 'staff',
      jti: randomUUID(),
    };

    const token = this.jwtService.sign(payload);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        userType: 'staff' as const,
      },
    };
  }

  // ============ STAFF PREFERENCES ============

  /** The staff user's stored UI settings, reduced to the known keys ({} by default). */
  async getPreferences(userId: string): Promise<UserPreferences> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
    if (!user) throw new NotFoundException('User not found');
    return storedPreferences(user.preferences);
  }

  /** Merges an allowlisted patch into the stored settings; returns the merged settings. */
  async updatePreferences(userId: string, body: unknown): Promise<UserPreferences> {
    const patch = parsePreferencesPatch(body);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
    if (!user) throw new NotFoundException('User not found');
    const merged = mergePreferences(user.preferences, patch);
    await this.prisma.user.update({ where: { id: userId }, data: { preferences: merged as Prisma.InputJsonObject } });
    return storedPreferences(merged);
  }

  // ============ CUSTOMER AUTH ============

  async customerSignup(data: { name: string; email: string; phone?: string; password: string }) {
    const existing = await this.prisma.customer.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    const customer = await this.prisma.customer.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone || null,
        passwordHash,
        portalAccess: true,
        isApproved: false,
        isActive: true,
      },
    });

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      message: 'Account created. Awaiting admin approval.',
    };
  }

  async customerLogin(email: string, password: string) {
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer || !customer.passwordHash || !customer.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, customer.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!customer.isApproved) {
      throw new UnauthorizedException('Account pending admin approval');
    }

    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: JwtPayload = {
      sub: customer.id,
      email: customer.email!,
      role: 'VIEWER' as Role,
      type: 'customer',
      jti: randomUUID(),
    };

    const token = this.jwtService.sign(payload);

    return {
      token,
      user: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        isApproved: customer.isApproved,
        userType: 'customer' as const,
      },
    };
  }

  // ============ ADMIN: CUSTOMER MANAGEMENT ============

  async getPendingCustomers() {
    return this.prisma.customer.findMany({
      where: { isApproved: false, passwordHash: { not: null } },
      select: { id: true, name: true, email: true, phone: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');

    const updated = await this.prisma.customer.update({
      where: { id },
      data: { isApproved: true },
      select: { id: true, name: true, email: true, isApproved: true },
    });

    // Notify customer
    if (updated.email) {
      this.emailNotification.notifyCustomerApproved(updated.email, updated.name)
        .catch(err => this.logger.warn('Failed to send approval email: ' + err.message));
    }

    return updated;
  }

  async rejectCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Customer not found');

    return this.prisma.customer.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, name: true, email: true, isActive: true },
    });
  }
}
