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

  it('discarding a missing upload is not an error; a malformed id is a 400', async () => {
    await expect(svc.discard('0f8fe0a8-1111-4222-8333-944455556666')).resolves.toBeUndefined();
    await expect(svc.discard('../etc')).rejects.toThrow('Invalid upload id');
  });
});
