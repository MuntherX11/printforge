import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Public routes that don't require authentication
const publicPatterns = [
  /^\/inventory\/spool\/[A-Za-z0-9-]+$/, // QR spool pages (PFID)
  /^\/login$/,
  /^\/signup$/,
  /^\/staff-login$/,
  /^\/customer-login$/,
  /^\/api\//,       // API routes handled by NestJS guards
  /^\/_next\//,     // Next.js internals
  /^\/favicon/,
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public routes
  for (const pattern of publicPatterns) {
    if (pattern.test(pathname)) {
      // Pass the pathname as a header so layout can detect public pages
      const response = NextResponse.next();
      response.headers.set('x-pathname', pathname);
      return response;
    }
  }

  // For dashboard routes, check for auth token
  const token = request.cookies.get('token');
  if (!token && pathname !== '/') {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const response = NextResponse.next();
  response.headers.set('x-pathname', pathname);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
