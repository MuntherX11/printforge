import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class LowStockProcessor {
  private readonly logger = new Logger(LowStockProcessor.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Check all materials for low stock and create notifications.
   * Low stock = total currentWeight across active spools < material.reorderPoint.
   */
  async checkLowStock() {
    const materials = await this.prisma.material.findMany({
      include: {
        spools: {
          where: { isActive: true },
          select: { currentWeight: true },
        },
      },
    });

    let alertCount = 0;

    for (const mat of materials) {
      const totalWeight = mat.spools.reduce((sum, s) => sum + s.currentWeight, 0);

      if (totalWeight < mat.reorderPoint) {
        // Check if we already sent an alert recently (within 24h)
        const recentAlert = await this.prisma.notification.findFirst({
          where: {
            type: 'LOW_STOCK',
            entityType: 'material',
            entityId: mat.id,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });

        if (!recentAlert) {
          await this.notifications.create({
            type: 'LOW_STOCK',
            title: `Low Stock: ${mat.name}`,
            message: `${mat.name} (${mat.color || 'no color'}) has ${totalWeight.toFixed(0)}g remaining, below reorder point of ${mat.reorderPoint}g`,
            entityType: 'material',
            entityId: mat.id,
          });
          alertCount++;
          this.logger.log(`Low stock alert: ${mat.name} — ${totalWeight.toFixed(0)}g < ${mat.reorderPoint}g`);
        }
      }
    }

    const partResult = await this.checkLowStockParts();

    return {
      checked: materials.length + partResult.checked,
      alerts: alertCount + partResult.alerts,
    };
  }

  /**
   * Check non-printed parts (NFC tags, inserts, keyrings…) for low stock.
   * Low stock = stockQty <= reorderPoint. reorderPoint 0 means "not tracked".
   */
  private async checkLowStockParts() {
    const parts = await this.prisma.part.findMany({
      where: { isActive: true, reorderPoint: { gt: 0 } },
    });

    let alerts = 0;

    for (const part of parts) {
      if (part.stockQty > part.reorderPoint) continue;

      // Don't re-alert on the same part within 24h
      const recentAlert = await this.prisma.notification.findFirst({
        where: {
          type: 'LOW_STOCK',
          entityType: 'part',
          entityId: part.id,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (recentAlert) continue;

      await this.notifications.create({
        type: 'LOW_STOCK',
        title: `Low Stock: ${part.name}`,
        message: `${part.name} has ${part.stockQty} left, at or below the reorder point of ${part.reorderPoint}`,
        entityType: 'part',
        entityId: part.id,
      });
      alerts++;
      this.logger.log(`Low stock alert (part): ${part.name} — ${part.stockQty} <= ${part.reorderPoint}`);
    }

    return { checked: parts.length, alerts };
  }
}
