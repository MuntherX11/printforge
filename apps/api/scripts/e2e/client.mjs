/**
 * HTTP client, pacing and assertions for product-rework-e2e.mjs (spec §7.2).
 * Node 20+: global fetch, FormData and Blob.
 */

export class AssertionError extends Error {}

export function check(cond, message) {
  if (!cond) throw new AssertionError(message);
}

export function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${what}: expected ${e}, got ${a}`);
}

/** Money and grams compare at 3 dp. */
export function near(actual, expected, what, tol = 0.0005) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    throw new AssertionError(`${what}: expected ${expected}, got ${JSON.stringify(actual)}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One pacer for every session: the API throttles per route at 10/s, 50/10 s and
 * 200/min (app.module.ts), shared by everyone behind nginx. Requests start at
 * most every `intervalMs`; a 429 is retried after Retry-After.
 */
export class Pacer {
  constructor(intervalMs = 220) {
    this.intervalMs = intervalMs;
    this.next = 0;
    this.retries429 = 0;
  }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await sleep(at - now);
  }
}

export class Session {
  /**
   * @param {string} name for logs
   * @param {string} api base URL including /api
   * @param {Pacer} pacer
   */
  constructor(name, api, pacer) {
    this.name = name;
    this.api = api.replace(/\/$/, '');
    this.pacer = pacer;
    this.cookie = null;
    this.userId = null;
  }

  /**
   * @param {string} method
   * @param {string} path  starting with '/'
   * @param {{ json?: any, form?: FormData, expect?: number|number[], burst?: boolean, raw?: boolean, noCookie?: boolean }} [opts]
   * @returns {Promise<{ status: number, headers: Headers, body: any, data: any, buf: Buffer|null, ms: number }>}
   */
  async req(method, path, opts = {}) {
    const headers = {};
    if (this.cookie && !opts.noCookie) headers.cookie = this.cookie;
    let body;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    for (let attempt = 0; ; attempt++) {
      if (!opts.burst) await this.pacer.wait();
      const t0 = performance.now();
      const res = await fetch(this.api + path, { method, headers, body, redirect: 'manual' });
      const buf = Buffer.from(await res.arrayBuffer());
      const ms = performance.now() - t0;
      if (res.status === 429 && !opts.burst && attempt < 6) {
        this.pacer.retries429++;
        const ra = Number(res.headers.get('retry-after'));
        await sleep((Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000 + 250);
        continue;
      }
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
      for (const c of cookies) {
        const m = /^token=([^;]*)/.exec(c.trim());
        if (m) this.cookie = m[1] ? `token=${m[1]}` : null;
      }
      let json = null;
      const type = res.headers.get('content-type') || '';
      if (!opts.raw && type.includes('application/json') && buf.length) {
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
      }
      const out = { status: res.status, headers: res.headers, body: json, data: json && 'data' in json ? json.data : json, buf, ms };
      if (opts.expect !== undefined) {
        const ok = Array.isArray(opts.expect) ? opts.expect.includes(res.status) : res.status === opts.expect;
        if (!ok) {
          const err = json?.error ?? json?.message ?? buf.toString('utf8').slice(0, 300);
          throw new AssertionError(`${this.name} ${method} ${path}: expected HTTP ${opts.expect}, got ${res.status} (${typeof err === 'string' ? err : JSON.stringify(err)})`);
        }
      }
      return out;
    }
  }

  get(path, opts) { return this.req('GET', path, opts); }
  post(path, json, opts = {}) { return this.req('POST', path, { ...opts, json }); }
  put(path, json, opts = {}) { return this.req('PUT', path, { ...opts, json }); }
  patch(path, json, opts = {}) { return this.req('PATCH', path, { ...opts, json }); }
  del(path, opts) { return this.req('DELETE', path, opts); }

  /** 2xx expected; returns the unwrapped `data`. */
  async ok(method, path, json, opts = {}) {
    const r = await this.req(method, path, { ...opts, json, expect: opts.expect ?? [200, 201] });
    return r.data;
  }

  async loginStaff(email, password) {
    const r = await this.post('/auth/login', { email, password }, { expect: 200 });
    check(this.cookie, `${this.name}: login set no cookie`);
    this.userId = r.data?.user?.id ?? null;
    return r.data?.user;
  }

  async loginCustomer(email, password) {
    const r = await this.post('/auth/customer/login', { email, password }, { expect: 200 });
    check(this.cookie, `${this.name}: customer login set no cookie`);
    this.userId = r.data?.user?.id ?? null;
    return r.data?.user;
  }
}

/** Median of timed runs after one warm-up (spec §7.2 step 23). */
export async function medianMs(fn, runs = 3) {
  await fn();
  const times = [];
  for (let i = 0; i < runs; i++) times.push((await fn()).ms);
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}
