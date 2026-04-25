import { PrismaService } from '../prisma/prisma.service';

export async function generateNumber(
  prisma: PrismaService,
  prefix: string,
  model: 'quote' | 'order' | 'invoice' | 'designProject',
): Promise<string> {
  const now = new Date();
  const omanOffset = 4 * 60; // UTC+4 in minutes
  const localDate = new Date(now.getTime() + omanOffset * 60 * 1000);
  const dateStr = localDate.toISOString().slice(0, 10).replace(/-/g, ''); // YYYY-MM-DD in Oman time (UTC+4)
  // NOTE: catch P2002 (unique constraint violation) at call sites and retry with generateNumber to handle TOCTOU races
  const pattern = `${prefix}-${dateStr}-`;

  let count: number;

  // Count existing records with this prefix today
  switch (model) {
    case 'quote':
      count = await prisma.quote.count({ where: { quoteNumber: { startsWith: pattern } } });
      break;
    case 'order':
      count = await prisma.order.count({ where: { orderNumber: { startsWith: pattern } } });
      break;
    case 'invoice':
      count = await prisma.invoice.count({ where: { invoiceNumber: { startsWith: pattern } } });
      break;
    case 'designProject':
      count = await prisma.designProject.count({ where: { projectNumber: { startsWith: pattern } } });
      break;
  }

  const seq = String(count + 1).padStart(3, '0');
  return `${pattern}${seq}`;
}
