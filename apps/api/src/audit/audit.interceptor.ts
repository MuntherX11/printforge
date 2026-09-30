import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';

const AUDIT_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

/** Routes whose service writes its own audit row inside its transaction (with the amounts): a generic row would duplicate it. Tested on the route pattern. */
const SELF_AUDITED = /\/invoices\/[^/]+\/unpay$/;

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;

    if (!AUDIT_METHODS.includes(method)) {
      return next.handle();
    }

    const user = request.user;
    if (!user) return next.handle();

    // Decide on the matched route pattern (its case and shape fixed by the
    // route definition), not the raw URL: Express matches paths
    // case-insensitively and ignores a trailing slash, so /api/INVOICES/x/Unpay/
    // reaches the same handler. The URL, normalised, only when no route is set.
    const cleanUrl = String(request.url ?? '').split('?')[0];
    const pattern: string = request.route?.path || cleanUrl.toLowerCase().replace(/\/+$/, '');
    if (SELF_AUDITED.test(pattern)) return next.handle();

    const path = request.route?.path || request.url;
    const entityType = this.extractEntityType(path);
    const entityId = request.params?.id || 'new';

    const actionMap: Record<string, string> = {
      POST: 'created',
      PATCH: 'updated',
      PUT: 'updated',
      DELETE: 'deleted',
    };

    // Sub-resource terminal segment overrides (e.g. POST /jobs/:id/complete → completed).
    const terminalActionMap: Record<string, string> = {
      complete: 'completed',
      fail: 'failed',
      cancel: 'cancelled',
      approve: 'approved',
      reject: 'rejected',
      convert: 'converted',
      'send-email': 'sent',
      reprint: 'reprinted',
      // POST /products/:id/variants/:variantId/convert-to-layout; the service also writes its own ProductVariant row.
      'convert-to-layout': 'convertedToLayout',
    };

    const lastSegment = pattern.split('/').filter(Boolean).pop() ?? '';
    const terminalAction = terminalActionMap[lastSegment];

    return next.handle().pipe(
      tap((responseData) => {
        const baseAction = terminalAction ?? actionMap[method];
        const action = `${entityType}.${baseAction}`;
        const resultId = responseData?.data?.id || responseData?.id || entityId;

        this.auditService.log({
          userId: user.id,
          action,
          entityType,
          entityId: resultId,
          details: { method, path, body: this.sanitizeBody(request.body) },
        }).catch(() => {}); // Fire and forget — don't block response
      }),
    );
  }

  private extractEntityType(path: string): string {
    // /api/orders/:id → Order
    const segments = path.split('/').filter(Boolean);
    const resource = segments.find(s => !s.startsWith(':') && s !== 'api') || 'unknown';
    return resource.charAt(0).toUpperCase() + resource.slice(1).replace(/s$/, '');
  }

  private sanitizeBody(body: any): any {
    if (!body) return null;
    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.passwordHash;
    return sanitized;
  }
}
