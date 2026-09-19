import {
  BadRequestException,
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import * as path from 'path';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  IMAGE_NOT_FOUND,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_REQUEST,
  ProductImagesService,
  sanitizeImageName,
} from './product-images.service';

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const LAST_NAME = Symbol('lastPhotoName');

/**
 * FilesInterceptor for G2 with the §4.6 messages: an extension filter (the
 * bytes are sniffed again later; this is only an early, friendly refusal) and
 * multer's 413 / too-many-files errors turned into 400s that name the file.
 */
@Injectable()
export class PhotoUploadInterceptor implements NestInterceptor {
  private readonly inner: NestInterceptor;

  constructor() {
    const Mixin = FilesInterceptor('files', MAX_PHOTOS_PER_REQUEST, {
      limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_REQUEST },
      fileFilter: (req, file, cb) => {
        const name = sanitizeImageName(file.originalname);
        (req as any)[LAST_NAME] = name;
        if (!PHOTO_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase())) {
          return cb(new BadRequestException(`"${name}" is not a JPG, PNG or WebP image`), false);
        }
        cb(null, true);
      },
    });
    this.inner = new Mixin();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.inner.intercept(context, next);
    } catch (e) {
      const req = context.switchToHttp().getRequest();
      const name = (req as any)[LAST_NAME] || 'photo';
      if (e instanceof PayloadTooLargeException) throw new BadRequestException(`"${name}" is over 10 MB`);
      const msg = (e as Error)?.message || '';
      if (/unexpected field|too many files/i.test(msg)) {
        throw new BadRequestException(`Upload at most ${MAX_PHOTOS_PER_REQUEST} photos at a time`);
      }
      throw e;
    }
  }
}

/**
 * Sends an authorised image with the §4.6 headers. Shared by G5 and P15.
 * Callers MUST have authorised the request and derived `absPath` from a
 * validated storage key / contained path before calling this.
 */
export function sendImageFile(res: Response, absPath: string, mime: string): void {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : null;
  if (!ext) {
    res.status(404).json({ success: false, error: IMAGE_NOT_FOUND, statusCode: 404 });
    return;
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="photo.${ext}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.sendFile(
    absPath,
    { dotfiles: 'deny', cacheControl: false, etag: true, lastModified: true },
    (err) => {
      if (err && !res.headersSent) {
        res.removeHeader('Content-Disposition');
        res.status(404).json({ success: false, error: IMAGE_NOT_FOUND, statusCode: 404 });
      }
    },
  );
}

/** Product photos (§4.6 G1–G5). Photos are logged-in only; nothing here is public. */
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductImagesController {
  constructor(private images: ProductImagesService) {}

  /** G1 */
  @Get(':id/images')
  @UseGuards(StaffGuard)
  list(@Param('id') id: string) {
    return this.images.list(id);
  }

  /** G2 */
  @Post(':id/images')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  @UseInterceptors(PhotoUploadInterceptor)
  upload(@Param('id') id: string, @UploadedFiles() files: Express.Multer.File[], @CurrentUser() user: any) {
    return this.images.upload(id, files ?? [], user?.id ?? null);
  }

  /** G3 */
  @Put(':id/images/order')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  reorder(@Param('id') id: string, @Body() body: unknown) {
    return this.images.reorder(id, body);
  }

  /** G4 */
  @Delete(':id/images/:imageId')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'OPERATOR')
  remove(@Param('id') id: string, @Param('imageId') imageId: string) {
    return this.images.remove(id, imageId);
  }

  /**
   * G5: the bytes. Authorised on every request (a 304 revalidation too), so
   * losing approval, logging out or deactivating the product takes effect on
   * the next view. Throttling is skipped for all named tiers: behind nginx
   * without `trust proxy` every user shares one bucket, and a grid loads 25+
   * images at once. @Res bypasses the JSON envelope interceptor.
   */
  @Get(':id/images/:imageId')
  @SkipThrottle({ short: true, medium: true, long: true })
  async serve(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const img = await this.images.resolveForServe(id, imageId, (req as any).user);
    sendImageFile(res, img.absPath, img.mime);
  }
}
