/**
 * Fetch a model from a URL, caching it in OPFS so subsequent loads are
 * instant. Streams the download chunk-by-chunk straight into OPFS so memory
 * peak during fetch stays at one chunk (the final read-back is bounded by
 * the bytes ORT will eventually consume anyway).
 *
 * Public surface:
 *   getModelBytes({ url, key, onProgress }) -> Promise<Uint8Array>
 *   listCachedKeys() -> Promise<string[]>
 *   deleteCached(key) -> Promise<void>
 *
 * onProgress({ phase, loaded, total, etaSec }) is called repeatedly during
 * download ('fetching'), and once at the end ('ready').
 */

const OPFS_DIR = 'bs-roformer-web';

const getDir = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR, { create: true });

async function getHandleIfExists(dir, name) {
  try { return await dir.getFileHandle(name); }
  catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}

export async function listCachedKeys() {
  const dir = await getDir();
  const out = [];
  for await (const name of dir.keys()) if (!name.endsWith('.part')) out.push(name);
  return out.sort();
}

export async function deleteCached(key) {
  const dir = await getDir();
  await dir.removeEntry(key).catch(() => {});
}

// Download `url` to OPFS under `key`, streaming chunks straight into the
// file. Writes to `${key}.part` first so a half-finished download never
// looks like a cached model.
async function downloadToOPFS(url, key, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url}: ${resp.status} ${resp.statusText}`);
  const total = +resp.headers.get('content-length') || 0;

  const dir = await getDir();
  const tmpKey = `${key}.part`;
  const tmpHandle = await dir.getFileHandle(tmpKey, { create: true });
  const writable = await tmpHandle.createWritable();

  const reader = resp.body.getReader();
  let loaded = 0;
  const t0 = performance.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      const elapsed = (performance.now() - t0) / 1000;
      const etaSec = total && loaded ? elapsed * (total - loaded) / loaded : undefined;
      onProgress?.({ phase: 'fetching', loaded, total, etaSec });
    }
  } finally {
    await writable.close();
  }

  // Promote .part -> key. Some browsers don't yet support FileSystemHandle.move,
  // so fall back to a byte-copy in that case (one extra OPFS pass).
  await dir.removeEntry(key).catch(() => {});
  if (tmpHandle.move) {
    await tmpHandle.move(key);
  } else {
    const finalH = await dir.getFileHandle(key, { create: true });
    const w = await finalH.createWritable();
    await w.write(await (await tmpHandle.getFile()).arrayBuffer());
    await w.close();
    await dir.removeEntry(tmpKey).catch(() => {});
  }
}

export async function getModelBytes({ url, key, onProgress }) {
  const dir = await getDir();
  if (!(await getHandleIfExists(dir, key))) {
    await downloadToOPFS(url, key, onProgress);
  }
  const file = await (await dir.getFileHandle(key)).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  onProgress?.({ phase: 'ready', loaded: bytes.byteLength, total: bytes.byteLength });
  return bytes;
}
