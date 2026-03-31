import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateExpenseDto, CreateExpenseCategoryDto } from '@printforge/types';

@Controller('accounting')
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(private expensesService: ExpensesService) {}

  @Get('categories')
  getCategories() {
    return this.expensesService.getCategories();
  }

  @Post('categories')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  createCategory(@Body() dto: CreateExpenseCategoryDto) {
    return this.expensesService.createCategory(dto);
  }

  @Post('expenses')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  createExpense(@Body() dto: CreateExpenseDto) {
    return this.expensesService.create(dto);
  }

  @Get('expenses')
  findExpenses(@Query('startDate') startDate?: string, @Query('endDate') endDate?: string) {
    return this.expensesService.findAll(startDate, endDate);
  }

  @Patch('expenses/:id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  updateExpense(@Param('id') id: string, @Body() dto: Partial<CreateExpenseDto>) {
    return this.expensesService.update(id, dto);
  }

  @Delete('expenses/:id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  removeExpense(@Param('id') id: string) {
    return this.expensesService.remove(id);
  }
}
