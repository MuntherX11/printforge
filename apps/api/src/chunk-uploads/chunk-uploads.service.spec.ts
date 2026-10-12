import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** `discard` (spec §4.3): imports keep staged uploads until their transaction commits. */

describe('ChunkUploadsService consume(keep) + discard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-chunks-'));
  let svc: any;

  beforeAll(() => {
    process.env.UPLOAD_DIR = dir;
    jest.isolateModules(() => {
      const { ChunkUploadsService } = require('./chunk-uploads.service');
      svc = new ChunkUploadsService();
    });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function staged(bytes: string) {
    const { id } = await svc.init('big.3mf');
    await svc.putPart(id, 0, { buffer: Buffer.from(bytes), size: bytes.length });
    await svc.complete(id, 1);
    return id as string;
  }

  it('a kept upload can be read again (a retry after a failed import), then discarded', async () => {
    const id = await staged('hello');
    expect((await svc.consume(id, 1000, { keep: true })).buffer.toString()).toBe('hello');
    expect((await svc.consume(id, 1000, { keep: true })).buffer.toString()).toBe('hello');
    await svc.discard(id);
    await expect(svc.consume(id, 1000, { keep: true })).rejects.toThrow('Unknown or expired upload — start again');
  });

  it('claim: of two requests for one upload exactly one gets it (409 for the other); release hands it back; discard ends it', async () => {
    const id = await staged('model');
    const results = await Promise.allSettled([svc.claim(id), svc.claim(id), svc.claim(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r.reason.getStatus()).toBe(409);
      expect(r.reason.message).toBe('This upload is already being used');
    }
    // A claimed upload can still be read by the request that holds it.
    expect((await svc.consume(id, 1000, { keep: true })).buffer.toString()).toBe('model');
    await svc.release(id);
    await expect(svc.claim(id)).resolves.toBeUndefined();
    await svc.discard(id);
    await expect(svc.claim(id)).rejects.toThrow('Unknown or expired upload — start again');
    await expect(svc.release(id)).resolves.toBeUndefined();
    await expect(svc.claim('../etc')).rejects.toThrow('Invalid upload id');
  });

  it('discarding a missing upload is not an error; a malformed id is a 400', async () => {
    await expect(svc.discard('0f8fe0a8-1111-4222-8333-944455556666')).resolves.toBeUndefined();
    await expect(svc.discard('../etc')).rejects.toThrow('Invalid upload id');
  });
});
