import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffGuard } from '../auth/guards/staff.guard';

@Controller('accounting')
@UseGuards(JwtAuthGuard)
export class ExpensesController {
  constructor(private expensesService: ExpensesService) {}

  @Get('categories')
  @UseGuards(StaffGuard)
  getCategories() {
    return this.expensesService.getCategories();
  }

  /** The body is parsed by expense-input.ts; any key but name and description → 400. */
  @Post('categories')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  createCategory(@Body() body: unknown) {
    return this.expensesService.createCategory(body);
  }

  /** The body is parsed by expense-input.ts (parseExpenseCreate); any other key → 400. */
  @Post('expenses')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  createExpense(@Body() body: unknown) {
    return this.expensesService.create(body);
  }

  @Get('expenses')
  @UseGuards(StaffGuard)
  findExpenses(@Query('startDate') startDate?: string, @Query('endDate') endDate?: string) {
    return this.expensesService.findAll(startDate, endDate);
  }

  /** The body is parsed by expense-input.ts; any key but the expense's own columns → 400. */
  @Patch('expenses/:id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  updateExpense(@Param('id') id: string, @Body() body: unknown) {
    return this.expensesService.update(id, body);
  }

  @Delete('expenses/:id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  removeExpense(@Param('id') id: string) {
    return this.expensesService.remove(id);
  }
}
