import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { DesignController } from './design.controller';
import { CUSTOMER_DESIGN_SELECT, DesignService } from './design.service';

/**
 * The design-project chat and the customer's own design writes. Staff posts
 * and uploads are ADMIN/OPERATOR (VIEWER and ACCOUNTING could post a staff
 * message into a customer's chat), and every body is allowlisted and bounded.
 */

const CREATED = new Date('2026-09-20T10:00:00Z');
const PROJECT = {
  id: 'dp-1', projectNumber: 'DS-20260930-001', title: 'Logo plaque', brief: 'Arabic name', budget: 20, customerId: 'cust-1', status: 'REVIEW',
  notes: 'Staff only: slow to pay', designFeeType: 'HOURLY', designFeeAmount: 5, designFeeHours: 3, totalDesignFee: 15, quotedPrice: null,
  estimatedDelivery: null, deadline: null, assignedToId: 'u-1', quoteId: null, createdAt: CREATED, updatedAt: CREATED,
  customer: { id: 'cust-1', name: 'Ali', email: 'ali@example.com', phone: null },
  assignedTo: { id: 'u-1', name: 'Sara' },
  revisions: [{ id: 'rev-1', projectId: 'dp-1', versionNumber: 1, description: 'First pass', internalNotes: 'used the cheap font', customerNotes: null, createdAt: CREATED }],
  comments: [{ id: 'dc-0', projectId: 'dp-1', revisionId: null, authorId: 'u-1', authorName: 'Sara', isCustomer: false, content: 'Hi', attachmentIds: [], createdAt: CREATED }],
  attachments: [{
    id: 'att-9', filename: '1-a.png', originalName: 'a.png', mimeType: 'image/png', sizeBytes: 10, storagePath: '2026/09/20/1-a.png',
    entityType: 'designProject', entityId: 'dp-1', uploadedById: 'u-1', designProjectId: 'dp-1', createdAt: CREATED,
  }],
  quote: null,
};

/**
 * Attachments as POST /attachments stores them: linked by entityType and
 * entityId, with designProjectId never written.
 */
const ATTACHMENTS = [
  { id: 'att-1', entityType: 'designProject', entityId: 'dp-1', designProjectId: null },
  { id: 'att-2', entityType: 'DESIGN_PROJECT', entityId: 'dp-1', designProjectId: null },
  { id: 'att-order', entityType: 'order', entityId: 'dp-1', designProjectId: null },
  { id: 'att-other-project', entityType: 'designProject', entityId: 'dp-2', designProjectId: null },
];

const USERS = [
  { id: 'u-1', role: 'OPERATOR', isActive: true },
  { id: 'u-admin', role: 'ADMIN', isActive: true },
  { id: 'u-viewer', role: 'VIEWER', isActive: true },
  { id: 'u-acc', role: 'ACCOUNTING', isActive: true },
  { id: 'u-gone', role: 'OPERATOR', isActive: false },
];

const clone = (v: any): any => (Array.isArray(v) ? v.map(clone)
  : v instanceof Date ? new Date(v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  : v);

/** Prisma's `select`, enough for these tests: true copies, `{ select }` recurses (lists too). */
function applySelect(row: any, select: any): any {
  if (!select || row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map((r) => applySelect(r, select));
  const out: any = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object') out[k] = applySelect(row[k], (v as any).select);
  }
  return out;
}

/** A Prisma `where` of plain equalities, `{ in }` and `OR`. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'OR') return v.some((w: any) => matches(row, w));
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

function setup() {
  const prisma = {
    designProject: {
      findUnique: jest.fn(async (a: any) => (a.where.id === PROJECT.id ? applySelect(clone(PROJECT), a.select) : null)),
      count: jest.fn(async () => 0),
      create: jest.fn(async (a: any) => ({ id: 'dp-new', ...a.data, customer: { id: 'cust-1', name: 'Ali', email: null } })),
      update: jest.fn(async (a: any) => ({ id: a.where.id, ...a.data })),
    },
    designComment: {
      create: jest.fn(async (a: any) => ({ id: 'dc-1', ...a.data })),
      findMany: jest.fn(async (a: any) => applySelect(clone(PROJECT.comments), a.select)),
    },
    designRevision: { create: jest.fn(async (a: any) => ({ id: 'rev-new', ...a.data })) },
    attachment: {
      findMany: jest.fn(async (a: any) => applySelect(ATTACHMENTS.filter((r) => matches(r, a.where)), a.select)),
    },
    user: {
      findUnique: jest.fn(async (a: any) => applySelect(USERS.find((u) => u.id === a.where.id) ?? null, a.select)),
    },
  };
  const email = {
    notifyAdminDesignRequested: jest.fn(async () => undefined),
    notifyAdminDesignFeedback: jest.fn(async () => undefined),
    notifyCustomerDesignUploaded: jest.fn(async () => undefined),
  };
  const svc = new DesignService(prisma as unknown as PrismaService, email as any);
  return { prisma, email, svc };
}

async function badRequestOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).message;
}

const staff = { id: 'u-1', name: 'Sara', isCustomer: false };

describe('POST /design-projects/:id/comments', () => {
  it.each<[string, Record<string, unknown>]>([
    ['isCustomer', { isCustomer: true }],
    ['authorName', { authorName: 'Ali' }],
    ['projectId', { projectId: 'dp-other' }],
    ['revision', { revision: { connect: { id: 'rev-1' } } }],
  ])('%s → 400 and nothing is posted', async (_label, extra) => {
    const h = setup();
    expect(await badRequestOf(h.svc.addComment(PROJECT.id, { content: 'hi', ...extra }, staff))).toBe(`property ${Object.keys(extra)[0]} should not exist`);
    expect(h.prisma.designComment.create).not.toHaveBeenCalled();
  });

  it.each<[unknown, string]>([
    [{}, 'Message is required'],
    [{ content: '   ' }, 'Message is required'],
    [{ content: { set: 'x' } }, 'Message must be text'],
    [{ content: 'x'.repeat(5001) }, 'Message must be at most 5000 characters'],
    [{ content: 'hi', attachmentIds: 'att-1' }, 'attachmentIds must be a list of at most 10 ids'],
    [{ content: 'hi', attachmentIds: Array.from({ length: 11 }, (_, i) => `att-${i}`) }, 'attachmentIds must be a list of at most 10 ids'],
    [{ content: 'hi', attachmentIds: [7] }, 'attachmentIds[0] must be an id'],
    [{ content: 'hi', attachmentIds: ['att-1', 'att-1'] }, 'attachmentIds must not repeat'],
    [{ content: 'hi', attachmentIds: ['att-other-project'] }, 'Attachment not found on this project'],
    [{ content: 'hi', attachmentIds: ['att-order'] }, 'Attachment not found on this project'],
    [{ content: 'hi', attachmentIds: ['att-1', 'att-nope'] }, 'Attachment not found on this project'],
  ])('%j → 400 %s', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.addComment(PROJECT.id, body, staff))).toBe(message);
    expect(h.prisma.designComment.create).not.toHaveBeenCalled();
  });

  it('what both chat screens send still posts, trimmed, with checked attachments', async () => {
    const h = setup();
    await h.svc.addComment(PROJECT.id, { content: '  Looks good  ' }, staff);
    expect(h.prisma.designComment.create).toHaveBeenLastCalledWith({ data: {
      projectId: PROJECT.id, authorId: 'u-1', authorName: 'Sara', isCustomer: false, content: 'Looks good', attachmentIds: [],
    } });
    await h.svc.addComment(PROJECT.id, { content: 'See file', attachmentIds: ['att-1'] }, { id: 'cust-1', name: 'Ali', isCustomer: true });
    expect(h.prisma.designComment.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ isCustomer: true, attachmentIds: ['att-1'] }) });
  });

  it('an attachment stored the way POST /attachments stores it (entityType/entityId, any case) can be referenced', async () => {
    const h = setup();
    await h.svc.addComment(PROJECT.id, { content: 'Both files', attachmentIds: ['att-1', 'att-2'] }, staff);
    expect(h.prisma.designComment.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ attachmentIds: ['att-1', 'att-2'] }) });
  });

  it("a customer still can't post in another customer's project", async () => {
    const h = setup();
    await expect(h.svc.addComment(PROJECT.id, { content: 'hi' }, { id: 'cust-2', name: 'Eve', isCustomer: true })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.designComment.create).not.toHaveBeenCalled();
  });

  describe('who may post', () => {
    const post = (user: Record<string, unknown>) => {
      const designService = { addComment: jest.fn(async () => ({ id: 'dc-1' })) };
      const c = new DesignController(designService as any);
      let error: unknown = null;
      try {
        c.addComment(PROJECT.id, { content: 'hi' }, user);
      } catch (e) {
        error = e;
      }
      return { designService, error };
    };

    it.each(['VIEWER', 'ACCOUNTING', undefined])('staff role %s → 403, nothing posted', (role) => {
      const { designService, error } = post({ id: 'u-1', name: 'Sara', userType: 'staff', role });
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(designService.addComment).not.toHaveBeenCalled();
    });

    it.each(['ADMIN', 'OPERATOR'])('staff role %s posts as staff', (role) => {
      const { designService, error } = post({ id: 'u-1', name: 'Sara', userType: 'staff', role });
      expect(error).toBeNull();
      expect(designService.addComment).toHaveBeenCalledWith(PROJECT.id, { content: 'hi' }, { id: 'u-1', name: 'Sara', isCustomer: false });
    });

    it('the customer posts as the customer (the service checks the project is theirs)', () => {
      const { designService, error } = post({ id: 'cust-1', name: 'Ali', userType: 'customer' });
      expect(error).toBeNull();
      expect(designService.addComment).toHaveBeenCalledWith(PROJECT.id, { content: 'hi' }, { id: 'cust-1', name: 'Ali', isCustomer: true });
    });
  });
});

describe('POST /design-projects/customer/create', () => {
  it.each<[unknown, string]>([
    [{ title: 'Plaque', status: 'APPROVED' }, 'property status should not exist'],
    [{ title: 'Plaque', customerId: 'cust-2' }, 'property customerId should not exist'],
    [{ title: 'Plaque', totalDesignFee: 0 }, 'property totalDesignFee should not exist'],
    [{ title: '  ' }, 'Title is required'],
    [{ title: 'x'.repeat(201) }, 'Title must be at most 200 characters'],
    [{ title: 'Plaque', brief: 'x'.repeat(5001) }, 'Brief must be at most 5000 characters'],
    [{ title: 'Plaque', budget: -5 }, '"budget" must be between 0 and 1000000'],
    [{ title: 'Plaque', budget: 'lots' }, '"budget" must be a number'],
    [{ title: 'Plaque', budget: 1e12 }, '"budget" must be between 0 and 1000000'],
  ])('%j → 400 %s, no project', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.create(body, 'cust-1'))).toBe(message);
    expect(h.prisma.designProject.create).not.toHaveBeenCalled();
  });

  it('what the New Design Request page sends still saves, for the caller', async () => {
    const h = setup();
    await h.svc.create({ title: ' Logo plaque ', brief: 'Arabic name', budget: 12.5 }, 'cust-1');
    expect(h.prisma.designProject.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ customerId: 'cust-1', title: 'Logo plaque', brief: 'Arabic name', budget: 12.5, status: 'REQUESTED' }),
    }));
    await h.svc.create({ title: 'Keychain' }, 'cust-1');
    expect(h.prisma.designProject.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ title: 'Keychain', brief: null, budget: null }),
    }));
  });
});

describe('POST /design-projects/customer/:id/request-changes', () => {
  it.each<[unknown, string]>([
    [{}, 'Feedback is required'],
    [{ feedback: '' }, 'Feedback is required'],
    [{ feedback: ['a'] }, 'Feedback must be text'],
    [{ feedback: 'x'.repeat(5001) }, 'Feedback must be at most 5000 characters'],
    [{ feedback: 'ok', status: 'APPROVED' }, 'property status should not exist'],
  ])('%j → 400 %s; no comment, no status change, no email', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.customerRequestChanges(PROJECT.id, 'cust-1', body))).toBe(message);
    expect(h.prisma.designComment.create).not.toHaveBeenCalled();
    expect(h.prisma.designProject.update).not.toHaveBeenCalled();
    expect(h.email.notifyAdminDesignFeedback).not.toHaveBeenCalled();
  });

  it('valid feedback is posted, moves the project to REVISION and is emailed as sent', async () => {
    const h = setup();
    await h.svc.customerRequestChanges(PROJECT.id, 'cust-1', { feedback: ' Bigger letters ' });
    expect(h.prisma.designComment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ content: 'Bigger letters', isCustomer: true }) });
    expect(h.prisma.designProject.update).toHaveBeenCalledWith({ where: { id: PROJECT.id }, data: { status: 'REVISION' }, select: CUSTOMER_DESIGN_SELECT });
    expect(h.email.notifyAdminDesignFeedback).toHaveBeenCalledWith(expect.objectContaining({ feedback: 'Bigger letters' }));
  });
});

describe('POST /design-projects/:id/upload', () => {
  it('is ADMIN/OPERATOR', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);
    const handler = DesignController.prototype.uploadFile;
    expect(reflector.get(GUARDS_METADATA, handler)).toEqual([StaffGuard, RolesGuard]);
    expect(reflector.get(ROLES_KEY, handler)).toEqual(['ADMIN', 'OPERATOR']);
    const ctx = (role: string) => ({
      getHandler: () => handler, getClass: () => DesignController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role, userType: 'staff' } }) }),
    }) as any;
    for (const [role, ok] of [['VIEWER', false], ['ACCOUNTING', false], ['OPERATOR', true], ['ADMIN', true]] as const) {
      expect(guard.canActivate(ctx(role))).toBe(ok);
    }
  });

  it('an unknown project → 404 before anything is written; a bad type → 400, not 500', async () => {
    const h = setup();
    const c = new DesignController(h.svc);
    // The controller require()s fs, so spy on that module object (the ES namespace import is read-only).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsModule: typeof import('fs') = require('fs');
    const write = jest.spyOn(fsModule, 'writeFileSync').mockImplementation(() => undefined);
    const mkdir = jest.spyOn(fsModule, 'mkdirSync').mockImplementation(() => undefined);
    try {
      const file = { originalname: 'part.stl', mimetype: 'model/stl', size: 10, buffer: Buffer.from('solid') } as any;
      await expect(c.uploadFile('dp-nope', file)).rejects.toBeInstanceOf(NotFoundException);
      await expect(c.uploadFile(PROJECT.id, { ...file, originalname: 'x.exe' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(c.uploadFile(PROJECT.id, undefined as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(write).not.toHaveBeenCalled();
      await expect(c.uploadFile(PROJECT.id, file)).resolves.toMatchObject({ originalName: 'part.stl', mimeType: 'model/stl' });
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
      mkdir.mockRestore();
    }
  });
});

/**
 * PATCH /design-projects/:id used to write UpdateDesignProjectDto (an
 * interface) to Prisma as sent: an object fee ran as an atomic update, fees
 * had no bounds, a bad status or date was a 500, notes had no length limit,
 * and an OPERATOR could reassign the project with assignedToId although
 * POST /:id/assign is ADMIN-only.
 */
describe('PATCH /design-projects/:id', () => {
  it.each<[Record<string, unknown>, string]>([
    [{ designFeeAmount: { multiply: -1 } }, '"designFeeAmount" must be a number'],
    [{ designFeeHours: { increment: 5 } }, '"designFeeHours" must be a number'],
    [{ designFeeAmount: -1 }, '"designFeeAmount" must be between 0 and 1000000'],
    [{ designFeeAmount: 1e300 }, '"designFeeAmount" must be between 0 and 1000000'],
    [{ designFeeAmount: 'lots' }, '"designFeeAmount" must be a number'],
    [{ designFeeHours: 20_000 }, '"designFeeHours" must be between 0 and 10000'],
    [{ designFeeAmount: 1000, designFeeHours: 2000 }, 'The design fee (rate × hours) must be at most 1000000'],
    [{ designFeeType: 'hourly' }, '"designFeeType" must be one of: FLAT, HOURLY'],
    [{ status: 'BOGUS' }, '"status" must be one of: REQUESTED, ASSIGNED, IN_PROGRESS, REVIEW, REVISION, APPROVED, QUOTED, IN_PRODUCTION, COMPLETED, CANCELLED'],
    [{ estimatedDelivery: 'x' }, 'estimatedDelivery must be a date'],
    [{ estimatedDelivery: 1_700_000_000_000 }, 'estimatedDelivery must be a date'],
    [{ estimatedDelivery: '+275760-09-13' }, 'estimatedDelivery must be a date'],
    [{ notes: 'x'.repeat(5001) }, 'Notes must be at most 5000 characters'],
    [{ notes: { set: 'x' } }, 'Notes must be text'],
    [{ assignedToId: 'u-admin' }, 'property assignedToId should not exist'],
    [{ totalDesignFee: 0 }, 'property totalDesignFee should not exist'],
    [{ customerId: 'cust-2' }, 'property customerId should not exist'],
    [{ comments: { deleteMany: {} } }, 'property comments should not exist'],
  ])('%j → 400 %s, nothing written', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.update(PROJECT.id, body))).toBe(message);
    expect(h.prisma.designProject.update).not.toHaveBeenCalled();
  });

  it('an unknown project → 404', async () => {
    const h = setup();
    await expect(h.svc.update('dp-nope', { status: 'IN_PROGRESS' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.designProject.update).not.toHaveBeenCalled();
  });

  it('what the staff design page sends still saves', async () => {
    const h = setup();
    const dataOf = () => {
      const calls = h.prisma.designProject.update.mock.calls;
      return calls[calls.length - 1][0].data;
    };

    // The status buttons.
    await h.svc.update(PROJECT.id, { status: 'IN_PROGRESS' });
    expect(dataOf()).toEqual({ status: 'IN_PROGRESS' });

    // The fee form, hourly: the total is rate × hours.
    await h.svc.update(PROJECT.id, { designFeeType: 'HOURLY', designFeeAmount: 5, designFeeHours: 3, estimatedDelivery: '2026-10-15' });
    expect(dataOf()).toEqual({
      designFeeType: 'HOURLY', designFeeAmount: 5, designFeeHours: 3, totalDesignFee: 15, estimatedDelivery: new Date('2026-10-15'),
    });

    // The fee form, flat, with the hours and date left blank (sent as undefined).
    await h.svc.update(PROJECT.id, { designFeeType: 'FLAT', designFeeAmount: 12.5, designFeeHours: undefined, estimatedDelivery: undefined });
    expect(dataOf()).toEqual({ designFeeType: 'FLAT', designFeeAmount: 12.5, totalDesignFee: 12.5 });

    // A blank amount is sent as 0.
    await h.svc.update(PROJECT.id, { designFeeType: 'FLAT', designFeeAmount: 0 });
    expect(dataOf()).toEqual({ designFeeType: 'FLAT', designFeeAmount: 0, totalDesignFee: 0 });

    // Notes are trimmed; null clears them and the delivery date.
    await h.svc.update(PROJECT.id, { notes: '  Call first  ' });
    expect(dataOf()).toEqual({ notes: 'Call first' });
    await h.svc.update(PROJECT.id, { notes: null, estimatedDelivery: null });
    expect(dataOf()).toEqual({ notes: null, estimatedDelivery: null });
  });

  it('stays ADMIN/OPERATOR, like the other staff design writes', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, DesignController.prototype.update)).toEqual([StaffGuard, RolesGuard]);
    expect(reflector.get(ROLES_KEY, DesignController.prototype.update)).toEqual(['ADMIN', 'OPERATOR']);
  });
});

describe('POST /design-projects/:id/assign', () => {
  it.each<[unknown, string]>([
    [{}, '"userId" must be an id'],
    [{ userId: 7 }, '"userId" must be an id'],
    [{ userId: { connect: { id: 'u-1' } } }, '"userId" must be an id'],
    [{ userId: 'u-1', status: 'APPROVED' }, 'property status should not exist'],
    [{ userId: 'u-viewer' }, 'A design project can only be assigned to an active ADMIN or OPERATOR user'],
    [{ userId: 'u-acc' }, 'A design project can only be assigned to an active ADMIN or OPERATOR user'],
    [{ userId: 'u-gone' }, 'A design project can only be assigned to an active ADMIN or OPERATOR user'],
  ])('%j → 400 %s, nothing written', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.assign(PROJECT.id, body))).toBe(message);
    expect(h.prisma.designProject.update).not.toHaveBeenCalled();
  });

  it('an unknown user → 404, not a foreign-key 500', async () => {
    const h = setup();
    await expect(h.svc.assign(PROJECT.id, { userId: 'u-nope' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.designProject.update).not.toHaveBeenCalled();
  });

  it('an active ADMIN or OPERATOR is assigned, as the staff page sends it', async () => {
    const h = setup();
    for (const userId of ['u-1', 'u-admin']) {
      await h.svc.assign(PROJECT.id, { userId });
      expect(h.prisma.designProject.update).toHaveBeenLastCalledWith(expect.objectContaining({
        where: { id: PROJECT.id }, data: { assignedToId: userId, status: 'REVIEW' },
      }));
    }
  });

  it('stays ADMIN-only', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, DesignController.prototype.assign)).toEqual(['ADMIN']);
  });
});

describe('POST /design-projects/:id/revisions', () => {
  it.each<[unknown, string]>([
    [{ description: 'x'.repeat(5001) }, 'Description must be at most 5000 characters'],
    [{ internalNotes: 'x'.repeat(5001) }, 'Internal notes must be at most 5000 characters'],
    [{ internalNotes: 5 }, 'Internal notes must be text'],
    [{ description: ['a'] }, 'Description must be text'],
    [{ versionNumber: 99 }, 'property versionNumber should not exist'],
    [{ projectId: 'dp-2' }, 'property projectId should not exist'],
  ])('%j → 400 %s, no revision, no status change, no email', async (body, message) => {
    const h = setup();
    expect(await badRequestOf(h.svc.addRevision(PROJECT.id, body))).toBe(message);
    expect(h.prisma.designRevision.create).not.toHaveBeenCalled();
    expect(h.prisma.designProject.update).not.toHaveBeenCalled();
    expect(h.email.notifyCustomerDesignUploaded).not.toHaveBeenCalled();
  });

  it('what the staff page sends still adds the next revision and moves the project to REVIEW', async () => {
    const h = setup();
    await h.svc.addRevision(PROJECT.id, { description: ' New revision ' });
    expect(h.prisma.designRevision.create).toHaveBeenCalledWith({ data: {
      projectId: PROJECT.id, versionNumber: 2, description: 'New revision', internalNotes: null,
    } });
    expect(h.prisma.designProject.update).toHaveBeenCalledWith({ where: { id: PROJECT.id }, data: { status: 'REVIEW' } });
    await h.svc.addRevision(PROJECT.id, {});
    expect(h.prisma.designRevision.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ description: 'Revision 2' }) });
  });
});

/**
 * GET /design-projects/:id used to answer the customer with the whole project:
 * the staff notes, the fee rate and hours, every revision's internal notes and
 * the raw attachment rows. Approve and request-changes answered with the whole
 * row too.
 */
describe("the customer's view of their design project", () => {
  const customer = { userId: 'cust-1', userType: 'customer' };

  it('leaves out staff notes, fee workings, internal revision notes and attachment storage', async () => {
    const h = setup();
    const out: any = await h.svc.findOne(PROJECT.id, customer);
    expect(out).toMatchObject({
      id: 'dp-1', projectNumber: PROJECT.projectNumber, title: 'Logo plaque', brief: 'Arabic name', status: 'REVIEW', totalDesignFee: 15,
      assignedTo: { id: 'u-1', name: 'Sara' },
    });
    for (const key of ['notes', 'designFeeAmount', 'designFeeHours', 'customer', 'assignedToId']) expect(out).not.toHaveProperty(key);
    expect(out.revisions).toEqual([{ id: 'rev-1', versionNumber: 1, description: 'First pass', customerNotes: null, createdAt: CREATED }]);
    expect(out.comments).toEqual([{ id: 'dc-0', revisionId: null, authorName: 'Sara', isCustomer: false, content: 'Hi', attachmentIds: [], createdAt: CREATED }]);
    expect(out.attachments).toEqual([{ id: 'att-9', originalName: 'a.png', mimeType: 'image/png', sizeBytes: 10, createdAt: CREATED }]);
    // The chat list the same way.
    expect(await h.svc.getComments(PROJECT.id, customer)).toEqual(out.comments);
  });

  it('staff still get the whole project', async () => {
    const h = setup();
    const out: any = await h.svc.findOne(PROJECT.id, { userId: 'u-1', userType: 'staff' });
    expect(out).toMatchObject({ notes: 'Staff only: slow to pay', designFeeAmount: 5, customer: { email: 'ali@example.com' } });
    expect(out.revisions[0].internalNotes).toBe('used the cheap font');
  });

  it("another customer's project → 403", async () => {
    const h = setup();
    await expect(h.svc.findOne(PROJECT.id, { userId: 'cust-2', userType: 'customer' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.svc.findOne('dp-nope', customer)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('approve answers with the customer view', async () => {
    const h = setup();
    await h.svc.customerApprove(PROJECT.id, 'cust-1');
    expect(h.prisma.designProject.update).toHaveBeenCalledWith({ where: { id: PROJECT.id }, data: { status: 'APPROVED' }, select: CUSTOMER_DESIGN_SELECT });
  });
});
