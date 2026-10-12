import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptKV } from '../lib/kv.js';
import { onRequest } from '../functions/api/[[path]].js';

const env = { ADMIN_PASSWORD: 'test-password', SESSION_SECRET: 's'.repeat(64), CRON_SECRET: 'c'.repeat(64) };
class CloudflareKV {
  values = new Map();
  async get(key, options) { assert.equal(options.type, 'text'); return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix, cursor }) {
    const names = [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
    const offset = Number(cursor || 0), page = names.slice(offset, offset + 1);
    return { keys: page.map(name => ({ name, expiration: undefined, metadata: null })), list_complete: offset + 1 >= names.length, cursor: String(offset + 1) };
  }
}

test('Cloudflare name/list_complete 分页适配，包含最终页仍有 cursor 的情况', async () => {
  const binding = new CloudflareKV();
  await binding.put('source_a', JSON.stringify({ id: 'a' }));
  await binding.put('source_b', JSON.stringify({ id: 'b' }));
  const kv = adaptKV(binding);
  const first = await kv.list({ prefix: 'source_' });
  assert.deepEqual(first.keys, [{ key: 'source_a' }]); assert.equal(first.complete, false);
  const last = await kv.list({ prefix: 'source_', cursor: first.cursor });
  assert.deepEqual(last.keys, [{ key: 'source_b' }]); assert.equal(last.complete, true);
});

test('Pages 使用 context.env 绑定，Cloudflare 登录 IP 独立限速且读取分页完整', async () => {
  const binding = new CloudflareKV(), contextEnv = { ...env, LIVE_KV: binding };
  const call = (password, ip) => onRequest({ env: contextEnv, request: new Request('https://manager.example/api/login', {
    method: 'POST', headers: { Origin: 'https://manager.example', 'CF-Connecting-IP': ip }, body: JSON.stringify({ password })
  }) });
  for (let i = 0; i < 5; i++) assert.equal((await call('wrong', '203.0.113.1')).status, 401);
  assert.equal((await call(env.ADMIN_PASSWORD, '203.0.113.1')).status, 429);
  const login = await call(env.ADMIN_PASSWORD, '203.0.113.2'); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const id of ['a', 'b']) await binding.put(`source_${id}`, JSON.stringify({ id, name: id, enabled: true, intervalDays: 1 }));
  const state = await onRequest({ env: contextEnv, request: new Request('https://manager.example/api/state', { headers: { Cookie: cookie } }) });
  assert.equal(state.status, 200); assert.equal((await state.json()).sources.length, 2);
  const missing = await onRequest({ env, request: new Request('https://manager.example/api/session') });
  assert.equal(missing.status, 503);
});

test('只配置 Pages 登录密钥即可使用，外部调度默认关闭且不能用 undefined 绕过', async () => {
  const binding = new CloudflareKV();
  const { CRON_SECRET, ...minimalEnv } = env;
  const contextEnv = { ...minimalEnv, LIVE_KV: binding };
  const login = await onRequest({ env: contextEnv, request: new Request('https://manager.example/api/login', {
    method: 'POST', headers: { Origin: 'https://manager.example' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  }) });
  assert.equal(login.status, 200);
  for (const secret of [undefined, '', 'short']) {
    const result = await onRequest({ env: { ...contextEnv, CRON_SECRET: secret }, request: new Request('https://manager.example/api/cron/refresh', {
      method: 'POST', headers: { Authorization: 'Bearer undefined' }
    }) });
    assert.equal(result.status, 503); assert.match((await result.json()).error, /外部调度未启用/);
  }
});

test('Pages Functions 调度接口保留 POST 和 Bearer 认证', async () => {
  const contextEnv = { ...env, LIVE_KV: new CloudflareKV() };
  const call = (method, token) => onRequest({ env: contextEnv, request: new Request('https://manager.example/api/cron/refresh', {
    method, headers: { Authorization: `Bearer ${token}` }
  }) });
  assert.equal((await call('GET', env.CRON_SECRET)).status, 405);
  assert.equal((await call('POST', 'wrong')).status, 401);
  const result = await call('POST', env.CRON_SECRET);
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { results: [], remaining: 0 });
});
