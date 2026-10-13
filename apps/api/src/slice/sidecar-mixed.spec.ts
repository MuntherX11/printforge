import { SidecarSliceClient, type SidecarMixedSliceRequest } from './sidecar-slice.client';

/**
 * The second shape of `POST /slice` (v2.19.0): several models on one plate.
 * The client sends the request as it is and reads the units placed per input
 * from `X-Input-Units`, and the input to blame from a failure's body.
 */

const req: SidecarMixedSliceRequest = {
  inputs: [{ inputPath: 'attachments/a.stl', kind: 'stl', copies: 3 }, { inputPath: 'attachments/b.3mf', kind: '3mf', copies: 2 }],
  machine: { raw: { name: 'K1' } }, process: { raw: { name: '0.20mm' } }, filaments: [{ raw: { name: 'PLA' }, density: '1.24' }], siblings: [],
};

describe('SidecarSliceClient — mixed request', () => {
  const realFetch = global.fetch;
  const prevUrl = process.env.SLICER_URL;
  beforeEach(() => { process.env.SLICER_URL = 'http://slicer:8080/'; });
  afterEach(() => {
    global.fetch = realFetch;
    if (prevUrl === undefined) delete process.env.SLICER_URL;
    else process.env.SLICER_URL = prevUrl;
  });

  const answer = (status: number, body: string, headers: Record<string, string> = {}) => {
    const fetchMock = jest.fn(async () => new Response(body, { status, headers }));
    global.fetch = fetchMock as any;
    return fetchMock;
  };

  it('posts the inputs unchanged — no top-level inputPath, kind or copies — and reads the units per input', async () => {
    const fetchMock = answer(200, 'G28\n', { 'X-Input-Units': '[3,0]', 'X-Plate-Files': '1' });
    const out = await new SidecarSliceClient().slice(req);
    expect(out).toMatchObject({ ok: true, plateFiles: 1, inputUnits: [3, 0] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://slicer:8080/slice');
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual(req);
    expect(Object.keys(sent).sort()).toEqual(['filaments', 'inputs', 'machine', 'process', 'siblings']);
  });

  it('a missing or unreadable header is null, never a guess', async () => {
    answer(200, 'G28\n');
    expect(await new SidecarSliceClient().slice(req)).toMatchObject({ ok: true, inputUnits: null });
    answer(200, 'G28\n', { 'X-Input-Units': 'three' });
    expect(await new SidecarSliceClient().slice(req)).toMatchObject({ ok: true, inputUnits: null });
  });

  it('a failure names the input that is to blame, when the slicer says which', async () => {
    answer(400, JSON.stringify({ error: 'the project holds no objects', exitCode: null, logTail: '', input: 1 }), { 'Content-Type': 'application/json' });
    expect(await new SidecarSliceClient().slice(req)).toEqual({ ok: false, code: 'BAD_SLICE_INPUT', message: 'the project holds no objects', exitCode: null, logTail: '', input: 1 });
    answer(500, JSON.stringify({ error: 'orca-slicer exited with code 235', exitCode: 235, logTail: 'x', input: 'second' }), { 'Content-Type': 'application/json' });
    expect(await new SidecarSliceClient().slice(req)).toMatchObject({ ok: false, code: 'SLICER_FAILED', exitCode: 235, input: null });
  });
});
