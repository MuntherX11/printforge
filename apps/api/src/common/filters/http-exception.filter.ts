import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/**
 * Global error envelope: `{ success: false, error, statusCode }`.
 *
 * - Nest HttpExceptions keep their status and message.
 * - Known Prisma errors that come from user input map to client errors instead
 *   of an opaque 500: P2002 (unique) -> 409 naming the fields, P2003 (foreign
 *   key) -> 400, P2025 (record not found) -> 404.
 * - Anything else is a 500 with a generic message; the real error is logged
 *   with the method, URL, user id and stack so it can be traced.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message = typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as any).message || exception.message;
    } else {
      const mapped = mapPrismaError(exception);
      if (mapped) {
        status = mapped.status;
        message = mapped.message;
      } else {
        const err = exception as { message?: unknown; stack?: unknown } | null | undefined;
        const user = (request as any)?.user;
        const userId = user?.id ?? user?.sub ?? 'anonymous';
        const errMessage = typeof err?.message === 'string' ? err.message : String(exception);
        this.logger.error(
          `${request?.method ?? '?'} ${request?.originalUrl ?? request?.url ?? '?'} (user ${userId}): ${errMessage}`,
          typeof err?.stack === 'string' ? err.stack : undefined,
        );
      }
    }

    response.status(status).json({
      success: false,
      error: Array.isArray(message) ? message.join(', ') : message,
      statusCode: status,
    });
  }
}

function isKnownPrismaError(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return true;
  // Duck-type fallback: a second copy of @prisma/client (tests, workspaces)
  // would fail instanceof but still carries the same shape.
  const x = e as { code?: unknown; clientVersion?: unknown } | null;
  return !!x && typeof x === 'object' && typeof x.code === 'string' && /^P\d{4}$/.test(x.code)
    && typeof x.clientVersion === 'string';
}

export function mapPrismaError(e: unknown): { status: number; message: string } | null {
  if (!isKnownPrismaError(e)) return null;
  const meta = (e.meta ?? {}) as Record<string, unknown>;
  switch (e.code) {
    case 'P2002': {
      const target = meta.target;
      const fields = Array.isArray(target)
        ? target.map(String).join(', ')
        : typeof target === 'string' ? target : 'these values';
      return { status: HttpStatus.CONFLICT, message: `A record with the same ${fields} already exists` };
    }
    case 'P2003': {
      const field = typeof meta.field_name === 'string' ? ` (${meta.field_name})` : '';
      return {
        status: HttpStatus.BAD_REQUEST,
        message: `This change refers to a record that does not exist, or the record is still in use${field}`,
      };
    }
    case 'P2025': {
      const cause = typeof meta.cause === 'string' ? meta.cause : 'Record not found';
      return { status: HttpStatus.NOT_FOUND, message: cause };
    }
    default:
      return null;
  }
}
