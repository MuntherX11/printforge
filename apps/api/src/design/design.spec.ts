import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import type { PrismaService } from '../common/prisma/prisma.service';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';

/**
 * The design-project chat and the customer's own design writes. Staff posts
 * and uploads are ADMIN/OPERATOR (VIEWER and ACCOUNTING could post a staff
 * message into a customer's chat), and every body is allowlisted and bounded.
 */

const PROJECT = {
  id: 'dp-1', projectNumber: 'DS-20260930-001', title: 'Logo plaque', customerId: 'cust-1', status: 'REVIEW',
  customer: { id: 'cust-1', name: 'Ali', email: 'ali@example.com', phone: null }, revisions: [], comments: [], attachments: [],
};

function setup() {
  const prisma = {
    designProject: {
      findUnique: jest.fn(async (a: any) => (a.where.id === PROJECT.id ? { ...PROJECT } : null)),
      count: jest.fn(async () => 0),
      create: jest.fn(async (a: any) => ({ id: 'dp-new', ...a.data, customer: { id: 'cust-1', name: 'Ali', email: null } })),
      update: jest.fn(async (a: any) => ({ id: a.where.id, ...a.data })),
    },
    designComment: { create: jest.fn(async (a: any) => ({ id: 'dc-1', ...a.data })) },
    attachment: {
      findMany: jest.fn(async (a: any) => (a.where.designProjectId === PROJECT.id ? a.where.id.in.filter((id: string) => id === 'att-1').map((id: string) => ({ id })) : [])),
    },
  };
  const email = {
    notifyAdminDesignRequested: jest.fn(async () => undefined),
    notifyAdminDesignFeedback: jest.fn(async () => undefined),
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
    expect(h.prisma.designProject.update).toHaveBeenCalledWith({ where: { id: PROJECT.id }, data: { status: 'REVISION' } });
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
