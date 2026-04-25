import { IsOptional, IsInt, Min, IsString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @IsIn(['createdAt', 'updatedAt', 'name', 'status', 'total', 'orderNumber', 'paidAt', 'completedAt', 'printDuration', 'totalCost'])
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export function paginate(query: PaginationDto) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  return {
    skip: (page - 1) * limit,
    take: limit,
    orderBy: { [query.sortBy || 'createdAt']: query.sortOrder || 'desc' },
  };
}

export function paginatedResponse<T>(data: T[], total: number, query: PaginationDto) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
