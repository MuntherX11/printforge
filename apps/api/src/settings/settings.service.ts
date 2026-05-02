import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisCacheService } from '../common/redis/redis-cache.service';

// ARCH-08: cache TTL for settings — 5 minutes balances freshness vs DB load
const SETTINGS_TTL_S = 300;

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private cache: RedisCacheService,
  ) {}

  async getAll() {
    return this.cache.getOrSet<Record<string, string>>('settings:all', SETTINGS_TTL_S, async () => {
      const settings = await this.prisma.systemSetting.findMany();
      return Object.fromEntries(settings.map(s => [s.key, s.value]));
    });
  }

  async get(key: string, defaultValue?: string): Promise<string> {
    const value = await this.cache.getOrSet<string | null>(
      `settings:${key}`,
      SETTINGS_TTL_S,
      async () => {
        const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
        return setting?.value ?? null; // null = "key absent" — distinguishable from ''
      },
    );
    return value ?? defaultValue ?? '';
  }

  async set(key: string, value: string) {
    const result = await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    // Invalidate both the per-key entry and the full-map cache
    await Promise.all([
      this.cache.invalidate(`settings:${key}`),
      this.cache.invalidate('settings:all'),
    ]);
    return result;
  }

  async setBulk(settings: Array<{ key: string; value: string }>) {
    const ALLOWED_KEYS = new Set([
      'currency', 'tax_rate', 'overhead_percent', 'purge_waste_grams',
      'default_infill_percent', 'company_name', 'company_address', 'company_phone',
      'company_email', 'default_margin_percent', 'bank_details', 'invoice_notes',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
      'whatsapp_template', 'electricity_rate_kwh', 'markup_multiplier',
      'machine_hourly_rate', 'admin_email', 'design_fee_default',
      'quote_validity_days', 'locale', 'date_format', 'currency_decimals',
    ]);
    const invalid = settings.filter(s => !ALLOWED_KEYS.has(s.key));
    if (invalid.length > 0) {
      throw new BadRequestException(`Unknown settings keys: ${invalid.map(s => s.key).join(', ')}`);
    }
    const results = await Promise.all(
      settings.map(s => this.set(s.key, s.value)),
    );
    return results;
  }
}
