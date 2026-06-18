import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

@Injectable()
export class CustomerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest();
    if (!user || user.userType !== 'customer') {
      throw new ForbiddenException('Customer access only');
    }
    if (!user.isApproved) {
      throw new ForbiddenException('Account pending approval');
    }
    return true;
  }
}
