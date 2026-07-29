# Addon Generator Framework

How a **separately-built addon** plugs a server-side generator into PrintForge so it can take
customer orders.

Addons are always built and shipped on their own — nothing is bundled into PrintForge. An addon
opts in by adding one block to `addon.json` and shipping one Node module in its zip. PrintForge
supplies the entire security envelope around it.

> Read [ADDONS.md](ADDONS.md) first for the zip/manifest basics. This document covers the
> **server-side generator** only — the piece that turns customer parameters into a production file.

---

## 1. Why a server generator at all

The customer configures in the browser, but the browser **never** supplies the model. On order
placement the **server** regenerates the artifact from the submitted parameters and attaches it to
the order; an employee downloads it later from the dashboard.

That rule is not negotiable: our code produces bounded, watertight, well-formed geometry *because
it is our code*. Accepting a customer-supplied mesh would turn the order pipeline into a
malware-delivery channel aimed at the employee's slicer.

So an addon that wants to take orders must be able to produce its geometry **in Node, headlessly**.
Rendering in three.js inside a canvas is not enough (see §7).

---

## 2. Opt in from `addon.json`

```json
{
  "slug": "oman-plate-generator",
  "name": "Oman Plate Generator",
  "description": "Parametric Omani number plates",
  "icon": "Shapes",
  "version": "1.0.0",
  "entry": "index.html",

  "generator": {
    "module": "server/generator.mjs",
    "apiVersion": 1
  }
}
```

| Field | Meaning |
|---|---|
| `generator.module` | Path **inside the addon zip** to the server module. Traversal outside the addon directory is rejected. |
| `generator.apiVersion` | Contract version. Currently `1`. A mismatch is skipped with a warning, never a crash. |

Omit the `generator` block entirely and the addon stays UI-only — exactly as addons behave today.

---

## 3. The module contract

`server/generator.mjs` is a plain **ES module**. It is `import()`ed by the API, so it may use
ESM syntax and top-level `await` even though the API itself compiles to CommonJS.

```js
export const apiVersion = 1;

/** Field definitions for the configurator UI. Static, no I/O. */
export function choices() {
  return { fields: [
    { key: 'number', label: 'Plate number', type: 'text', pattern: '^\\d{1,5}$', default: '1234' },
    { key: 'height', label: 'Height (mm)', type: 'number', min: 20, max: 300, default: 20 },
  ] };
}

/**
 * Validate + normalise raw client input into a trusted spec.
 * THROW on anything invalid — the thrown message becomes a clean 400.
 * This is the security boundary: the UI is not a control.
 */
export function validate(raw) {
  const n = String(raw?.number ?? '').trim();
  if (!/^\d{1,5}$/.test(n)) throw new Error('Number must be 1-5 digits');
  const height = Number(raw?.height);
  if (!Number.isFinite(height) || height <= 0 || height > 300) {
    throw new Error('height must be between 1 and 300 mm');
  }
  return { number: n, height };           // <- becomes the order's source of truth
}

/** Dimensions + advisories for the preview panel. No disk writes. */
export function info(spec) {
  return {
    dimensions: { width: spec.height * 4.69, height: spec.height, depth: 2.4 },
    warnings: [],
    label: `Plate ${spec.number}`,
    estimatedGrams: 12.4,
  };
}

/** Optional lightweight preview. No disk writes. Must contain no script. */
export function previewSvg(spec) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30">...</svg>`;
}

/** Produce the artifact. Called ONCE, at order-commit. */
export async function generate(spec) {
  return [
    { filename: `plate-${spec.number}.3mf`, mime: 'model/3mf', body: Buffer.from(/* ... */) },
    { filename: `plate-${spec.number}.stl`, mime: 'model/stl', body: Buffer.from(/* ... */) },
  ];
}
```

**Required:** `validate`, `info`, `generate`. **Optional:** `choices`, `previewSvg`, `apiVersion`.
A module missing a required export is skipped with a log warning — it never breaks the API.

### Rules your module must follow

| Rule | Why |
|---|---|
| `validate()` throws on **every** invalid input — non-finite, zero, negative, out-of-range | The customer can call the endpoint directly, bypassing your UI |
| `validate()` returns a **plain JSON-serialisable object** | It is persisted as the order's source of truth |
| `info()` / `previewSvg()` **never touch disk** | Previews run on every keystroke; only order-commit may write |
| `generate()` returns `Buffer` bodies | Streams/paths are rejected |
| Filenames are built from **validated fields only** | They become a download header; never a path |
| No customer string in any path you construct | Path traversal is structurally impossible if you never do this |

---

## 4. What PrintForge guarantees around you

You write validation + geometry. The host supplies everything else, and **re-checks your output**
at the boundary — so a bug in an addon degrades to a clean error, not a vulnerability.

- **Opaque storage** — artifacts are stored under a server-generated random 32-hex key. Your
  filename is used only for `Content-Disposition`, and is re-sanitised.
- **Authorized download** — artifacts are reachable only through an authenticated staff route that
  verifies the artifact belongs to the order. Never served from a static directory.
- **Rate limiting** — order creation is capped per session.
- **Concurrency cap** — the CPU-bound `generate()` step runs behind a semaphore; overload sheds
  with a 503 instead of taking the host down.
- **Output ceilings** — max 12 files, 64 MB each, filename must match `^[a-zA-Z0-9._-]{1,120}$`.
- **Error hygiene** — anything your `validate()` throws becomes a short 400. Stack traces are
  never returned to a client.
- **Preview scrubbing** — a `previewSvg()` containing script content is suppressed entirely.
- **Retention** — artifacts for terminal orders are pruned on a schedule; parameters persist so any
  artifact can be regenerated.

---

## 5. Uploads (fonts, SVG) — the highest-risk surface

If your generator accepts customer **SVG** or **font** uploads, treat it as the most dangerous part
of the system:

- SVG must be sanitized server-side before storage or display. PrintForge exposes a sanitizer
  (`sanitizeSvg`) that strips `<script>`, event handlers and `javascript:` URIs, and **rejects**
  `<!DOCTYPE>`/`<!ENTITY>` (XXE, billion-laughs) and oversized input. It fails closed.
- **Never** render raw uploaded SVG bytes in the dashboard — show a server-produced preview.
- Parse fonts under a size limit and a timeout. A parse failure is a rejected input (4xx), not a 500.
- Store uploaded originals under the same opaque-key rule as artifacts.

---

## 6. Trust model — read before shipping

The generator module is `import()`ed and **executed in-process with API privileges**. Addon upload
is ADMIN-only, so this matches the existing addon trust model: **internal / proprietary code you
control**.

Do **not** enable generator modules for third-party or untrusted addons. If that becomes a
requirement, generation must move out-of-process — see §8.

---

## 7. Porting an existing browser addon

Most existing addons render geometry inside three.js/React, which cannot run headlessly as-is.
Practical routes, cheapest first:

1. **Already pure Node?** (e.g. `oman-plate-generator`, which is ESM with `earcut` / `opentype.js` /
   `polygon-clipping` and a CLI) — write a thin `server/generator.mjs` that maps the contract onto
   your existing `resolveSpec()` / `buildPlate()` and bundle it in the addon zip. Smallest job.
2. **Geometry tangled in the render layer** (three.js `BufferGeometry`, R3F components) — extract the
   mesh-building maths into a framework-free module both the browser and the server import. This is
   the real work; do it once and both sides stay in sync by construction.
3. **WASM (Manifold / HarfBuzz)** — these run in Node, but the browser glue usually assumes `fetch`
   and `import.meta.url`. Load the `.wasm` from disk in the server path.

Whichever route, the acceptance test is the same: **can you produce the artifact from parameters
alone, in Node, with no DOM?**

---

## 8. If you ever need untrusted generators

Move generation to a **sidecar service**: the addon ships a small HTTP service exposing
`validate` / `info` / `generate`; PrintForge calls it server-to-server and applies the same envelope
to the response. That buys process isolation, independent resource limits, and any language — at the
cost of another deployment unit per addon. The module contract above is deliberately shaped so the
same code can be served either way.

---

## 9. Checklist

- [ ] `addon.json` declares `generator.module` + `apiVersion: 1`
- [ ] Module exports `validate`, `info`, `generate` (plus optional `choices`, `previewSvg`)
- [ ] `validate()` bounds **every** dimensional input — non-finite, zero, negative, upper bound
- [ ] `validate()` returns a plain serialisable object
- [ ] `info()` and `previewSvg()` perform no I/O
- [ ] `generate()` returns `Buffer` bodies with safe filenames
- [ ] Any SVG/font upload is sanitized and size/time bounded
- [ ] Produces its artifact headlessly in Node — verified without a browser
