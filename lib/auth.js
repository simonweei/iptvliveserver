import { AppError } from './m3u.js';
const encoder = new TextEncoder();
export function hex(bytes) { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''); }
export function randomHex(size = 32) { return hex(crypto.getRandomValues(new Uint8Array(size))); }
export async function hash(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
function fromHex(value) { return new Uint8Array(value.match(/../g).map(byte => parseInt(byte, 16))); }
export async function passwordHash(password, salt = randomHex(16), iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations }, key, 256);
  return `pbkdf2_sha256$${iterations}$${salt}$${hex(result)}`;
}
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export async function verifyPassword(password, env) {
  if (typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length > 0) {
    return equal(await hash(password), await hash(env.ADMIN_PASSWORD));
  }
  const stored = env.ADMIN_PASSWORD_HASH;
  const match = /^pbkdf2_sha256\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored || '');
  if (!match || +match[1] < 100000 || +match[1] > 600000) throw new AppError('管理员密码哈希未配置或格式错误', 503);
  return equal(await passwordHash(password, match[2], +match[1]), stored);
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
export function checkSecrets(env) {
  const hasPassword = typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length > 0;
  if (hasPassword && (env.ADMIN_PASSWORD.length < 6 || env.ADMIN_PASSWORD.length > 1024)) throw new AppError('ADMIN_PASSWORD 须为 6～1024 个字符', 503);
  if ((!hasPassword && !env.ADMIN_PASSWORD_HASH) || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) throw new AppError('服务尚未配置，请设置 ADMIN_PASSWORD 和至少 32 字符的 SESSION_SECRET', 503);
}
export async function newSession(env, now) {
  const session = { id: randomHex(), csrf: randomHex(), expiresAt: now + 8 * 3600000 };
  const payload = `${session.id}.${session.expiresAt}`;
  return { session, token: `${payload}.${await sign(payload, env.SESSION_SECRET)}` };
}
export async function readSession(request, env, kv, now) {
  const token = /(?:^|;\s*)live_session=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
  if (!token || !/^[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/.test(token)) return null;
  const [id, expiresAt, signature] = token.split('.');
  if (+expiresAt <= now || !equal(signature, await sign(`${id}.${expiresAt}`, env.SESSION_SECRET))) return null;
  const raw = await kv.get(`session_${id}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  return session.expiresAt > now && session.expiresAt === +expiresAt ? session : null;
}
export function sessionCookie(request, token, maxAge = 28800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `live_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
