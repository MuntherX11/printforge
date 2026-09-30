import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';

/** The generic audit row: action from the route's entity and its terminal segment. */

function run(req: Record<string, unknown>, response: unknown = { ok: true }) {
  const audit = { log: jest.fn(async () => ({})) };
  const interceptor = new AuditInterceptor(audit as never);
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(response) };
  return { audit, done: lastValueFrom(interceptor.intercept(ctx, next)) };
}

const user = { id: 'u1' };

describe('AuditInterceptor', () => {
  it('POST …/variants/:variantId/convert-to-layout → Product.convertedToLayout on the product', async () => {
    const { audit, done } = run({
      method: 'POST', user, url: '/api/products/p1/variants/v1/convert-to-layout',
      route: { path: '/api/products/:id/variants/:variantId/convert-to-layout' },
      params: { id: 'p1', variantId: 'v1' }, body: { componentId: 'c1', unitsPerPlate: 50 },
    }, { layout: { id: 'l1' }, option: { id: 'v1' }, warnings: [] });
    await done;
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', action: 'Product.convertedToLayout', entityType: 'Product', entityId: 'p1',
      details: expect.objectContaining({ method: 'POST', body: { componentId: 'c1', unitsPerPlate: 50 } }),
    }));
  });

  it('the GET preview on the same path is not logged', async () => {
    const { audit, done } = run({
      method: 'GET', user, url: '/api/products/p1/variants/v1/convert-to-layout?componentId=c1&unitsPerPlate=50',
      route: { path: '/api/products/:id/variants/:variantId/convert-to-layout' }, params: { id: 'p1', variantId: 'v1' },
    });
    await done;
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('existing mappings are unchanged: POST /jobs/:id/complete → Job.completed; a plain PATCH → updated', async () => {
    const a = run({ method: 'POST', user, url: '/api/jobs/j1/complete', route: { path: '/api/jobs/:id/complete' }, params: { id: 'j1' }, body: {} });
    await a.done;
    expect(a.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'Job.completed', entityId: 'j1' }));
    const b = run({ method: 'PATCH', user, url: '/api/products/p1/variants/v1', route: { path: '/api/products/:id/variants/:variantId' }, params: { id: 'p1' }, body: {} });
    await b.done;
    expect(b.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'Product.updated' }));
  });

  it('the terminal action comes from the matched route, whatever the URL\'s case or trailing slash', async () => {
    for (const url of ['/api/JOBS/j1/Complete', '/api/jobs/j1/complete/']) {
      const r = run({ method: 'POST', user, url, route: { path: '/api/jobs/:id/complete' }, params: { id: 'j1' }, body: {} });
      await r.done;
      expect(r.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'Job.completed', entityId: 'j1' }));
    }
  });
});
