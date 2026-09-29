import { SAFE_NEXT_MAX, SPOOL_QR_PATH, safeNextPath } from '@printforge/types';

/** Safety spec §1: staff login returns only to a safe same-site ?next= path. */

describe('safeNextPath', () => {
  it('accepts a plain same-site path, with or without a query', () => {
    for (const path of ['/inventory/spool/PF-A7X2', '/inventory?q=red', '/login-help', '/']) {
      expect(safeNextPath(path)).toBe(path);
    }
  });

  it('accepts a path of exactly the maximum length', () => {
    const path = '/' + 'a'.repeat(SAFE_NEXT_MAX - 1);
    expect(path).toHaveLength(512);
    expect(safeNextPath(path)).toBe(path);
  });

  it('refuses anything that is not a non-empty string starting with /', () => {
    for (const raw of [null, undefined, '', 'inventory', 'evil.com', 42, {}, ['/inventory']]) {
      expect(safeNextPath(raw)).toBeNull();
    }
  });

  it('refuses another host: //host, /\\host, a backslash anywhere, an absolute URL', () => {
    for (const raw of ['//evil.com', '/\\evil.com', '/inventory\\..\\x', 'https://evil.com', 'javascript:alert(1)']) {
      expect(safeNextPath(raw)).toBeNull();
    }
  });

  it('refuses whitespace and control characters, which browsers strip or rewrite', () => {
    for (const raw of ['/x y', '/x\t', '/x\n', '/\t/evil.com', '/\n/evil.com', '/x\r', '/x\u0000', '/x\u007f']) {
      expect(safeNextPath(raw)).toBeNull();
    }
  });

  it('refuses a login page in any case, with or without a query, slash or hash', () => {
    for (const raw of ['/staff-login', '/STAFF-LOGIN?next=/x', '/login', '/login/', '/login#x', '/signup', '/customer-login']) {
      expect(safeNextPath(raw)).toBeNull();
    }
  });

  it('refuses API calls and Next.js internals', () => {
    for (const raw of ['/api/spools', '/_next/x']) expect(safeNextPath(raw)).toBeNull();
  });

  it('refuses a path over 512 characters', () => {
    expect(safeNextPath('/' + 'a'.repeat(SAFE_NEXT_MAX))).toBeNull();
  });

  it("refuses '.' and '..' segments, which URL parsing turns into //host", () => {
    for (const raw of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/%2E%2E//evil.com', '/./inventory']) {
      expect(safeNextPath(raw)).toBeNull();
    }
    // Dots inside a segment or in the query are fine.
    expect(safeNextPath('/inventory/v1.2?q=..')).toBe('/inventory/v1.2?q=..');
  });
});

describe('SPOOL_QR_PATH (the only next staff login forwards a signed-in user to)', () => {
  it('matches a QR spool page and nothing else', () => {
    expect(SPOOL_QR_PATH.test('/inventory/spool/PF-A7X2')).toBe(true);
    for (const path of ['/', '/inventory', '/inventory/spool/PF-A7X2?x=1', '/inventory/spool/PF-A7X2/edit', '/settings/users', '/inventory/spool/']) {
      expect(SPOOL_QR_PATH.test(path)).toBe(false);
    }
  });
});
