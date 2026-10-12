import { AppError } from './m3u.js';

export function hasKV(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && ['get', 'put', 'delete', 'list'].every(method => typeof value[method] === 'function');
}

export function diagnostic(error, stage, env = {}) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('');
  let detail = String(error?.stack || error?.message || error);
  for (const key of ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'CRON_SECRET']) {
    if (typeof env[key] === 'string' && env[key]) detail = detail.split(env[key]).join('[redacted]');
  }
  console.error(`[iptv:${id}] ${stage}: ${detail}`);
  const messages = { get: 'KV 读取失败，请检查命名空间、权限及额度', put: 'KV 写入失败，请检查命名空间、权限及额度', delete: 'KV 删除失败，请检查命名空间和权限', list: 'KV 列表读取失败，请检查命名空间和权限', data: 'KV 数据格式异常，请检查对应记录是否为有效 JSON 对象', internal: '服务内部错误，请在函数日志中查找此编号' };
  const reported = new AppError(`${messages[stage] || messages.internal}（错误编号：${id}）`, 503);
  reported.code = `KV_${stage.toUpperCase()}_FAILED`;
  reported.errorId = id;
  if (stage === 'list') {
    let message = String(error?.message || error).slice(0, 500);
    for (const key of ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET', 'CRON_SECRET']) {
      if (typeof env[key] === 'string' && env[key]) message = message.split(env[key]).join('[redacted]');
    }
    reported.details = message;
  }
  return reported;
}

export function adaptKV(binding, env = {}) {
  if (!hasKV(binding)) throw new AppError('LIVE_KV 不是有效的 KV 绑定对象。请在项目「KV 存储」绑定命名空间；不要把 LIVE_KV 设置为普通字符串环境变量。', 503);
  const invoke = async (method, ...args) => {
    try { return await binding[method](...args); }
    catch (error) { throw diagnostic(error, method, env); }
  };
  return {
    async get(key) {
      const raw = await invoke('get', key, { type: 'text' });
      if (raw === null || raw === undefined || raw === '') return null;
      try {
        // Normalize text and already-decoded JSON without parsing an object twice.
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
        return JSON.stringify(value);
      } catch (error) { throw diagnostic(error, 'data', env); }
    },
    put: (key, value) => invoke('put', key, value),
    delete: key => invoke('delete', key),
    async list(options) {
      const raw = await invoke('list', options);
      try {
        const page = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // The production EdgeOne runtime omits keys for an empty result.
        // Keep validating the envelope so a malformed response is not treated as empty.
        const entries = page?.keys ?? (page && typeof page.complete === 'boolean' && 'cursor' in page ? [] : null);
        if (!Array.isArray(entries)) throw new Error(`KV list response has no keys array (type=${typeof page}; fields=${page && typeof page === 'object' ? Object.keys(page).join(',') : 'none'})`);
        const keys = entries.map(entry => {
          const key = typeof entry === 'string' ? entry : entry?.key ?? entry?.name;
          if (typeof key !== 'string') throw new Error('KV list entry has no key');
          return { key };
        });
        return { keys, cursor: page.cursor || null, complete: page.complete ?? page.list_complete ?? !page.cursor };
      } catch (error) { throw diagnostic(error, 'list', env); }
    }
  };
}
