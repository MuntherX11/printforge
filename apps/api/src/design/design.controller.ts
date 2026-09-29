import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DESIGN_STAFF_WRITE_ROLES, DesignService } from './design.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CustomerGuard } from '../auth/guards/customer.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UpdateDesignProjectDto } from '@printforge/types';
import { PaginationDto } from '../common/dto/pagination.dto';

// SVG excluded — can embed JavaScript and cause stored XSS when served back
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif',
  'application/pdf',
  'model/stl', 'application/sla', 'application/octet-stream', // STL
  'model/3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml', // 3MF
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

@Controller('design-projects')
@UseGuards(JwtAuthGuard)
export class DesignController {
  constructor(private designService: DesignService) {}

  // ============ STAFF ENDPOINTS ============

  @Get()
  @UseGuards(StaffGuard)
  findAll(
    @Query() query: PaginationDto,
    @Query('status') status?: string,
    @Query('assignedToId') assignedToId?: string,
  ) {
    return this.designService.findAll(query, status, assignedToId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.designService.findOne(id, { userId: user.id, userType: user.userType });
  }

  @Patch(':id')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  update(@Param('id') id: string, @Body() dto: UpdateDesignProjectDto) {
    return this.designService.update(id, dto);
  }

  @Post(':id/assign')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN')
  assign(@Param('id') id: string, @Body() body: { userId: string }) {
    return this.designService.assign(id, body.userId);
  }

  /**
   * The project's customer, or ADMIN/OPERATOR staff. The route has to serve
   * both, so it can't use RolesGuard (a customer has no role); a staff caller's
   * role is checked here instead. VIEWER and ACCOUNTING used to be able to post
   * a staff message into the customer's chat. The body is parsed by
   * parseDesignComment.
   */
  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: any,
  ) {
    if (user?.userType !== 'customer' && !(DESIGN_STAFF_WRITE_ROLES as readonly string[]).includes(user?.role)) {
      throw new ForbiddenException('Only ADMIN or OPERATOR staff can post in a design project');
    }
    return this.designService.addComment(id, body, {
      id: user.id,
      name: user.name,
      isCustomer: user.userType === 'customer',
    });
  }

  @Get(':id/comments')
  getComments(@Param('id') id: string, @CurrentUser() user: any) {
    return this.designService.getComments(id, { userId: user.id, userType: user.userType });
  }

  @Post(':id/revisions')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  addRevision(
    @Param('id') id: string,
    @Body() body: { description?: string; internalNotes?: string },
  ) {
    return this.designService.addRevision(id, body.description, body.internalNotes);
  }

  /**
   * ADMIN/OPERATOR, like revisions: any staff role could write files of up to
   * 50 MB into uploads/design before, for any :id. The project must exist.
   */
  @Post(':id/upload')
  @UseGuards(StaffGuard, RolesGuard)
  @Roles(...DESIGN_STAFF_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  async uploadFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    // Validate by both MIME type (server-observed) and extension
    const ext = (file.originalname.toLowerCase().split('.').pop() || '').replace(/[^a-z0-9]/g, '');
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'stl', '3mf'];
    if (!allowedExtensions.includes(ext)) {
      throw new BadRequestException(`File type .${ext} not allowed`);
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`MIME type ${file.mimetype} not allowed`);
    }
    await this.designService.findOne(id); // 404 for an unknown project, before anything is written

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = path.join(process.cwd(), 'uploads', 'design');
    fs.mkdirSync(uploadsDir, { recursive: true });

    // Use sanitized filename — never trust original name for path construction
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const filename = `${Date.now()}-${safeOriginal}`;
    fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);

    return {
      filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      storagePath: `uploads/design/${filename}`,
    };
  }

  // ============ CUSTOMER ENDPOINTS ============

  @Post('customer/create')
  @UseGuards(CustomerGuard)
  customerCreate(@Body() body: unknown, @CurrentUser() user: any) {
    return this.designService.create(body, user.id);
  }

  @Get('customer/my-projects')
  @UseGuards(CustomerGuard)
  customerFindAll(@CurrentUser() user: any, @Query() query: PaginationDto) {
    return this.designService.findForCustomer(user.id, query);
  }

  @Post('customer/:id/approve')
  @UseGuards(CustomerGuard)
  customerApprove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.designService.customerApprove(id, user.id);
  }

  @Post('customer/:id/request-changes')
  @UseGuards(CustomerGuard)
  customerRequestChanges(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: any,
  ) {
    return this.designService.customerRequestChanges(id, user.id, body);
  }
}
