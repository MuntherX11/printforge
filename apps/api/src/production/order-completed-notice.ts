import type { PrismaService } from '../common/prisma/prisma.service';
import type { EmailNotificationService } from '../communications/email-notification.service';
import type { WhatsAppService } from '../communications/whatsapp.service';
import { STAFF_CUSTOMER_SELECT } from '../orders/orders.service';
import type { SettingsService } from '../settings/settings.service';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Minimal shape of a customer row returned via Prisma include. */
interface CustomerRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

/**
 * J6, after commit: tell the customer their order is complete once every job
 * of it is terminal. Never for a cancelled order (v2.17.2): its running jobs
 * can still finish after the cancel.
 */
export async function notifyOrderCompletedIfAllDone(
  deps: { prisma: PrismaService; settings?: SettingsService; email?: EmailNotificationService; whatsapp?: WhatsAppService },
  orderId: string,
) {
  const allJobs = await deps.prisma.productionJob.findMany({
    where: { orderId },
    select: { status: true },
  });

  const allDone = allJobs.length > 0 && allJobs.every((j) => TERMINAL.includes(j.status));
  if (!allDone) return;

  const order = await deps.prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: { select: STAFF_CUSTOMER_SELECT } },
  });
  if (!order || order.status === 'CANCELLED') return;

  const notifyEnabled = await deps.settings?.get('notify_order_completed', 'true') ?? 'true';
  if (notifyEnabled === 'false') return;

  const companyName = await deps.settings?.get('company_name', 'PrintForge') ?? 'PrintForge';
  const customer = order.customer as CustomerRecord | null;

  if (customer?.email) {
    deps.email?.notifyCustomerOrderCompleted(customer.email, { orderNumber: order.orderNumber }).catch(() => {});
  }
  if (customer?.phone) {
    deps.whatsapp?.sendOrderCompleted(customer.phone, { customerName: customer.name, orderNumber: order.orderNumber, companyName }).catch(() => {});
  }
}
