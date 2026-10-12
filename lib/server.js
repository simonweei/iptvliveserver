import { AppError, sourceURL, fetchPlaylist } from './m3u.js';
import { checkSecrets, verifyPassword, newSession, readSession, sessionCookie, equal, hash, randomHex } from './auth.js';
import { adaptKV, diagnostic } from './kv.js';

const DAYS = [30, 90, 180, 360, 0], DAY = 86400000;
const get = async (kv, key) => { const raw = await kv.get(key); return raw ? JSON.parse(raw) : null; };
const put = (kv, key, value) => kv.put(key, JSON.stringify(value));
const required = (value, message) => { if (!value) throw new AppError(message, 404); return value; };
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new AppError('标识须为 1～64 个英文字母、数字、下划线或短横线');
  return value.toLowerCase();
}
// KV keys support letters, numbers and underscores, so encode hyphens too.
function recordKey(prefix, id) { return `${prefix}_${Array.from(new TextEncoder().encode(id), b => b.toString(16).padStart(2, '0')).join('')}`; }
function name(value) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new AppError('名称或备注须为 1～100 个字符'); return value.trim(); }
function duration(value) { if (!DAYS.includes(value)) throw new AppError('请选择 30、90、180、360 天或永久'); return value; }
function intervalDays(data) {
  const value = Number(data.intervalDays);
  if (!Number.isInteger(value) || value < 1 || value > 3650) throw new AppError('更新间隔须为 1～3650 天的整数');
  return value;
}
function sourceDays(source) { return source.intervalDays ?? source.intervalMinutes / 1440; }
async function body(request) {
  const text = await request.text();
  if (text.length > 16384) throw new AppError('请求内容过大', 413);
  try { const data = JSON.parse(text); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; } catch { throw new AppError('请求必须是 JSON 对象'); }
}
async function all(kv, prefix) {
  let cursor, records = [];
  do {
    const page = await kv.list({ prefix: `${prefix}_`, limit: 256, ...(cursor ? { cursor } : {}) });
    const values = await Promise.all(page.keys.map(key => get(kv, key.key)));
    records.push(...values.filter(Boolean));
    if (page.complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  } while (true);
  return records;
}
function response(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...extra } });
}
const method = (request, expected) => { if (request.method !== expected) throw new AppError('请求方法不支持', 405); };
function sameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new AppError('请求来源校验失败', 403);
}
async function refresh(kv, source, now, fetcher, rollback = false, env = {}) {
  const key = recordKey('playlist', source.id), statusKey = recordKey('status', source.id);
  const old = await get(kv, key), status = await get(kv, statusKey) || { history: [] };
  let result;
  try {
    if (rollback) {
      if (!old?.previous) throw new AppError('没有可回滚的版本');
      result = { ...old.previous, updatedAt: now };
    } else {
      const parsed = await fetchPlaylist(source.url, fetcher);
      result = { ...parsed, updatedAt: now };
    }
    // Avoid a completed remote request publishing after the source was edited/deleted.
    const latest = await get(kv, recordKey('source', source.id));
    if (!latest || latest.updatedAt !== source.updatedAt) throw new AppError('源配置已变更，请重新更新');
    await put(kv, key, { current: result, previous: old?.current || null });
  } catch (error) {
    if (error instanceof AppError && error.errorId) throw error;
    const message = error instanceof AppError ? error.message : '拉取失败，请检查来源连接';
    if (!(error instanceof AppError)) diagnostic(error, 'internal', env);
    await put(kv, statusKey, { ...status, lastAttemptAt: now, lastError: message, history: [{ at: now, ok: false, message }, ...(status.history || [])].slice(0, 10) });
    return { id: source.id, ok: false, error: message };
  }
  await put(kv, statusKey, { lastAttemptAt: now, lastSuccessAt: now, channels: result.channels, removed: result.removed || 0, totalChannels: result.totalChannels ?? result.channels, lastError: null, history: [{ at: now, ok: true, message: rollback ? '已回滚到上一版本' : `已保存 ${result.channels} 个有效频道，过滤 ${result.removed || 0} 个无效条目` }, ...(status.history || [])].slice(0, 10) });
  return { id: source.id, ok: true, channels: result.channels, removed: result.removed || 0 };
}
async function sourceViews(kv) {
  const sources = await all(kv, 'source');
  return Promise.all(sources.map(async source => {
    const status = await get(kv, recordKey('status', source.id));
    const intervalDays = sourceDays(source);
    const nextUpdateAt = source.enabled ? (status?.lastAttemptAt || 0) + intervalDays * DAY : null;
    return { ...source, intervalDays, status, nextUpdateAt };
  }));
}

export async function handle(context, kv, options = {}) {
  const { request, env = {} } = context, now = options.now ?? Date.now(), fetcher = options.fetcher || fetch;
  let authenticated = false;
  try {
    if (!kv) throw new AppError('KV 未绑定，请绑定变量 LIVE_KV', 503);
    kv = adaptKV(kv, env);
    const path = new URL(request.url).pathname;
    if (path.startsWith('/sub/')) {
      if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('请求方法不支持', 405);
      const match = /^\/sub\/([a-z0-9_-]{1,64})\/playlist\.m3u$/.exec(path);
      if (!match) throw new AppError('订阅地址不存在', 404);
      const subscription = required(await get(kv, recordKey('subscription', match[1])), '订阅不存在');
      if (!subscription.enabled) throw new AppError('订阅已禁用', 403);
      if (subscription.expiresAt !== null && subscription.expiresAt <= now) throw new AppError('订阅已到期', 410);
      required(await get(kv, recordKey('source', subscription.sourceId)), '绑定的直播源不存在');
      const playlist = await get(kv, recordKey('playlist', subscription.sourceId));
      if (!playlist?.current) throw new AppError('直播源暂无可用列表', 503);
      return new Response(request.method === 'HEAD' ? null : playlist.current.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } });
    }
    checkSecrets(env);
    if (path === '/api/cron/refresh') {
      method(request, 'POST');
      if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 32) throw new AppError('外部调度未启用，请配置至少 32 字符的 CRON_SECRET', 503);
      if (!equal(request.headers.get('authorization'), `Bearer ${env.CRON_SECRET}`)) throw new AppError('调度密钥错误', 401);
      const due = (await sourceViews(kv)).filter(source => source.enabled && source.nextUpdateAt <= now).sort((a, b) => a.nextUpdateAt - b.nextUpdateAt);
      const results = [];
      // Bound each invocation. A single scheduler repeatedly drains due sources.
      for (const source of due.slice(0, 3)) results.push(await refresh(kv, source, now, fetcher, false, env));
      const expired = (await all(kv, 'session')).filter(session => session.expiresAt <= now);
      await Promise.all(expired.map(session => kv.delete(`session_${session.id}`)));
      return response({ results, remaining: Math.max(0, due.length - 3) });
    }
    if (path === '/api/login') {
      method(request, 'POST'); sameOrigin(request);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limitKey = `login_${await hash(ip)}`, limit = await get(kv, limitKey);
      if (limit?.until > now && limit.attempts >= 5) throw new AppError('登录失败次数过多，请 15 分钟后重试', 429);
      const data = await body(request);
      if (typeof data.password !== 'string' || data.password.length > 1024) throw new AppError('请输入密码');
      if (!await verifyPassword(data.password, env)) {
        await put(kv, limitKey, { attempts: limit?.until > now ? limit.attempts + 1 : 1, until: limit?.until > now ? limit.until : now + 15 * 60000 });
        throw new AppError('密码错误', 401);
      }
      await kv.delete(limitKey);
      const { session, token } = await newSession(env, now);
      await put(kv, `session_${session.id}`, session);
      return response({ csrf: session.csrf }, 200, { 'Set-Cookie': sessionCookie(request, token) });
    }
    const session = await readSession(request, env, kv, now);
    if (!session) throw new AppError('请先登录', 401);
    authenticated = true;
    if (request.method !== 'GET') {
      sameOrigin(request);
      if (!equal(request.headers.get('x-csrf-token'), session.csrf)) throw new AppError('会话校验失败，请重新登录', 403);
    }
    if (path === '/api/session') { method(request, 'GET'); return response({ csrf: session.csrf }); }
    if (path === '/api/logout') {
      method(request, 'POST'); await kv.delete(`session_${session.id}`);
      return response({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
    }
    if (path === '/api/state') {
      method(request, 'GET');
      const [sources, subscriptions] = await Promise.all([sourceViews(kv), all(kv, 'subscription')]);
      return response({ sources, subscriptions, serverTime: now });
    }
    if (path === '/api/sources') {
      method(request, 'POST');
      const data = await body(request), id = data.id === undefined ? `src_${randomHex(16)}` : identifier(data.id), key = recordKey('source', id);
      if (await get(kv, key)) throw new AppError('源标识已存在', 409);
      const interval = intervalDays(data);
      const source = { id, name: name(data.name), url: sourceURL(data.url), intervalDays: interval, enabled: true, createdAt: now, updatedAt: now };
      await put(kv, key, source);
      return response({ source, refresh: await refresh(kv, source, now, fetcher, false, env) }, 201);
    }
    const sourceMatch = /^\/api\/sources\/([a-z0-9_-]{1,64})(?:\/(refresh|rollback))?$/.exec(path);
    if (sourceMatch) {
      const [, id, action] = sourceMatch, key = recordKey('source', id), source = required(await get(kv, key), '直播源不存在');
      if (action) { method(request, 'POST'); return response(await refresh(kv, source, now, fetcher, action === 'rollback', env)); }
      if (request.method === 'DELETE') {
        if ((await all(kv, 'subscription')).some(sub => sub.sourceId === id)) throw new AppError('该源仍被订阅引用，请先更换或删除相关订阅', 409);
        await kv.delete(key); await kv.delete(recordKey('playlist', id)); await kv.delete(recordKey('status', id));
        return response({ ok: true });
      }
      method(request, 'PUT');
      const data = await body(request), interval = intervalDays(data);
      if (typeof data.enabled !== 'boolean') throw new AppError('启用状态格式错误');
      const { intervalMinutes: legacyInterval, ...currentSource } = source;
      const updated = { ...currentSource, name: name(data.name), url: sourceURL(data.url), intervalDays: interval, enabled: data.enabled, updatedAt: now };
      await put(kv, key, updated);
      return response({ source: updated });
    }
    if (path === '/api/subscriptions') {
      method(request, 'POST');
      const data = await body(request), id = identifier(data.id), key = recordKey('subscription', id);
      if (await get(kv, key)) throw new AppError('订阅标识已存在', 409);
      const sourceId = identifier(data.sourceId); required(await get(kv, recordKey('source', sourceId)), '直播源不存在');
      const days = duration(data.days), subscription = { id, name: name(data.name), sourceId, createdAt: now, expiresAt: days ? now + days * DAY : null, enabled: true };
      await put(kv, key, subscription); return response({ subscription }, 201);
    }
    const subMatch = /^\/api\/subscriptions\/([a-z0-9_-]{1,64})(?:\/(renew))?$/.exec(path);
    if (subMatch) {
      const [, id, action] = subMatch, key = recordKey('subscription', id), subscription = required(await get(kv, key), '订阅不存在');
      if (action) {
        method(request, 'POST'); const data = await body(request), days = duration(data.days);
        if (subscription.expiresAt === null && days) throw new AppError('永久订阅无需续期');
        const updated = { ...subscription, expiresAt: days ? Math.max(now, subscription.expiresAt) + days * DAY : null };
        await put(kv, key, updated); return response({ subscription: updated });
      }
      if (request.method === 'DELETE') { await kv.delete(key); return response({ ok: true }); }
      method(request, 'PUT');
      const data = await body(request), newId = identifier(data.id), sourceId = identifier(data.sourceId);
      required(await get(kv, recordKey('source', sourceId)), '直播源不存在');
      if (typeof data.enabled !== 'boolean') throw new AppError('启用状态格式错误');
      const newKey = recordKey('subscription', newId);
      if (newId !== id && await get(kv, newKey)) throw new AppError('订阅标识已存在', 409);
      const updated = { ...subscription, id: newId, name: name(data.name), sourceId, enabled: data.enabled };
      await put(kv, newKey, updated);
      if (newId !== id) await kv.delete(key);
      return response({ subscription: updated });
    }
    throw new AppError('接口不存在', 404);
  } catch (error) {
    const reported = error instanceof AppError ? error : diagnostic(error, 'internal', env);
    return response({ error: reported.message, ...(reported.errorId ? { errorId: reported.errorId, code: reported.code } : {}), ...(authenticated && reported.details ? { details: reported.details } : {}) }, reported.status);
  }
}
