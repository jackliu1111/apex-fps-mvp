const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const ASSETS = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/transport.js', ['transport.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' apex:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Controlled UI and registered media protocol; paths are never renderer inputs. */
function createProtocolHandler(client, { uiDir, hostDir }) {
  return async request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 405 });
      const url = new URL(request.url);
      if (url.protocol !== 'apex:' || url.username || url.password) return new Response('', { status: 404 });
      if (url.hostname === 'ui') {
        const hostAssets = hostDir && new Map([['/', ['host.html', 'text/html']], ['/index.html', ['host.html', 'text/html']],
          ['/host.js', ['host.js', 'text/javascript']], ['/react.js', ['node_modules/react/umd/react.production.min.js', 'text/javascript']],
          ['/react-dom.js', ['node_modules/react-dom/umd/react-dom.production.min.js', 'text/javascript']]]);
        const hostAsset = hostAssets && hostAssets.get(url.pathname);
        const asset = hostAsset || (url.pathname === '/shared.html' ? ['index.html', 'text/html'] : ASSETS.get(url.pathname));
        if (!asset || url.search) return new Response('', { status: 404 });
        const data = fs.readFileSync(path.join(hostAsset ? hostDir : uiDir, asset[0]));
        return new Response(request.method === 'HEAD' ? null : data, { headers: {
          'Content-Type': asset[1], 'Content-Length': String(data.length),
          'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        } });
      }
      if (url.hostname !== 'artifact' || !/^\/[0-9a-f]{32}$/.test(url.pathname) || url.search)
        return new Response('', { status: 404 });
      const artifact = await client.execute('get_artifact', { artifact_id: url.pathname.slice(1) });
      const stat = fs.statSync(artifact.path);
      if (!stat.isFile() || stat.size !== artifact.size) return new Response('', { status: 409 });
      let start = 0, end = stat.size - 1, status = 200;
      const headers = { 'Content-Type': artifact.content_type, 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      const range = request.headers.get('Range');
      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!parsed || (!parsed[1] && !parsed[2])) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        if (!parsed[1]) start = Math.max(0, stat.size - Number(parsed[2]));
        else { start = Number(parsed[1]); if (parsed[2]) end = Math.min(end, Number(parsed[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size)
          return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = String(end - start + 1);
      const body = request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(artifact.path, { start, end }));
      return new Response(body, { status, headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: { code: error.code || 'artifact_unavailable', message: error.message } }),
        { status: error.status || 503, headers: { 'Content-Type': 'application/json' } });
    }
  };
}
module.exports = { createProtocolHandler };
