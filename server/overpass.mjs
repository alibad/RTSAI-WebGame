import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
export const completeOverpass = p => p && Array.isArray(p.elements) && !p.remark;

export function createOverpassRelay({ cacheDir, mirrors = MIRRORS, request = fetch, timeout = 42000 }) {
  return async (req, res) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 20000) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const dir = typeof cacheDir === 'function' ? cacheDir() : cacheDir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, crypto.createHash('sha1').update(body).digest('hex') + '.json');
      try {
        const bytes = fs.readFileSync(file);
        if (completeOverpass(JSON.parse(bytes))) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-RTSAI-Overpass': 'saved' }); res.end(bytes); return;
        }
      } catch { /* Missing or invalid cache entries must never count as successful geography. */ }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
      let result;
      // Two independent mirrors at a time, within the page's deadline. Cancel remaining work on success/disconnect.
      for (let i = 0; i < mirrors.length && !signal.aborted; i += 2) {
        try {
          result = await Promise.any(mirrors.slice(i, i + 2).map(async endpoint => {
            const response = await request(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'RTSAI-WebGame/1.0 (local map editor relay)' }, signal });
            if (!response.ok) throw Error(`Provider ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > 20_000_000 || !completeOverpass(JSON.parse(bytes))) throw Error('Incomplete provider response');
            return { endpoint, bytes };
          }));
          break;
        } catch { /* Try the next pair if time remains. */ }
      }
      signal.throwIfAborted();
      if (!result) throw Error('No complete provider response');
      fs.writeFileSync(file, result.bytes);
      fs.writeFileSync(file.replace(/\.json$/, '.source.json'), JSON.stringify({ query: new URLSearchParams(body).get('data'), endpoint: result.endpoint, fetchedAt: new Date().toISOString() }, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-RTSAI-Overpass': 'live' }); res.end(result.bytes);
    } catch {
      if (!controller.signal.aborted && !res.writableEnded) { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end('{"error":"Geography service unavailable"}'); }
    } finally { controller.abort(); res.off('close', disconnected); }
  };
}
