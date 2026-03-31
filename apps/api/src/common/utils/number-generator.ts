import { PrismaService } from '../prisma/prisma.service';

export async function generateNumber(
  prisma: PrismaService,
  prefix: string,
  model: 'quote' | 'order' | 'invoice' | 'designProject',
): Promise<string> {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
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
