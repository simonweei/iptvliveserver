export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function sourceURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f]/u.test(value)) throw new AppError('来源网址格式错误');
  let url;
  try { url = new URL(value); } catch { throw new AppError('请输入完整的 HTTP/HTTPS 来源网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new AppError('来源网址仅允许 HTTP/HTTPS，不允许账户信息和片段');
  const host = url.hostname.toLowerCase();
  // Public sources only. Redirect destinations are checked by the fetcher as well.
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || host.includes(':') || host === 'localhost') throw new AppError('来源网址必须是公网地址');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))) throw new AppError('来源网址不能指向内网或保留地址');
  }
  return url.href;
}

export const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

function infoComma(line) {
  let quoted = false;
  for (let index = 8; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ',' && !quoted) return index;
  }
  return -1;
}

export function validateM3U(input) {
  if (typeof input !== 'string' || !input.trim()) throw new AppError('列表为空');
  if (new TextEncoder().encode(input).byteLength > MAX_PLAYLIST_BYTES) throw new AppError('列表超过 4 MB 上限');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)) throw new AppError('列表含非法字符或无效 UTF-8 编码');
  const lines = text.split('\n');
  if (!/^#EXTM3U(?:\s.*)?$/.test(lines[0])) throw new AppError('第 1 行必须是 #EXTM3U');
  let pending = 0, channels = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fail = message => { throw new AppError(`第 ${i + 1} 行：${message}`); };
    if (line.startsWith('#EXTINF')) {
      if (pending) fail(`第 ${pending} 行的频道缺少播放地址`);
      if (!/^#EXTINF:\s*-?\d+(?:\.\d+)?(?:\s+[^\n]*)?,\s*\S.*$/.test(line)) fail('EXTINF 格式错误或缺少频道名称');
      const comma = infoComma(line);
      if (comma < 0 || !line.slice(comma + 1).trim()) fail('EXTINF 属性引号错误或缺少频道名称');
      pending = i + 1;
    } else if (line.startsWith('#')) {
      if (/^#EXT-X-/i.test(line)) fail('这是 HLS 视频分片列表，不是 IPTV 频道列表');
      if (/^#EXTM3U\b/.test(line)) fail('列表中出现重复的 #EXTM3U');
      // Preserve IPTV metadata such as EXTVLCOPT, KODIPROP and EXTGRP.
    } else {
      if (!pending) fail('播放地址前缺少 #EXTINF');
      if (/[\s<>"\\]/u.test(line)) fail('播放地址含非法字符');
      let url;
      try { url = new URL(line); } catch { fail('播放地址必须是完整网址'); }
      if (!['http:', 'https:', 'rtsp:', 'rtmp:', 'udp:', 'rtp:'].includes(url.protocol) || !url.hostname) fail('播放地址协议不支持');
      pending = 0;
      channels++;
    }
  }
  if (pending) throw new AppError(`第 ${pending} 行：频道缺少播放地址`);
  if (!channels) throw new AppError('列表中没有有效频道');
  return { text: text.endsWith('\n') ? text : `${text}\n`, channels };
}

export function cleanM3U(input) {
  if (typeof input !== 'string' || !input.trim()) throw new AppError('列表为空');
  if (new TextEncoder().encode(input).byteLength > MAX_PLAYLIST_BYTES) throw new AppError('列表超过 4 MB 上限');
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!/^#EXTM3U(?:\s.*)?$/.test(lines[0]) || /[\u0000-\u001f\u007f\ufffd]/u.test(lines[0])) throw new AppError('第 1 行必须是有效的 #EXTM3U');
  const starts = [];
  for (let index = 1; index < lines.length; index++) if (lines[index].trim().startsWith('#EXTINF')) starts.push(index);
  const kept = [], removedDetails = [];
  const inactiveAddress = line => /^\s*#(?:https?|rtsp|rtmp|udp|rtp):\/\//i.test(line);
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index], end = starts[index + 1] ?? lines.length;
    const block = lines.slice(start, end);
    try {
      // Never uncomment a disabled address; validate the entire channel block.
      const parsed = validateM3U(`${lines[0]}\n${block.join('\n')}\n`);
      if (parsed.channels !== 1) throw new AppError('条目不是单个完整频道');
      kept.push(block.filter(line => !inactiveAddress(line)).join('\n').trimEnd());
    } catch (error) {
      removedDetails.push({ line: start + 1, reason: error.message });
    }
  }
  if (!kept.length) throw new AppError(`清理后没有有效频道（已过滤 ${removedDetails.length} 个无效条目），已保留旧列表`);
  // Preserve header and valid global comments; discard orphan addresses before channels.
  const preamble = lines.slice(1, starts[0]).filter(line => (!line.trim() || line.trim().startsWith('#')) && !inactiveAddress(line) && !/^\s*#(?:EXT-X-|EXTM3U)/i.test(line) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(line));
  const result = validateM3U(`${[lines[0], ...preamble, ...kept].join('\n')}\n`);
  return { ...result, totalChannels: starts.length, removed: removedDetails.length, removedDetails: removedDetails.slice(0, 20) };
}

export function sourceFormat(value = 'auto') {
  if (!['auto', 'm3u', 'txt', 'json'].includes(value)) throw new AppError('来源格式须为自动识别、M3U、TXT 或 JSON');
  return value;
}

const encodeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const decodeAttribute = value => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function channelBlock(channel) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) throw new AppError('频道须为对象');
  const values = {};
  for (const key of ['name', 'url', 'group', 'logo', 'tvgId']) {
    const value = channel[key] ?? '';
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f\ufffd]/u.test(value)) throw new AppError(`${key} 字段须为不含控制字符的字符串`);
    values[key] = value.trim();
  }
  if (!values.name || !values.url) throw new AppError('频道缺少名称或播放地址');
  const attributes = [['tvg-id', values.tvgId], ['tvg-logo', values.logo], ['group-title', values.group]]
    .filter(([, value]) => value).map(([key, value]) => ` ${key}="${encodeAttribute(value)}"`).join('');
  return validateM3U(`#EXTM3U\n#EXTINF:-1${attributes},${values.name}\n${values.url}\n`).text.split('\n').slice(1).join('\n');
}

export function parsePlaylist(input, format = 'auto') {
  sourceFormat(format);
  if (typeof input !== 'string' || !input.trim()) throw new AppError('列表为空');
  if (new TextEncoder().encode(input).byteLength > MAX_PLAYLIST_BYTES) throw new AppError('列表超过 4 MB 上限');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (format === 'auto') {
    if (text.startsWith('#EXTM3U')) format = 'm3u';
    else if (/^[\[{]/.test(text)) format = 'json';
    else if (text.split('\n').some(line => /^[^,#<]+,\s*(?:#genre#|(?:https?|rtsp|rtmp|udp|rtp):\/\/)/i.test(line.trim()))) format = 'txt';
    else throw new AppError('无法识别来源格式，请选择 M3U、TXT 或 JSON 并检查内容');
  }
  if (format === 'm3u') return { ...cleanM3U(text), format };
  const blocks = [], removedDetails = [];
  let totalChannels = 0;
  const add = (channel, position) => {
    totalChannels++;
    try { blocks.push(channelBlock(channel)); }
    catch (error) { removedDetails.push({ line: position, reason: error.message }); }
  };
  if (format === 'txt') {
    let group = '';
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const comma = line.indexOf(',');
      const name = comma < 0 ? line : line.slice(0, comma).trim(), url = comma < 0 ? '' : line.slice(comma + 1).trim();
      if (url.toLowerCase() === '#genre#') { group = name; return; }
      add({ name, url, group }, index + 1);
    });
  } else {
    let data;
    try { data = JSON.parse(text); } catch { throw new AppError('JSON 语法错误'); }
    const channels = Array.isArray(data) ? data : data?.channels;
    if (!Array.isArray(channels)) throw new AppError('JSON 须为频道数组或包含 channels 数组的对象');
    channels.forEach((channel, index) => add(channel, index + 1));
  }
  if (!blocks.length) throw new AppError(`清理后没有有效频道（已过滤 ${removedDetails.length} 个无效条目），已保留旧列表`);
  const parsed = validateM3U(`#EXTM3U\n${blocks.join('')}`);
  return { ...parsed, format, totalChannels, removed: removedDetails.length, removedDetails: removedDetails.slice(0, 20) };
}

// M3U remains the stored representation so its extension metadata is preserved.
export function playlistChannels(text) {
  const channels = [];
  let pending, globalGroup = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const comma = infoComma(line);
      if (comma < 0) throw new AppError('M3U 频道信息缺少名称分隔符');
      const attributes = Object.fromEntries([...line.slice(0, comma).matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], decodeAttribute(match[2])]));
      pending = { name: line.slice(comma + 1).trim(), url: '', group: attributes['group-title'] ?? globalGroup, logo: attributes['tvg-logo'] || '', tvgId: attributes['tvg-id'] || '' };
    } else if (line.startsWith('#EXTGRP:')) {
      const group = line.slice(8).trim();
      if (pending) pending.group = group; else globalGroup = group;
    } else if (line && !line.startsWith('#') && pending) {
      channels.push({ ...pending, url: line }); pending = null;
    }
  }
  return channels;
}

export function exportPlaylist(text, format) {
  if (format === 'm3u') return text;
  const channels = playlistChannels(text);
  if (format === 'json') return JSON.stringify({ channels }, null, 2) + '\n';
  if (format !== 'txt') throw new AppError('订阅格式不支持');
  const lines = [];
  let group = '';
  const txtName = value => value.replace(/,/g, '，');
  for (const channel of channels) {
    if (channel.group !== group) { group = channel.group; lines.push(`${txtName(group)},#genre#`); }
    lines.push(`${txtName(channel.name)},${channel.url}`);
  }
  return lines.join('\n') + '\n';
}

export async function fetchPlaylist(address, fetcher = fetch, format = 'auto') {
  sourceFormat(format);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    return await loadPlaylist(address, fetcher, format, { controller, bytes: 0 });
  } catch (error) {
    if (controller.signal.aborted) throw new AppError('拉取超时（15 秒），已保留旧列表');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function loadPlaylist(address, fetcher, format, context, depth = 0) {
    const { controller } = context;
    let url = sourceURL(address), response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetcher(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/x-mpegURL, audio/x-mpegurl, application/json, text/plain, */*' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new AppError('来源网址重定向异常');
      url = sourceURL(new URL(location, url).href);
    }
    if (!response.ok) throw new AppError(`来源返回 HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_PLAYLIST_BYTES) { await response.body?.cancel(); throw new AppError('列表超过 4 MB 上限'); }
    if (!response.body) throw new AppError('来源返回空内容');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        context.bytes += value.byteLength;
        if (context.bytes > MAX_PLAYLIST_BYTES) throw new AppError('列表超过 4 MB 上限');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof TypeError) throw new AppError('来源内容不是有效 UTF-8 编码'); throw error; }
    const content = text.replace(/^\uFEFF/, '').trim();
    if ((format === 'auto' || format === 'json') && content.startsWith('{')) {
      let config;
      try { config = JSON.parse(content); } catch { throw new AppError('JSON 语法错误'); }
      if (!Array.isArray(config.channels) && Array.isArray(config.lives)) {
        if (depth) throw new AppError('直播配置不支持多层嵌套引用');
        if (!config.lives.length || config.lives.length > 8) throw new AppError('JSON 直播配置须包含 1～8 个 lives 列表引用');
        const lists = [];
        for (const live of config.lives) {
          if (!live || typeof live.url !== 'string' || !live.url.trim()) throw new AppError('JSON lives 条目缺少列表网址 url');
          let target;
          try { target = new URL(live.url, url).href; } catch { throw new AppError('JSON lives 列表网址格式错误'); }
          try { lists.push(await loadPlaylist(target, fetcher, 'auto', context, depth + 1)); }
          catch (error) {
            if (error instanceof AppError) throw new AppError(`JSON 直播列表 ${live.name || 'live'}：${error.message}`);
            throw error;
          }
        }
        const parsed = validateM3U('#EXTM3U\n' + lists.map(list => list.text.split('\n').slice(1).join('\n')).join(''));
        return { ...parsed, format: 'json', totalChannels: lists.reduce((sum, list) => sum + list.totalChannels, 0), removed: lists.reduce((sum, list) => sum + list.removed, 0), removedDetails: lists.flatMap(list => list.removedDetails).slice(0, 20) };
      }
    }
    if (/^(?:[a-f\d]{2}){32,}$/i.test(content)) throw new AppError('来源返回十六进制编码或加密内容，需提供明文直播列表或解密方式');
    return parsePlaylist(text, format);
}
