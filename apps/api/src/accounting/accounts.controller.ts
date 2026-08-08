import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('accounts')
@UseGuards(JwtAuthGuard, StaffGuard)
export class AccountsController {
  constructor(private accounts: AccountsService) {}

  @Get()
  findAll() {
    return this.accounts.findAll();
  }

  @Get('summary')
  summary() {
    return this.accounts.summary();
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.accounts.findOne(id, limit ? Number(limit) : 100);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTING')
  create(@Body() dto: any) {
    return this.accounts.create(dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTING')
  update(@Param('id') id: string, @Body() dto: any) {
    return this.accounts.update(id, dto);
  }

  @Post(':id/adjust')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTING')
  adjust(@Param('id') id: string, @Body() dto: { amount: number; description?: string }) {
    return this.accounts.adjust(id, dto);
  }

  @Post('transfer')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTING')
  transfer(@Body() dto: { fromAccountId: string; toAccountId: string; amount: number; description?: string }) {
    return this.accounts.transfer(dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  remove(@Param('id') id: string) {
    return this.accounts.remove(id);
  }
}
