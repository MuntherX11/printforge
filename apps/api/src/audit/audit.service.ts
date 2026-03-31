import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(params: {
    userId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: any;
  }) {
    return this.prisma.auditLog.create({ data: params });
  }

  async findAll(query: PaginationDto, entityType?: string, entityId?: string) {
    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        ...paginate(query),
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginatedResponse(data, total, query);
  }
}
