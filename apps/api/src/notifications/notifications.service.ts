import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async create(params: {
    type: string;
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    userId?: string;
  }) {
    return this.prisma.notification.create({ data: params as any });
  }

  async findAll(userId?: string, unreadOnly = false) {
    const where: any = {};
    if (userId) where.userId = userId;
    if (unreadOnly) where.isRead = false;

    return this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markAsRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({ where: { id }, data: { isRead: true } });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async getUnreadCount(userId?: string) {
    return this.prisma.notification.count({
      where: { isRead: false, ...(userId ? { userId } : {}) },
    });
  }
}
