import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

function fakePrisma() {
  return {
    attachment: {
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      findUnique: jest.fn(),
      delete: jest.fn(async ({ where }: any) => ({ id: where.id })),
    },
    productComponent: { findFirst: jest.fn(async () => null) },
    plateLayout: { findFirst: jest.fn(async () => null) },
    jobPlate: { findFirst: jest.fn(async () => null) },
    order: { findFirst: jest.fn(async () => null) },
    quote: { findFirst: jest.fn(async () => null) },
    designProject: { findFirst: jest.fn(async () => null) },
    invoice: { findFirst: jest.fn(async () => null) },
  };
}

const file = { originalname: 'a.pdf', mimetype: 'application/pdf', size: 3, buffer: Buffer.from('pdf') } as any;

describe('AttachmentsService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let svc: AttachmentsService;

  beforeEach(() => {
    prisma = fakePrisma();
    svc = new AttachmentsService(prisma as any);
  });

  describe('upload (A1)', () => {
    it.each(['product', 'Product', 'PRODUCT', ' product '])('refuses entityType %p', async (entityType) => {
      await expect(svc.upload(file, entityType, 'p1', 'u1')).rejects.toThrow(
        new BadRequestException('Upload product files from the product page'),
      );
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });
  });

  describe('remove (A2)', () => {
    it('refuses product attachments', async () => {
      prisma.attachment.findUnique.mockResolvedValue({ id: 'a1', entityType: 'Product', entityId: 'p1', storagePath: 'x' });
      await expect(svc.remove('a1')).rejects.toThrow(new BadRequestException('Manage product files from the product page'));
      expect(prisma.attachment.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['ProductComponent.attachmentId / thumbnailAttachmentId', 'productComponent'],
      ['PlateLayout.attachmentId', 'plateLayout'],
      ['JobPlate.attachmentId', 'jobPlate'],
    ] as const)('refuses an attachment referenced by %s (409)', async (_label, table) => {
      prisma.attachment.findUnique.mockResolvedValue({ id: 'a1', entityType: 'order', entityId: 'o1', storagePath: 'x' });
      (prisma[table].findFirst as jest.Mock).mockResolvedValue({ id: 'ref' });
      await expect(svc.remove('a1')).rejects.toThrow(new ConflictException('This file is used by a product or job'));
      expect(prisma.attachment.delete).not.toHaveBeenCalled();
    });

    it('checks both component columns', async () => {
      prisma.attachment.findUnique.mockResolvedValue({ id: 'a1', entityType: 'order', entityId: 'o1', storagePath: 'x' });
      await svc.remove('a1');
      expect(prisma.productComponent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { OR: [{ attachmentId: 'a1' }, { thumbnailAttachmentId: 'a1' }] } }),
      );
      expect(prisma.attachment.delete).toHaveBeenCalledWith({ where: { id: 'a1' } });
    });
  });

  describe('assertCanRead (unchanged customer behaviour)', () => {
    const customer = { id: 'c1', userType: 'customer', isApproved: true };

    it('allows a customer their own order file', async () => {
      prisma.attachment.findUnique.mockResolvedValue({ id: 'a1', entityType: 'order', entityId: 'o1' });
      prisma.order.findFirst.mockResolvedValue({ id: 'o1' } as any);
      await expect(svc.assertCanRead('a1', customer)).resolves.toMatchObject({ id: 'a1' });
      expect(prisma.order.findFirst).toHaveBeenCalledWith({ where: { id: 'o1', customerId: 'c1' }, select: { id: true } });
    });

    it('denies a customer a product file (403)', async () => {
      prisma.attachment.findUnique.mockResolvedValue({ id: 'a1', entityType: 'product', entityId: 'p1' });
      await expect(svc.assertCanRead('a1', customer)).rejects.toThrow(ForbiddenException);
    });

    it('staff read anything', async () => {
      prisma.attachment.findUnique.mockResolvedValue({ id: 'a1', entityType: 'product', entityId: 'p1' });
      await expect(svc.assertCanRead('a1', { userType: 'staff' })).resolves.toMatchObject({ id: 'a1' });
    });
  });

  describe('controller guards', () => {
    it('upload and delete require ADMIN/OPERATOR', () => {
      for (const m of ['upload', 'remove'] as const) {
        expect(Reflect.getMetadata(GUARDS_METADATA, AttachmentsController.prototype[m])).toContain(RolesGuard);
        expect(Reflect.getMetadata('roles', AttachmentsController.prototype[m])).toEqual(['ADMIN', 'OPERATOR']);
      }
    });
  });
});
