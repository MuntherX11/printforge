import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Public routes that don't require authentication
const publicPatterns = [
  /^\/login$/,
  /^\/signup$/,
  /^\/staff-login$/,
  /^\/customer-login$/,
  /^\/api\//,       // API routes handled by NestJS guards
  /^\/_next\//,     // Next.js internals
  /^\/favicon/,
];

// QR spool pages (PF-ID) are staff only. A logged-out scan signs in as staff
// and comes back to the same spool.
const SPOOL_QR = /^\/inventory\/spool\/[A-Za-z0-9-]+$/;

// Routes that belong to the customer portal (/(customer)/dashboard → /dashboard/*)
const CUSTOMER_PREFIX = '/dashboard';

// Decode the JWT payload without verifying the signature.
// Verification happens in the API/NestJS guards; here we only need the `type` claim
// for routing. Returns null if the token is absent or malformed.
function decodeTokenPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    // JWT segments are base64url without padding; atob (Edge Runtime) needs base64.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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

  // Check for auth token
  const tokenCookie = request.cookies.get('token');
  if (!tokenCookie && pathname !== '/') {
    if (SPOOL_QR.test(pathname)) {
      const u = new URL('/staff-login', request.url);
      u.searchParams.set('next', pathname);
      return NextResponse.redirect(u);
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Decode the JWT to determine user type for route-level enforcement.
  // Tokens carry `type: 'staff' | 'customer'` (JwtPayload). Reading `userType`
  // here never matched, so customers were sent to the staff dashboard.
  const payload = decodeTokenPayload(tokenCookie?.value);
  const isCustomer = (payload?.type ?? payload?.userType) === 'customer';

  if (pathname.startsWith(CUSTOMER_PREFIX)) {
    // Customer portal routes — staff must not enter
    if (!isCustomer) {
      return NextResponse.redirect(new URL('/', request.url));
    }
  } else {
    // Staff dashboard routes — customers must not enter
    if (isCustomer) {
      return NextResponse.redirect(new URL(CUSTOMER_PREFIX, request.url));
    }
  }

  const response = NextResponse.next();
  response.headers.set('x-pathname', pathname);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
