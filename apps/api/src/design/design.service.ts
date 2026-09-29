import { Injectable, NotFoundException, BadRequestException, ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailNotificationService } from '../communications/email-notification.service';
import { isDesignProjectEntity } from '../attachments/attachments.service';
import { generateNumber } from '../common/utils/number-generator';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';
import {
  parseDesignAssign, parseDesignComment, parseDesignFeedback, parseDesignPatch, parseDesignRequest, parseDesignRevision,
} from './design-input';

/**
 * Staff roles that may write in a design project: post in its chat, upload
 * files, add revisions and change it. They are the roles the Design Center
 * sidebar shows. VIEWER and ACCOUNTING can read a project but not post in the
 * customer's chat. They are also the roles a project can be assigned to.
 */
export const DESIGN_STAFF_WRITE_ROLES = ['ADMIN', 'OPERATOR'] as const;

/**
 * What a customer gets back for their own design project: GET
 * /design-projects/:id, and the approve and request-changes answers. Never the
 * staff notes, the fee rate and hours behind the total, a revision's internal
 * notes, a staff author's user id, or the attachment rows' storage paths and
 * uploader. The customer's design page reads only these fields.
 */
export const CUSTOMER_DESIGN_SELECT = {
  id: true,
  projectNumber: true,
  status: true,
  title: true,
  brief: true,
  budget: true,
  totalDesignFee: true,
  estimatedDelivery: true,
  deadline: true,
  createdAt: true,
  updatedAt: true,
  assignedTo: { select: { id: true, name: true } },
  comments: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, revisionId: true, authorName: true, isCustomer: true, content: true, attachmentIds: true, createdAt: true },
  },
  revisions: {
    orderBy: { versionNumber: 'desc' },
    select: { id: true, versionNumber: true, description: true, customerNotes: true, createdAt: true },
  },
  attachments: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true } },
  quote: { select: { id: true, quoteNumber: true, total: true, status: true } },
} satisfies Prisma.DesignProjectSelect;

@Injectable()
export class DesignService {
  private readonly logger = new Logger(DesignService.name);

  constructor(
    private prisma: PrismaService,
    private emailNotification: EmailNotificationService,
  ) {}

  // ============ ACCESS CONTROL ============

  async verifyAccess(projectId: string, userId: string, userType: string) {
    if (userType === 'staff') return; // staff can access any project
    const project = await this.prisma.designProject.findUnique({
      where: { id: projectId },
      select: { customerId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (project.customerId !== userId) throw new ForbiddenException('Access denied');
  }

  // ============ PROJECTS ============

  /** POST /design-projects/customer/create; the body is parsed by parseDesignRequest. */
  async create(body: unknown, customerId: string) {
    const dto = parseDesignRequest(body);
    let projectNumber: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        projectNumber = await generateNumber(this.prisma, 'DS', 'designProject');
        break;
      } catch (e: any) {
        if (e.code !== 'P2002' || attempt === 4) throw e;
      }
    }
    if (!projectNumber) throw new InternalServerErrorException('Failed to generate unique document number');

    const project = await this.prisma.designProject.create({
      data: {
        projectNumber,
        customerId,
        title: dto.title,
        brief: dto.brief,
        budget: dto.budget,
        status: 'REQUESTED',
      },
      include: { customer: { select: { id: true, name: true, email: true } } },
    });

    // Notify admin
    this.emailNotification.notifyAdminDesignRequested({
      projectNumber: project.projectNumber,
      title: project.title,
      customerName: project.customer.name,
    }).catch(err => this.logger.warn('Admin design notification failed: ' + err.message));

    return project;
  }

  async findAll(query: PaginationDto, status?: string, assignedToId?: string) {
    const where: any = {};
    if (status) where.status = status;
    if (assignedToId) where.assignedToId = assignedToId;

    const [data, total] = await Promise.all([
      this.prisma.designProject.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          customer: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          _count: { select: { comments: true, revisions: true } },
        },
      }),
      this.prisma.designProject.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  async findForCustomer(customerId: string, query: PaginationDto) {
    const where = { customerId };
    const [data, total] = await Promise.all([
      this.prisma.designProject.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        include: {
          assignedTo: { select: { id: true, name: true } },
          _count: { select: { comments: true, revisions: true } },
        },
      }),
      this.prisma.designProject.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }

  /**
   * GET /design-projects/:id. Staff get the whole project; the project's
   * customer gets CUSTOMER_DESIGN_SELECT (it used to be the whole project too,
   * with the staff notes and every revision's internal notes).
   */
  async findOne(id: string, caller?: { userId: string; userType: string }) {
    if (caller && caller.userType !== 'staff') {
      await this.verifyAccess(id, caller.userId, caller.userType);
      const project = await this.prisma.designProject.findUnique({ where: { id }, select: CUSTOMER_DESIGN_SELECT });
      if (!project) throw new NotFoundException('Design project not found');
      return project;
    }
    return this.staffView(id);
  }

  /** The whole project, for staff routes and the service's own checks. */
  private async staffView(id: string) {
    const project = await this.prisma.designProject.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        assignedTo: { select: { id: true, name: true } },
        comments: { orderBy: { createdAt: 'asc' } },
        revisions: { orderBy: { versionNumber: 'desc' } },
        attachments: true,
        quote: { select: { id: true, quoteNumber: true, total: true, status: true } },
      },
    });
    if (!project) throw new NotFoundException('Design project not found');
    return project;
  }

  /**
   * PATCH /design-projects/:id (ADMIN/OPERATOR). The body is parsed by
   * parseDesignPatch: bounded fees, a DesignStatus, a real date, notes of at
   * most 5000 characters, and no assignedToId (POST /:id/assign is the
   * ADMIN-only way to assign a designer).
   */
  async update(id: string, body: unknown) {
    const dto = parseDesignPatch(body);
    await this.staffView(id);

    const data: Prisma.DesignProjectUpdateInput = {};
    if (dto.status) data.status = dto.status;
    if (dto.designFeeType) data.designFeeType = dto.designFeeType;
    if (dto.designFeeAmount !== undefined) data.designFeeAmount = dto.designFeeAmount;
    if (dto.designFeeHours !== undefined) {
      data.designFeeHours = dto.designFeeHours;
      // Auto-calculate total for hourly
      if (dto.designFeeAmount) {
        data.totalDesignFee = dto.designFeeAmount * dto.designFeeHours;
      }
    }
    if (dto.designFeeAmount !== undefined && !dto.designFeeHours) {
      data.totalDesignFee = dto.designFeeAmount;
    }
    if (dto.estimatedDelivery !== undefined) data.estimatedDelivery = dto.estimatedDelivery;
    if (dto.notes !== undefined) data.notes = dto.notes;

    return this.prisma.designProject.update({
      where: { id },
      data,
      include: {
        customer: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * POST /design-projects/:id/assign (ADMIN): `{ userId }`, parsed by
   * parseDesignAssign. The designer must be an active ADMIN or OPERATOR user;
   * any id used to be written as assignedToId (an unknown one was a 500).
   */
  async assign(id: string, body: unknown) {
    const userId = parseDesignAssign(body);
    const project = await this.staffView(id);
    if (project.status === 'CANCELLED' || project.status === 'COMPLETED') {
      throw new BadRequestException('Cannot assign a closed project');
    }
    const designer = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
    if (!designer) throw new NotFoundException('User not found');
    if (!designer.isActive || !(DESIGN_STAFF_WRITE_ROLES as readonly string[]).includes(designer.role)) {
      throw new BadRequestException('A design project can only be assigned to an active ADMIN or OPERATOR user');
    }

    return this.prisma.designProject.update({
      where: { id },
      data: {
        assignedToId: userId,
        status: project.status === 'REQUESTED' ? 'ASSIGNED' : project.status,
      },
      include: {
        assignedTo: { select: { id: true, name: true } },
      },
    });
  }

  // ============ COMMENTS (Chat) ============

  /**
   * POST /design-projects/:id/comments, for the project's customer and for
   * ADMIN/OPERATOR staff (checked by the controller). The body is parsed by
   * parseDesignComment, and every attachment id must be one of this project's
   * attachments: stored by POST /attachments with a design-project entityType
   * and this project as entityId (Attachment.designProjectId, also accepted,
   * is never written).
   */
  async addComment(projectId: string, body: unknown, author: { id: string; name: string; isCustomer: boolean }) {
    const dto = parseDesignComment(body);
    if (author.isCustomer) {
      await this.verifyAccess(projectId, author.id, 'customer');
    }
    await this.staffView(projectId);
    if (dto.attachmentIds.length) {
      const rows = await this.prisma.attachment.findMany({
        where: { id: { in: dto.attachmentIds }, OR: [{ designProjectId: projectId }, { entityId: projectId }] },
        select: { id: true, entityType: true, designProjectId: true },
      });
      const onProject = rows.filter((a) => a.designProjectId === projectId || isDesignProjectEntity(a.entityType));
      if (onProject.length !== dto.attachmentIds.length) throw new BadRequestException('Attachment not found on this project');
    }

    return this.prisma.designComment.create({
      data: {
        projectId,
        authorId: author.id,
        authorName: author.name,
        isCustomer: author.isCustomer,
        content: dto.content,
        attachmentIds: dto.attachmentIds,
      },
    });
  }

  async getComments(projectId: string, caller?: { userId: string; userType: string }) {
    if (caller) {
      await this.verifyAccess(projectId, caller.userId, caller.userType);
    }
    if (caller && caller.userType !== 'staff') {
      return this.prisma.designComment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
        select: CUSTOMER_DESIGN_SELECT.comments.select,
      });
    }
    return this.prisma.designComment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ============ REVISIONS ============

  /** POST /design-projects/:id/revisions (ADMIN/OPERATOR); the body is parsed by parseDesignRevision. */
  async addRevision(projectId: string, body: unknown) {
    const { description, internalNotes } = parseDesignRevision(body);
    const project = await this.staffView(projectId);

    const lastRevision = project.revisions[0]; // already sorted desc
    const versionNumber = lastRevision ? lastRevision.versionNumber + 1 : 1;

    const revision = await this.prisma.designRevision.create({
      data: {
        projectId,
        versionNumber,
        description: description || `Revision ${versionNumber}`,
        internalNotes,
      },
    });

    // Move project to REVIEW status
    await this.prisma.designProject.update({
      where: { id: projectId },
      data: { status: 'REVIEW' },
    });

    // Notify customer
    if (project.customer.email) {
      this.emailNotification.notifyCustomerDesignUploaded(project.customer.email, {
        projectNumber: project.projectNumber,
        title: project.title,
        revisionNumber: versionNumber,
      }).catch(err => this.logger.warn('Customer design uploaded notification failed: ' + err.message));
    }

    return revision;
  }

  // ============ CUSTOMER ACTIONS ============

  /** Answers with CUSTOMER_DESIGN_SELECT, like GET /design-projects/:id for the customer. */
  async customerApprove(projectId: string, customerId: string) {
    const project = await this.staffView(projectId);
    if (project.customerId !== customerId) throw new NotFoundException('Project not found');
    if (project.status !== 'REVIEW') {
      throw new BadRequestException('Project must be in REVIEW status to approve');
    }

    return this.prisma.designProject.update({
      where: { id: projectId },
      data: { status: 'APPROVED' },
      select: CUSTOMER_DESIGN_SELECT,
    });
  }

  /**
   * The body is parsed by parseDesignFeedback (`{ feedback }`, required,
   * bounded). Answers with CUSTOMER_DESIGN_SELECT.
   */
  async customerRequestChanges(projectId: string, customerId: string, body: unknown) {
    const feedback = parseDesignFeedback(body);
    const project = await this.staffView(projectId);
    if (project.customerId !== customerId) throw new NotFoundException('Project not found');
    if (project.status !== 'REVIEW') {
      throw new BadRequestException('Project must be in REVIEW status to request changes');
    }

    // Add comment with feedback
    await this.prisma.designComment.create({
      data: {
        projectId,
        authorId: customerId,
        authorName: project.customer.name,
        isCustomer: true,
        content: feedback,
        attachmentIds: [],
      },
    });

    const updated = await this.prisma.designProject.update({
      where: { id: projectId },
      data: { status: 'REVISION' },
      select: CUSTOMER_DESIGN_SELECT,
    });

    // Notify admin
    this.emailNotification.notifyAdminDesignFeedback({
      projectNumber: project.projectNumber,
      title: project.title,
      customerName: project.customer.name,
      feedback,
    }).catch(err => this.logger.warn('Admin design feedback notification failed: ' + err.message));

    return updated;
  }
}
