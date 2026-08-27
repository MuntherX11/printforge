/**
 * Get a big file to the API through Cloudflare's 100 MB per-request cap.
 *
 * Files under the threshold are untouched — the caller appends them to its
 * FormData exactly as before. A larger file is sliced into 45 MB parts, each
 * PUT separately (every request far below the cap), reassembled server-side,
 * and the caller sends the returned id in `assembledUploadId` /
 * `assembledUploadIds` instead of the file part. The consuming endpoint
 * re-applies its own size limit to the assembled file, so this changes how the
 * bytes travel, not what is allowed.
 */

const API_BASE = '/api';

// Comfortably under Cloudflare's cap once multipart overhead is added.
const PART_BYTES = 45 * 1024 * 1024;
// Anything below this goes as a normal single-request upload.
export const CHUNK_THRESHOLD = 90 * 1024 * 1024;

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || body?.message || `HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.data !== undefined ? json.data : json;
}

/** Stage one large file; resolves to the assembled-upload id. */
export async function stageLargeFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const init = await jsonOrThrow(
    await fetch(`${API_BASE}/chunk-uploads`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name }),
    }),
  );

  const totalParts = Math.ceil(file.size / PART_BYTES);
  for (let i = 0; i < totalParts; i++) {
    const slice = file.slice(i * PART_BYTES, (i + 1) * PART_BYTES);
    const fd = new FormData();
    fd.append('part', slice, `${i}.part`);

    // One retry per part: a single flaky request shouldn't scrap a 300 MB
    // upload that is otherwise nine-tenths done.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await jsonOrThrow(
          await fetch(`${API_BASE}/chunk-uploads/${init.id}/parts/${i}`, {
            method: 'PUT',
            credentials: 'include',
            body: fd,
          }),
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    onProgress?.((i + 1) / totalParts);
  }

  await jsonOrThrow(
    await fetch(`${API_BASE}/chunk-uploads/${init.id}/complete`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalParts }),
    }),
  );

  return init.id as string;
}

/**
 * Split a file list for a multi-file endpoint: small ones stay as file parts,
 * big ones are staged and come back as ids for `assembledUploadIds`.
 */
export async function splitAndStage(
  files: File[],
  onProgress?: (fraction: number) => void,
): Promise<{ direct: File[]; assembledIds: string[] }> {
  const direct = files.filter((f) => f.size < CHUNK_THRESHOLD);
  const big = files.filter((f) => f.size >= CHUNK_THRESHOLD);
  const assembledIds: string[] = [];
  let done = 0;
  for (const f of big) {
    assembledIds.push(
      await stageLargeFile(f, (p) => onProgress?.((done + p) / big.length)),
    );
    done++;
  }
  return { direct, assembledIds };
}
