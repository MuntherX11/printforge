import { ArgumentsHost, BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

function makeHost(req: Record<string, unknown> = {}) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { method: 'POST', originalUrl: '/api/products/p1', url: '/products/p1', ...req };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, {
    code,
    clientVersion: '5.22.0',
    meta,
  });
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the envelope and message of a Nest HttpException', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException('Colour slot not found'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'Colour slot not found', statusCode: 404 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('joins validation message arrays', () => {
    const { host, json } = makeHost();
    filter.catch(new BadRequestException(['a is bad', 'b is bad']), host);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'a is bad, b is bad', statusCode: 400 });
  });

  it('maps P2002 to 409 and names the target fields', () => {
    const { host, status, json } = makeHost();
    filter.catch(prismaError('P2002', { target: ['productId', 'name'] }), host);
    expect(status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0][0];
    expect(body.statusCode).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toContain('productId, name');
  });

  it('maps P2002 with a string target (index name)', () => {
    const { host, json } = makeHost();
    filter.catch(prismaError('P2002', { target: 'Product_sku_key' }), host);
    expect(json.mock.calls[0][0].error).toContain('Product_sku_key');
  });

  it('maps P2003 to 400', () => {
    const { host, status, json } = makeHost();
    filter.catch(prismaError('P2003', { field_name: 'ColourOptionSlot_materialId_fkey (index)' }), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].statusCode).toBe(400);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('maps P2025 to 404', () => {
    const { host, status, json } = makeHost();
    filter.catch(prismaError('P2025', { cause: 'Record to update not found.' }), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'Record to update not found.', statusCode: 404 });
  });

  it('returns 500 for a plain Error and logs method, URL, user id and stack', () => {
    const { host, status, json } = makeHost({ user: { id: 'user-42' } });
    const err = new Error('boom');
    filter.catch(err, host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'Internal server error', statusCode: 500 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, stack] = errorSpy.mock.calls[0];
    expect(message).toContain('POST');
    expect(message).toContain('/api/products/p1');
    expect(message).toContain('user-42');
    expect(message).toContain('boom');
    expect(stack).toBe(err.stack);
  });

  it('returns 500 for an unmapped Prisma error and logs it', () => {
    const { host, status } = makeHost();
    filter.catch(prismaError('P2034'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not leak the internal message of an unknown error', () => {
    const { host, json } = makeHost();
    filter.catch(new Error('password=hunter2'), host);
    expect(json.mock.calls[0][0].error).toBe('Internal server error');
  });

  // Safety spec §2/§3: 409 bodies carry a machine-readable code and the row they collided with.
  it('copies a string code and an existing {id, name} onto the envelope', () => {
    const { host, status, json } = makeHost();
    filter.catch(new ConflictException({ message: 'm', code: 'MATERIAL_DUPLICATE', existing: { id: 'x', name: 'n' } }), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'm', statusCode: 409, code: 'MATERIAL_DUPLICATE', existing: { id: 'x', name: 'n' } });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('copies nothing else: other keys, a non-string code and a malformed existing are dropped', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ message: 'm', secret: 's' }, {}],
      [{ message: 'm', code: 409 }, {}],
      [{ message: 'm', code: 'SPOOL_HAS_HISTORY', existing: { id: 1, name: 'n' } }, { code: 'SPOOL_HAS_HISTORY' }],
      [{ message: 'm', existing: { id: 'x', name: null } }, {}],
      [{ message: 'm', existing: 'x' }, {}],
      [{ message: 'm', existing: { id: 'x', name: 'n', price: 3 } }, { existing: { id: 'x', name: 'n' } }],
    ];
    for (const [body, extra] of cases) {
      const { host, json } = makeHost();
      filter.catch(new ConflictException(body), host);
      const sent = json.mock.calls[0][0];
      expect(sent).toEqual({ success: false, error: 'm', statusCode: 409, ...extra });
      expect(Object.keys(sent)).toEqual(['success', 'error', 'statusCode', ...Object.keys(extra)]);
    }
  });
});
