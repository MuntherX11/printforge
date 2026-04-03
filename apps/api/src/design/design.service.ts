import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailNotificationService } from '../communications/email-notification.service';
import { CreateDesignProjectDto, UpdateDesignProjectDto, AddDesignCommentDto } from '@printforge/types';
import { generateNumber } from '../common/utils/number-generator';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class DesignService {
  constructor(
    private prisma: PrismaService,
    private emailNotification: EmailNotificationService,
  ) {}

  // ============ PROJECTS ============

  async create(dto: CreateDesignProjectDto, customerId: string) {
    const projectNumber = await generateNumber(this.prisma, 'DS', 'designProject');

    const project = await this.prisma.designProject.create({
      data: {
        projectNumber,
        customerId,
        title: dto.title,
        brief: dto.brief || null,
        budget: dto.budget || null,
        status: 'REQUESTED',
      },
      include: { customer: { select: { id: true, name: true, email: true } } },
    });

    // Notify admin
    this.emailNotification.notifyAdminDesignRequested({
      projectNumber: project.projectNumber,
      title: project.title,
      customerName: project.customer.name,
    });

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

  async findOne(id: string) {
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

  async update(id: string, dto: UpdateDesignProjectDto) {
    await this.findOne(id);

    const data: any = {};
    if (dto.status) data.status = dto.status;
    if (dto.assignedToId !== undefined) data.assignedToId = dto.assignedToId || null;
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
    if (dto.estimatedDelivery) data.estimatedDelivery = new Date(dto.estimatedDelivery);
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

  async assign(id: string, userId: string) {
    const project = await this.findOne(id);
    if (project.status === 'CANCELLED' || project.status === 'COMPLETED') {
      throw new BadRequestException('Cannot assign a closed project');
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

  async addComment(projectId: string, dto: AddDesignCommentDto, author: { id: string; name: string; isCustomer: boolean }) {
    await this.findOne(projectId);

    return this.prisma.designComment.create({
      data: {
        projectId,
        authorId: author.id,
        authorName: author.name,
        isCustomer: author.isCustomer,
        content: dto.content,
        attachmentIds: dto.attachmentIds || [],
      },
    });
  }

  async getComments(projectId: string) {
    return this.prisma.designComment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ============ REVISIONS ============

  async addRevision(projectId: string, description?: string, internalNotes?: string) {
    const project = await this.findOne(projectId);

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
      });
    }

    return revision;
  }

  // ============ CUSTOMER ACTIONS ============

  async customerApprove(projectId: string, customerId: string) {
    const project = await this.findOne(projectId);
    if (project.customerId !== customerId) throw new NotFoundException('Project not found');
    if (project.status !== 'REVIEW') {
      throw new BadRequestException('Project must be in REVIEW status to approve');
    }

    return this.prisma.designProject.update({
      where: { id: projectId },
      data: { status: 'APPROVED' },
    });
  }

  async customerRequestChanges(projectId: string, customerId: string, feedback: string) {
    const project = await this.findOne(projectId);
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
    });

    // Notify admin
    this.emailNotification.notifyAdminDesignFeedback({
      projectNumber: project.projectNumber,
      title: project.title,
      customerName: project.customer.name,
      feedback,
    });

    return updated;
  }
}
