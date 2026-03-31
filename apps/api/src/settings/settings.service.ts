import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async getAll() {
    const settings = await this.prisma.systemSetting.findMany();
    return Object.fromEntries(settings.map(s => [s.key, s.value]));
  }

  async get(key: string, defaultValue?: string): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    return setting?.value ?? defaultValue ?? '';
  }

  async set(key: string, value: string) {
    return this.prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  async setBulk(settings: Array<{ key: string; value: string }>) {
    const results = await Promise.all(
      settings.map(s => this.set(s.key, s.value)),
    );
    return results;
  }
}
