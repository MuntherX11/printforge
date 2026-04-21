import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DesignService } from './design.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { CustomerGuard } from '../auth/guards/customer.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreateDesignProjectDto, UpdateDesignProjectDto, AddDesignCommentDto } from '@printforge/types';
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

  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() dto: AddDesignCommentDto,
    @CurrentUser() user: any,
  ) {
    return this.designService.addComment(id, dto, {
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

  @Post(':id/upload')
  @UseGuards(StaffGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  async uploadFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new Error('No file uploaded');

    // Validate by both MIME type (server-observed) and extension
    const ext = (file.originalname.toLowerCase().split('.').pop() || '').replace(/[^a-z0-9]/g, '');
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'stl', '3mf'];
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`File type .${ext} not allowed`);
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new Error(`MIME type ${file.mimetype} not allowed`);
    }

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
  customerCreate(@Body() dto: CreateDesignProjectDto, @CurrentUser() user: any) {
    return this.designService.create(dto, user.id);
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
    @Body() body: { feedback: string },
    @CurrentUser() user: any,
  ) {
    return this.designService.customerRequestChanges(id, user.id, body.feedback);
  }
}
