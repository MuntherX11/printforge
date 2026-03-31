import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';

const AUDIT_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

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

    const path = request.route?.path || request.url;
    const entityType = this.extractEntityType(path);
    const entityId = request.params?.id || 'new';

    const actionMap: Record<string, string> = {
      POST: 'created',
      PATCH: 'updated',
      PUT: 'updated',
      DELETE: 'deleted',
    };

    return next.handle().pipe(
      tap((responseData) => {
        const action = `${entityType}.${actionMap[method]}`;
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
