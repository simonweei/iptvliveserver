import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../lib/server.js';
import { passwordHash, verifyPassword, checkSecrets } from '../lib/auth.js';
import { validateM3U, cleanM3U, fetchPlaylist, sourceURL, MAX_PLAYLIST_BYTES } from '../lib/m3u.js';

const SAMPLE = '#EXTM3U\n#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1\n#EXTVLCOPT:http-user-agent=Player\nhttps://stream.example.com/live.m3u8\n';
const SECOND = SAMPLE.replace('CCTV-1', 'CCTV-2');
const START = Date.UTC(2026, 9, 13, 0);
let env;
before(() => { env = { ADMIN_PASSWORD: 'test-password-123', SESSION_SECRET: 's'.repeat(64), CRON_SECRET: 'c'.repeat(64) }; });
class MemoryKV {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { assert.match(key, /^[a-zA-Z0-9_]+$/); this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix = '', limit = 256, cursor } = {}) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(prefix) && (!cursor || key >= cursor)).sort();
    return { keys: keys.slice(0, limit).map(key => ({ key })), complete: keys.length <= limit, cursor: keys[limit] || null };
  }
}
function client(kv = new MemoryKV()) {
  let cookie = '', csrf = '', clock = START, upstream = SAMPLE, requests = 0;
  return {
    kv, setTime(value) { clock = value; }, setUpstream(value) { upstream = value; }, get requests() { return requests; },
    async call(path, method = 'GET', data, headers = {}) {
      const request = new Request(`https://manager.example.com${path}`, { method, headers: { Origin: 'https://manager.example.com', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
      const result = await handle({ request, env }, kv, { now: clock, fetcher: async () => { requests++; return new Response(upstream); } });
      const setCookie = result.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
      const text = await result.text(); let json; try { json = JSON.parse(text); } catch {}
      if (path === '/api/login' && json?.csrf) csrf = json.csrf;
      return { status: result.status, text, json, headers: result.headers };
    },
    async login() { assert.equal((await this.call('/api/login', 'POST', { password: 'test-password-123' })).status, 200); },
    async source(id = 'ipv4') { return this.call('/api/sources', 'POST', { id, name: 'IPv4', url: 'https://example.com/list', intervalDays: 1 }); },
    async subscription(days = 30, id = 'keting') { return this.call('/api/subscriptions', 'POST', { id, name: '客厅', sourceId: 'ipv4', days }); }
  };
}

test('严格 M3U 校验：BOM、CRLF、元数据及多种播放协议', () => {
  const parsed = validateM3U('\uFEFF' + SAMPLE.replace(/\n/g, '\r\n'));
  assert.equal(parsed.channels, 1); assert.equal(parsed.text, SAMPLE);
  for (const url of ['rtsp://stream.example.com/live', 'rtmp://stream.example.com/live', 'udp://@239.1.1.1:1234', 'rtp://239.1.1.1:1234']) assert.equal(validateM3U(`#EXTM3U\n#EXTINF:-1,频道\n${url}`).channels, 1);
  for (const bad of ['', '<html>403</html>', '#EXTM3U\n', '#EXTM3U\nhttps://example.com/live', '#EXTM3U\n#EXTINF:-1,A', '#EXTM3U\n#EXTINF:-1,A\n#EXTINF:-1,B\nhttps://example.com/live', '#EXTM3U\n#EXTINF:-1,\nhttps://example.com/live', '#EXTM3U\n#EXT-X-TARGETDURATION:10', SAMPLE + '#EXTINF:-1,B\njavascript:alert(1)', SAMPLE + '\u0000', SAMPLE + '#EXTM3U\n']) assert.throws(() => validateM3U(bad));
});
test('来源地址拒绝非法协议、内网及内网重定向', async () => {
  for (const value of ['file:///a', 'http://127.1/list', 'http://0x7f000001/list', 'http://192.168.1.1/a', 'http://[::1]/a', 'http://localhost/a', 'https://user:pass@example.com/a']) assert.throws(() => sourceURL(value));
  assert.equal(sourceURL('https://example.com/api?id=1'), 'https://example.com/api?id=1');
  await assert.rejects(fetchPlaylist('https://example.com/list', async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })), /内网/);
});
test('拉取拒绝错误状态、无效 UTF-8、过大内容及重定向循环', async () => {
  await assert.rejects(fetchPlaylist('https://example.com/a', async () => new Response('error', { status: 502 })), /502/);
  await assert.rejects(fetchPlaylist('https://example.com/a', async () => new Response(new Uint8Array([0xff, 0xfe]))), /UTF-8/);
  await assert.rejects(fetchPlaylist('https://example.com/a', async () => new Response('x'.repeat(MAX_PLAYLIST_BYTES + 1))), /4 MB/);
  await assert.rejects(fetchPlaylist('https://example.com/a', async () => new Response(null, { status: 302, headers: { location: '/a' } })), /重定向/);
});
test('登录鉴权、CSRF、跨域和登出', async () => {
  const c = client(); assert.equal((await c.call('/api/state')).status, 401);
  assert.equal((await c.call('/api/login', 'POST', { password: 'test-password-123' }, { Origin: 'https://evil.example' })).status, 403);
  await c.login(); assert.equal((await c.call('/api/state')).status, 200);
  assert.equal((await c.call('/api/sources', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await c.call('/api/logout', 'POST')).status, 200); assert.equal((await c.call('/api/state')).status, 401);
});
test('五次错误密码后登录限速', async () => {
  const c = client(); for (let i = 0; i < 5; i++) assert.equal((await c.call('/api/login', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await c.call('/api/login', 'POST', { password: 'test-password-123' })).status, 429);
  c.setTime(START + 16 * 60000); await c.login();
});
test('格式失败不覆盖有效列表；首次失败不发布；回滚可用', async () => {
  const c = client(); await c.login(); assert.equal((await c.source()).json.refresh.ok, true); await c.subscription();
  const oldValues = [...c.kv.values].filter(([key]) => key.startsWith('playlist_'));
  c.setUpstream('#EXTM3U\n#EXTINF:-1,B\nbad-url');
  assert.equal((await c.call('/api/sources/ipv4/refresh', 'POST')).json.ok, false);
  assert.deepEqual([...c.kv.values].filter(([key]) => key.startsWith('playlist_')), oldValues);
  assert.equal((await c.call('/sub/keting/playlist.m3u')).text, SAMPLE);
  assert.equal((await c.source('bad')).json.refresh.ok, false);
  const view = (await c.call('/api/state')).json.sources.find(source => source.id === 'bad'); assert.match(view.status.lastError, /没有有效频道/);
  c.setUpstream(SECOND); await c.call('/api/sources/ipv4/refresh', 'POST');
  assert.equal((await c.call('/sub/keting/playlist.m3u')).text, SECOND);
  assert.equal((await c.call('/api/sources/ipv4/rollback', 'POST')).json.ok, true);
  assert.equal((await c.call('/sub/keting/playlist.m3u')).text, SAMPLE);
});
test('自动过滤停用和错误的完整条目，保留有效频道及扩展元数据', () => {
  const mixed = SAMPLE + '#EXTINF:-1,停用\n#https://example.com/off\n#EXTINF:-1,错误协议\nfile:///bad\n#EXTINF:-1,缺少地址\n' + SECOND.split('\n').slice(1).join('\n');
  const result = cleanM3U(mixed);
  assert.equal(result.channels, 2); assert.equal(result.removed, 3); assert.equal(result.totalChannels, 5);
  assert.equal(result.text.includes('停用'), false); assert.equal(result.text.includes('file:///'), false);
  assert.equal(result.text.includes('#EXTVLCOPT'), true); assert.equal(validateM3U(result.text).channels, 2);
  assert.throws(() => cleanM3U('#EXTM3U\n#EXTINF:-1,A\n#https://example.com/off'), /没有有效频道/);
  assert.throws(() => cleanM3U('<html>error</html>'), /第 1 行/);
  const control = cleanM3U(SAMPLE + '#EXTINF:-1,坏字符\nhttps://example.com/\u0000bad'); assert.equal(control.removed, 1);
});
test('来源含无效条目时自动清理并写入 KV，客户端仅获取有效频道', async () => {
  const c = client(); await c.login();
  c.setUpstream(SAMPLE + '#EXTINF:-1,已停用\n#https://example.com/disabled\n');
  const created = await c.source(); assert.equal(created.json.refresh.ok, true); assert.equal(created.json.refresh.removed, 1);
  await c.subscription(); const response = await c.call('/sub/keting/playlist.m3u'); assert.equal(response.text, SAMPLE);
  const view = (await c.call('/api/state')).json.sources[0]; assert.equal(view.status.removed, 1); assert.match(view.status.history[0].message, /过滤 1/);
});
test('五档有效期从创建时间开始；恰好到期拒绝；永久有效', async () => {
  const c = client(); await c.login(); await c.source();
  for (const days of [30, 90, 180, 360, 0]) {
    const result = await c.subscription(days, `sub${days}`); assert.equal(result.status, 201);
    assert.equal(result.json.subscription.expiresAt, days ? START + days * 86400000 : null);
  }
  c.setTime(START + 30 * 86400000 - 1); assert.equal((await c.call('/sub/sub30/playlist.m3u')).status, 200);
  c.setTime(START + 30 * 86400000); assert.equal((await c.call('/sub/sub30/playlist.m3u')).status, 410);
  c.setTime(START + 1000 * 86400000); assert.equal((await c.call('/sub/sub0/playlist.m3u')).status, 200);
});
test('标识大小写统一、重复拒绝、改名旧地址失效、禁用、续期、引用删除保护', async () => {
  const c = client(); await c.login(); await c.source();
  const sub = (await c.subscription(30, 'KeTing-1')).json.subscription; assert.equal(sub.id, 'keting-1');
  assert.equal((await c.subscription(90, 'KETING-1')).status, 409);
  assert.equal((await c.subscription(30, '../bad')).status, 400);
  assert.equal((await c.call('/api/sources/ipv4', 'DELETE')).status, 409);
  const result = await c.call('/api/subscriptions/keting-1', 'PUT', { ...sub, id: 'bedroom', enabled: false });
  assert.equal(result.json.subscription.createdAt, START); assert.equal(result.json.subscription.expiresAt, sub.expiresAt);
  assert.equal((await c.call('/sub/keting-1/playlist.m3u')).status, 404); assert.equal((await c.call('/sub/bedroom/playlist.m3u')).status, 403);
  const renewal = await c.call('/api/subscriptions/bedroom/renew', 'POST', { days: 90 }); assert.equal(renewal.json.subscription.expiresAt, START + 120 * 86400000);
  c.setTime(START + 200 * 86400000); await c.login();
  const late = await c.call('/api/subscriptions/bedroom/renew', 'POST', { days: 30 }); assert.equal(late.json.subscription.expiresAt, START + 230 * 86400000);
  await c.call('/api/subscriptions/bedroom', 'DELETE'); assert.equal((await c.call('/api/sources/ipv4', 'DELETE')).status, 200);
});
test('订阅不限制重复请求、HEAD 响应不缓存', async () => {
  const c = client(); await c.login(); await c.source(); await c.subscription();
  for (let i = 0; i < 20; i++) assert.equal((await c.call('/sub/keting/playlist.m3u')).status, 200);
  const head = await c.call('/sub/keting/playlist.m3u', 'HEAD'); assert.equal(head.text, ''); assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('content-type'), 'text/plain; charset=utf-8');
  const get = await c.call('/sub/keting/playlist.m3u');
  assert.equal(get.headers.get('content-type'), 'text/plain; charset=utf-8'); assert.equal(get.text, SAMPLE);
});
test('调度密钥、间隔及停用源；最多三源每轮', async () => {
  const c = client(); await c.login(); for (const id of ['ipv4', 'b', 'c', 'd']) await c.source(id);
  assert.equal((await c.call('/api/cron/refresh', 'POST')).status, 401);
  const headers = { Authorization: `Bearer ${env.CRON_SECRET}` };
  assert.equal((await c.call('/api/cron/refresh', 'POST', null, headers)).json.results.length, 0);
  c.setTime(START + 86400000);
  const first = await c.call('/api/cron/refresh', 'POST', null, headers); assert.equal(first.json.results.length, 3); assert.equal(first.json.remaining, 1);
  assert.equal((await c.call('/api/cron/refresh', 'POST', null, headers)).json.results.length, 1);
  await c.login();
  const source = (await c.call('/api/state')).json.sources.find(source => source.id === 'ipv4');
  await c.call('/api/sources/ipv4', 'PUT', { ...source, enabled: false }); c.setTime(START + 172800000);
  assert.equal((await c.call('/api/cron/refresh', 'POST', null, headers)).json.results.some(result => result.id === 'ipv4'), false);
});
test('按天调度的准确边界、间隔校验与旧版分钟配置兼容', async () => {
  const c = client(); await c.login(); const created = await c.source();
  assert.equal(created.json.source.intervalDays, 1);
  const invalid = await c.call('/api/sources', 'POST', { id: 'bad', name: 'bad', url: 'https://example.com/a', intervalDays: 0 });
  assert.equal(invalid.status, 400);
  const headers = { Authorization: `Bearer ${env.CRON_SECRET}` };
  c.setTime(START + 86400000 - 1);
  assert.equal((await c.call('/api/cron/refresh', 'POST', null, headers)).json.results.length, 0);
  c.setTime(START + 86400000);
  assert.equal((await c.call('/api/cron/refresh', 'POST', null, headers)).json.results.length, 1);
  const key = [...c.kv.values.keys()].find(key => key.startsWith('source_'));
  const legacy = JSON.parse(await c.kv.get(key)); delete legacy.intervalDays; legacy.intervalMinutes = 3600;
  await c.kv.put(key, JSON.stringify(legacy)); await c.login();
  const view = (await c.call('/api/state')).json.sources[0];
  assert.equal(view.intervalDays, 2.5);
  assert.equal(view.nextUpdateAt, START + 86400000 + 3600 * 60000);
  const updated = await c.call('/api/sources/ipv4', 'PUT', { ...view, intervalDays: 7 });
  assert.equal(updated.json.source.intervalDays, 7);
  assert.equal('intervalMinutes' in updated.json.source, false);
});
test('KV 支持字符串键名和 name 键名、已解码 JSON；页面能读取创建结果', async () => {
  for (const shape of ['string', 'name']) {
    const kv = new MemoryKV();
    const originalList = kv.list.bind(kv), originalGet = kv.get.bind(kv);
    kv.list = async options => { const page = await originalList(options); return { ...page, keys: page.keys.map(entry => shape === 'string' ? entry.key : { name: entry.key }) }; };
    kv.get = async key => { const raw = await originalGet(key); return raw ? JSON.parse(raw) : null; };
    const c = client(kv); await c.login(); await c.source();
    const state = await c.call('/api/state'); assert.equal(state.status, 200); assert.equal(state.json.sources[0].id, 'ipv4');
    await c.subscription(); assert.equal((await c.call('/sub/keting/playlist.m3u')).status, 200);
  }
});
test('KV 无效绑定与 list 异常返回具体诊断，日志不泄露环境变量', async t => {
  const logs = []; t.mock.method(console, 'error', message => logs.push(message));
  const request = new Request('https://manager.example.com/api/session');
  const invalid = await handle({ request, env }, 'namespace-id');
  assert.equal(invalid.status, 503); assert.match((await invalid.json()).error, /绑定对象/);
  const kv = new MemoryKV(), c = client(kv); await c.login();
  kv.list = async () => { throw new Error(`upstream error ${env.CRON_SECRET}`); };
  const state = await c.call('/api/state'); assert.equal(state.status, 503); assert.equal(state.json.code, 'KV_LIST_FAILED');
  assert.match(state.json.errorId, /^[a-f0-9]{12}$/); assert.equal(logs.join().includes(env.CRON_SECRET), false);
  assert.equal(state.text.includes(env.CRON_SECRET), false);
});
test('线上回归：空列表省略 keys 时，空控制台、新建直播源与订阅都正常', async () => {
  const kv = new MemoryKV(), originalList = kv.list.bind(kv);
  kv.list = async options => { const page = await originalList(options); if (!page.keys.length) { delete page.keys; } return page; };
  const c = client(kv); await c.login();
  const empty = await c.call('/api/state'); assert.equal(empty.status, 200); assert.deepEqual(empty.json.sources, []); assert.deepEqual(empty.json.subscriptions, []);
  assert.equal((await c.source()).status, 201);
  const created = await c.call('/api/state'); assert.equal(created.status, 200); assert.equal(created.json.sources.length, 1); assert.deepEqual(created.json.subscriptions, []);
  await c.subscription(); assert.equal((await c.call('/api/state')).json.subscriptions.length, 1);
});
test('部署缺少 KV 或密钥时关闭管理入口', async () => {
  const request = new Request('https://manager.example.com/api/session');
  assert.equal((await handle({ request, env }, null)).status, 503);
  assert.equal((await handle({ request, env: {} }, new MemoryKV())).status, 503);
});
test('创建直播源无需填写标识，服务器自动生成唯一标识并可用于订阅', async () => {
  const c = client(); await c.login();
  const data = { name: '同名来源', url: 'https://example.com/list', intervalDays: 1 };
  const first = await c.call('/api/sources', 'POST', data), second = await c.call('/api/sources', 'POST', data);
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const id = first.json.source.id; assert.match(id, /^src_[a-f0-9]{32}$/); assert.notEqual(id, second.json.source.id);
  const sub = await c.call('/api/subscriptions', 'POST', { id: 'keting', name: '客厅', sourceId: id, days: 30 });
  assert.equal(sub.status, 201); assert.equal((await c.call('/sub/keting/playlist.m3u')).text, SAMPLE);
});
test('环境变量密码直接登录，优先于旧哈希；兼容旧配置；不泄露密码', async () => {
  const oldHash = await passwordHash('legacy-password-123');
  assert.equal(await verifyPassword('legacy-password-123', { ADMIN_PASSWORD_HASH: oldHash }), true);
  assert.equal(await verifyPassword('legacy-password-123', { ...env, ADMIN_PASSWORD_HASH: oldHash }), false);
  assert.equal(await verifyPassword(env.ADMIN_PASSWORD, { ...env, ADMIN_PASSWORD_HASH: oldHash }), true);
  const unicodeEnv = { ...env, ADMIN_PASSWORD: '自定义密码-123456789' };
  assert.equal(await verifyPassword(unicodeEnv.ADMIN_PASSWORD, unicodeEnv), true);
  assert.throws(() => checkSecrets({ ...env, ADMIN_PASSWORD: 'short' }), /ADMIN_PASSWORD/);
  const minimumEnv = { ...env, ADMIN_PASSWORD: 'abcdef' };
  assert.doesNotThrow(() => checkSecrets(minimumEnv));
  const minimumLogin = await handle({ request: new Request('https://manager.example.com/api/login', { method: 'POST', headers: { Origin: 'https://manager.example.com' }, body: JSON.stringify({ password: 'abcdef' }) }), env: minimumEnv }, new MemoryKV());
  assert.equal(minimumLogin.status, 200);
  assert.throws(() => checkSecrets({ ...env, ADMIN_PASSWORD: '' }), /ADMIN_PASSWORD/);
  const c = client(); await c.login(); const state = await c.call('/api/state');
  assert.equal(state.text.includes(env.ADMIN_PASSWORD), false);
  assert.equal(state.text.includes(env.SESSION_SECRET), false);
});
