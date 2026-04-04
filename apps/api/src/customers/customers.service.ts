import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateCustomerDto, UpdateCustomerDto } from '@printforge/types';
import { PaginationDto, paginate, paginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCustomerDto) {
    const result = await this.prisma.customer.create({ data: dto });
    const { passwordHash, refreshToken, ...safe } = result;
    return safe;
  }

  async findAll(query: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        ...paginate(query),
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          address: true,
          notes: true,
          portalAccess: true,
          isApproved: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { orders: true } },
        },
      }),
      this.prisma.customer.count(),
    ]);
    return paginatedResponse(data, total, query);
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        orders: { orderBy: { createdAt: 'desc' }, take: 10 },
        quotes: { orderBy: { createdAt: 'desc' }, take: 10 },
        _count: { select: { orders: true, quotes: true } },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const { passwordHash, refreshToken, ...safe } = customer;
    return safe;
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findOne(id);
    const result = await this.prisma.customer.update({ where: { id }, data: dto });
    const { passwordHash, refreshToken, ...safe } = result;
    return safe;
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.customer.delete({ where: { id } });
  }
}
