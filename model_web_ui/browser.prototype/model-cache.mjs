// Cache only verified model bytes. The manifest hash is the model version.
export const MODEL_CACHE = 'apex-models-v1';

export async function loadCachedModel({ url, manifest, download, onStatus = () => {},
  storage = globalThis.caches, crypto = globalThis.crypto }) {
  const hash = manifest?.sha256?.toLowerCase();
  const size = manifest?.bytes;
  if (!/^[a-f0-9]{64}$/.test(hash || '') || !Number.isSafeInteger(size) || size <= 0 || !crypto?.subtle) {
    onStatus('当前环境无法校验模型缓存，本次直接下载…');
    return download(url);
  }
  const key = new URL(url);
  key.searchParams.set('sha256', hash);
  async function valid(bytes) {
    if (bytes.byteLength !== size) return false;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') === hash;
  }
  let cache;
  try {
    cache = await storage?.open(MODEL_CACHE);
    const response = await cache?.match(key.href);
    if (response) {
      onStatus('正在读取本地模型缓存…');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (await valid(bytes)) {
        onStatus('本地模型缓存已就绪，无需下载');
        return bytes;
      }
      await cache.delete(key.href);
      onStatus('模型缓存校验失败，正在重新下载…');
    }
  } catch {
    cache = null;
    onStatus('本地模型缓存不可用，本次直接下载…');
  }
  const bytes = await download(url);
  onStatus('正在校验模型文件…');
  if (!await valid(bytes)) throw new Error('模型文件校验失败，请重试或检查服务器模型清单与文件是否一致');
  if (cache) {
    try {
      await cache.put(key.href, new Response(bytes, { headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
      } }));
      onStatus('模型已缓存，下次使用无需重复下载');
    } catch {
      onStatus('模型已加载，但本地缓存保存失败；下次可能需要重新下载');
    }
  }
  return bytes;
}
