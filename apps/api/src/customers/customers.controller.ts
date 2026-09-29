import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

/**
 * Who may add or edit a customer's contact card. VIEWER is read-only. ACCOUNTING
 * keeps the Add Customer and Edit buttons its Customers screen shows, and
 * OPERATOR adds the customers it takes orders and quotes for. Approving or
 * rejecting a portal account is ADMIN-only on /auth/customers/:id/approve and
 * /reject, and deleting a customer is ADMIN-only below.
 */
export const CUSTOMER_WRITE_ROLES = ['ADMIN', 'OPERATOR', 'ACCOUNTING'] as const;

@Controller('customers')
@UseGuards(JwtAuthGuard, StaffGuard)
export class CustomersController {
  constructor(private customersService: CustomersService) {}

  /** The body is parsed by customer-input.ts (name, email, phone, address, notes only). */
  @Post()
  @UseGuards(RolesGuard)
  @Roles(...CUSTOMER_WRITE_ROLES)
  create(@Body() body: unknown) {
    return this.customersService.create(body);
  }

  @Get()
  findAll(@Query() query: PaginationDto) {
    return this.customersService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(...CUSTOMER_WRITE_ROLES)
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.customersService.update(id, body);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.customersService.remove(id);
  }
}
