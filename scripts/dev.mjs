import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { handle } from '../lib/server.js';
import { checkSecrets } from '../lib/auth.js';

export class LocalKV {
  constructor(directory) { this.directory = resolve(directory); }
  file(key) { if (!/^[a-zA-Z0-9_]+$/.test(key)) throw new Error('Invalid key'); return resolve(this.directory, `${key}.json`); }
  async get(key) { try { return await readFile(this.file(key), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async put(key, value) {
    const { rename } = await import('node:fs/promises');
    await mkdir(this.directory, { recursive: true });
    const file = this.file(key), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, value); await rename(temporary, file);
  }
  async delete(key) { const { rm } = await import('node:fs/promises'); await rm(this.file(key), { force: true }); }
  async list({ prefix = '', limit = 256, cursor } = {}) {
    const { readdir } = await import('node:fs/promises');
    await mkdir(this.directory, { recursive: true });
    const keys = (await readdir(this.directory)).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).filter(key => key.startsWith(prefix) && (!cursor || key >= cursor)).sort();
    return { keys: keys.slice(0, limit).map(key => ({ key })), complete: keys.length <= limit, cursor: keys[limit] || null };
  }
}

export function createDevServer(env, kv = new LocalKV('.local/kv')) {
  const publicRoot = resolve('public');
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sub/')) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) { res.writeHead(413); res.end('请求过大'); return; } chunks.push(chunk); }
        const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        const result = await handle({ request, env }, kv);
        res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
      } else {
        const path = ['/', '/admin', '/admin/'].includes(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname);
        const file = resolve(publicRoot, `.${path}`);
        if (!file.startsWith(`${publicRoot}\\`) && !file.startsWith(`${publicRoot}/`)) { res.writeHead(403); res.end(); return; }
        const content = await readFile(file);
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
      }
    } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('请求失败'); }
  });
}

if (process.argv[1] === resolve('scripts/dev.mjs')) {
  try {
    checkSecrets(process.env);
    const port = Number(process.env.PORT || 8788);
    createDevServer(process.env).listen(port, '127.0.0.1', () => console.log(`管理页面：http://127.0.0.1:${port}/admin/\n本地数据：.local/kv（仅本地模拟，不写入线上 KV）`));
  } catch (error) { console.error(`${error.message}\n请在 .env.local 设置密码和密钥；可运行 npm run setup 生成配置模板。`); process.exitCode = 1; }
}
