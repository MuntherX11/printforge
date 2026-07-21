# Building & Bundling PrintForge Addons

How to package a web app as a `.zip` that an admin can upload in **Settings → Addons**.

An addon is a **self-contained static web app** served from PrintForge and rendered in a
sandboxed iframe at `/addons/{slug}`. Active addons appear automatically in the staff sidebar.
No redeploy is needed to add one.

---

## 1. The zip layout

The archive must contain an **`addon.json` manifest** sitting next to your **entry HTML file**:

```
my-addon.zip
├── addon.json          ← required manifest
├── index.html          ← entry (name it whatever `entry` says)
├── assets/
│   ├── app-a1b2c3.js
│   └── app-a1b2c3.css
└── fonts/ , models/ , whatever else you need
```

A wrapper folder is fine — the installer finds `addon.json` anywhere and treats **its folder**
as the addon root, stripping the prefix. Both of these work:

```
zip root/addon.json          ✅ flat
zip root/dist/addon.json     ✅ zipped folder — dist/ becomes the root
```

### Zipping rules

| Rule | Why |
|---|---|
| Use **forward slashes** in entry paths | Windows `Compress-Archive` writes backslashes. The installer normalizes them, but forward slashes are safest. |
| Zip the **contents**, not the parent (or wrap consistently) | `addon.json` must be findable and co-located with the entry. |
| **Max 200 MB** compressed | Enforced by the upload endpoint; nginx allows the same. |
| Don't include `node_modules/`, `.git/`, or source | Ship the **built output** only. |

Reliable cross-platform zip (Node, forward slashes guaranteed):

```js
import { zipSync } from 'fflate';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function walk(dir, base = '') {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;   // always forward slash
    if (statSync(full).isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full);
  }
  return out;
}
writeFileSync('my-addon.zip', zipSync(walk('dist'), { level: 6 }));
```

---

## 2. `addon.json`

```json
{
  "slug": "pressprint-studio",
  "name": "PressPrint Studio",
  "description": "3D jersey and name/number press-print studio",
  "icon": "Shirt",
  "version": "1.0.0",
  "entry": "index.html"
}
```

| Field | Required | Notes |
|---|---|---|
| `slug` | ✅ | Lowercase letters, digits, hyphens. Must match `^[a-z0-9][a-z0-9-]{1,40}$` (2–41 chars). Becomes the URL `/addons/{slug}` and the folder on disk. **Re-uploading the same slug replaces the addon in place.** |
| `name` | ✅ | Shown in the sidebar and Settings. Max 120 chars. |
| `description` | — | Shown in Settings. Max 500 chars. |
| `icon` | — | A name from the supported list below. Unknown names fall back to `Puzzle`. |
| `version` | — | Free-form, e.g. `1.0.0`. Defaults to `0.0.0`. |
| `entry` | — | Entry HTML relative to the addon root. Defaults to `index.html`. Must exist in the zip or the upload is rejected. |

### Supported `icon` values

`Puzzle` · `Type` · `PenTool` · `Ruler` · `Shapes` · `Sparkles` · `Wrench` · `Calculator`
`Palette` · `Box` · `Boxes` · `Package` · `FileText` · `Shirt` · `Image`

To add a new icon, extend `ADDON_ICONS` in `apps/app/src/components/sidebar.tsx` (requires a frontend deploy).

---

## 3. ⚠️ The #1 gotcha: your app is served from a **sub-path**

Addon files are served from:

```
/api/addons/serve/{slug}/…
```

**not** from the domain root. Any build that hardcodes absolute paths (`/assets/app.js`,
`/fonts/x.json`) will 404. This is the most common reason an addon shows a blank screen.

### Preferred fix — build with a relative base

**Vite:**
```js
// vite.config.ts
export default defineConfig({ base: './' })
```

**Next.js / CRA:** set the equivalent (`basePath` / `homepage`) or export a fully relative build.

Then use relative fetches, or prefix with `import.meta.env.BASE_URL`.

### Fallback — runtime shim (when you can't rebuild)

If you only have a built artifact that assumes root hosting, make the `<script>`/`<link>` refs
relative and inject this **before** your app script in the entry HTML. It rewrites absolute
URLs for both `fetch` and `XMLHttpRequest` (three.js loaders use XHR):

```html
<script>
(function () {
  var BASE = location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  if (!BASE) return;
  var rw = function (u) {
    // list the top-level folders your build requests absolutely
    return (typeof u === 'string' && /^\/(assets|fonts|teams)\//.test(u)) ? BASE + u : u;
  };
  var of = window.fetch;
  if (of) window.fetch = function (i, init) {
    try { if (typeof i === 'string') i = rw(i); else if (i && i.url) i = new Request(rw(i.url), i); } catch (e) {}
    return of.call(this, i, init);
  };
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    try { arguments[1] = rw(arguments[1]); } catch (e) {}
    return oo.apply(this, arguments);
  };
})();
</script>
<script type="module" src="./assets/index-xxxx.js"></script>
```

> Note: this shim does **not** cover `<img src="/...">` or CSS `url(/...)`. Keep those relative.

---

## 4. Content Security Policy — addons must be self-contained

Addon responses carry their own CSP:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' blob:;
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' blob: data:; worker-src 'self' blob:; child-src 'self' blob:;
object-src 'none'; frame-ancestors 'self'
```

**Practical implications:**

- ❌ **No external CDNs, Google Fonts, or third-party APIs.** `default-src`/`connect-src` are `'self'`. Bundle every dependency into the zip.
- ✅ **WebAssembly works** (`wasm-unsafe-eval`) — Manifold, HarfBuzz, ffmpeg.wasm etc. are fine.
- ✅ Web Workers and `blob:` URLs work.
- ✅ Inline `<script>` and inline styles work.
- ✅ Data URIs work for images and fonts.

### File types served

Correct `Content-Type` is set for: `.html .js .mjs .css .json .wasm .svg .png .jpg .jpeg
.webp .gif .ico .ttf .otf .woff .woff2 .map`. Anything else (`.glb`, `.fbx`, `.stl`, `.bin`, …)
is served as `application/octet-stream`, which loaders handle fine.

---

## 5. Talking to the PrintForge API (optional)

Addons run **same-origin**, so the staff session cookie is sent automatically. To call the API,
just fetch a relative path with credentials — **no token handling required**:

```js
const res = await fetch('/api/file-parser/analyze-stl?infill=20', {
  method: 'POST',
  credentials: 'include',   // sends the httpOnly session cookie
  body: formData,
});
```

The addon acts as the **logged-in staff user**. The session token is httpOnly and cannot be read
by JavaScript — cookie auth is the mechanism; don't try to pass a bearer token.

### Optional host bridge (postMessage)

The host page can hand your addon context. Listen for `printforge:init`:

```js
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  if (ev.data?.type === 'printforge:init') {
    const { apiBase, theme } = ev.data;   // apiBase = PrintForge origin, theme = 'light' | 'dark'
    // e.g. apply the host's theme
  }
});

// tell the host you're ready (optional — the overlay also clears on iframe load)
window.parent.postMessage({ type: 'printforge:ready', addon: 'my-addon' }, '*');
```

Messages you can send **to** the host:

| Message | Effect |
|---|---|
| `{ type: 'printforge:ready' }` | Signals readiness; triggers the `init` handshake. |
| `{ type: 'printforge:toast', level: 'success' \| 'error', message: '…' }` | Shows a PrintForge toast. |
| `{ type: 'printforge:navigate', path: '/orders' }` | Navigates the host app. |

This is entirely optional — a plain static app with no bridge works fine.

---

## 6. Uploading

1. Log in as **ADMIN**.
2. **Settings → Addons → Upload addon (.zip)**.
3. On success it appears in the sidebar immediately (active by default).

From Settings you can **Enable/Disable** (hides from sidebar without deleting) or **Delete**
(removes the DB row *and* the files on disk). Re-uploading the same `slug` replaces the install.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Archive is missing addon.json at its root` | Uploaded the wrong zip (e.g. source instead of build), or no manifest. | Add `addon.json` next to your entry HTML. |
| `Manifest slug must be lowercase letters, numbers, and hyphens` | Slug fails `^[a-z0-9][a-z0-9-]{1,40}$`. | Fix the slug. |
| `Entry file "…" not found in archive` | `entry` doesn't match a real file. | Correct `entry` or add the file. |
| `Unsafe path in archive` | Zip contains `../` traversal entries. | Rebuild the zip from a clean folder. |
| Upload fails / 413 | Zip over 200 MB. | Trim assets or raise the limit in `addons.controller.ts` + nginx. |
| **Blank / black screen, 404s on `/assets`** | Build assumes domain-root hosting. | Rebuild with a relative base, or add the runtime shim (§3). |
| Blank screen, CSP errors in console | Loading an external CDN/font/API. | Bundle it locally — external origins are blocked. |
| Addon not in sidebar | Disabled, or not admin/staff. | Check Settings → Addons; serving requires a logged-in staff session. |
| Stuck on "Loading …" forever | Old frontend build deployed. | Overlay clears on iframe load since `e095a9a`; rebuild the `app` container. |
| `429 Too Many Requests` on assets | Rate limiter hitting asset bursts. | Fixed in `d7dfa6a` (serve route skips all named throttlers). Ensure the api container is current. |

**Debugging tip:** if a deploy seems to have no effect, PrintForge is a PWA — a service worker
(`printforge-static-v4`) can pin old bundles. In DevTools: Application → Service Workers →
Unregister, then clear Cache Storage and hard-reload.

---

## 8. Reference implementations

| Addon | Type | Notes |
|---|---|---|
| **Name Designer** | Vite + WASM (Manifold/HarfBuzz), `base: './'` | Implements the full postMessage bridge; auto-adopts `apiBase`/theme when embedded. Source: `MuntherX11/name-designer`. |
| **PressPrint Studio** | Vite + three.js, built for root hosting | Uses the runtime path shim (§3) because the build couldn't be regenerated. ~295 MB of 3D assets. |

---

## 9. Quick checklist

- [ ] Built output only (no `node_modules`, no source)
- [ ] `addon.json` present, valid `slug`, `entry` exists
- [ ] Relative asset paths (`base: './'`) **or** runtime shim installed
- [ ] No external CDNs / fonts / APIs — everything bundled
- [ ] Forward-slash zip, under 200 MB
- [ ] Opens at `/addons/{slug}` with no console errors after upload
