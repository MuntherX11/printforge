import { Controller, Get, Post, Patch, Put, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CustomerGuard } from '../auth/guards/customer.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

/**
 * Bodies are typed `unknown` on purpose: every one is parsed by an explicit
 * allowlist in the service (spec §0.2), never trusted or spread into Prisma.
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  /** S2 */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  create(@Body() body: unknown) {
    return this.ordersService.create(body);
  }

  // S3: preflight for the New Order screen — what would be short if this were
  // placed now. Never blocks the order; it only tells staff what to buy.
  @Post('check-stock')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  checkStock(@Body() body: unknown) {
    return this.ordersService.checkStock(body);
  }

  @Get()
  @UseGuards(StaffGuard)
  findAll(@Query() query: PaginationDto, @Query('status') status?: string) {
    return this.ordersService.findAll(query, status);
  }

  @Get('customer/my-orders')
  @UseGuards(CustomerGuard)
  findForCustomer(@Req() req: any) {
    return this.ordersService.findForCustomer(req.user.id);
  }

  /** S5 */
  @Post('customer')
  @UseGuards(CustomerGuard)
  @Throttle({ long: { ttl: 3600000, limit: 10 } })
  createForCustomer(@Req() req: any, @Body() body: unknown) {
    return this.ordersService.createForCustomer(req.user.id, body);
  }

  /** S4 */
  @Get(':id')
  @UseGuards(StaffGuard)
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  /** S9 */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() body: unknown) {
    return this.ordersService.update(id, body);
  }

  /** S11: split a product line into same-size colour lines (`?dryRun=1` lists jobs and stock first). */
  @Put(':id/items/:itemId/colour')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  changeLineColour(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Query('dryRun') dryRun: string | undefined,
    @Req() req: any,
  ) {
    return this.ordersService.changeLineColour(id, itemId, body, isTrue(dryRun), req?.user?.id ?? null);
  }
}

export function isTrue(v: unknown): boolean {
  return v === true || v === '1' || v === 'true';
}
