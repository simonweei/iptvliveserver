const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let csrf = '', state = { sources: [], subscriptions: [] }, tab = 'sources', editing = null, clockOffset = 0;
const now = () => Date.now() + clockOffset;
const time = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
const subURL = id => `${location.origin}/sub/${id}/playlist.m3u`;
const badge = (text, status) => `<span class="badge ${status}">${text}</span>`;
const button = (action, id, label, style = '') => `<button data-action="${action}" data-id="${escapeHTML(id)}" class="${style}">${label}</button>`;
async function api(path, method = 'GET', data) {
  const result = await fetch(`/api${path}`, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  let json;
  try { json = await result.json(); }
  catch { throw new Error(`接口返回了非 JSON 响应（HTTP ${result.status}），请检查 Cloudflare Access 策略或 Pages Functions 路由。`); }
  if (!result.ok) { if (result.status === 401 && path !== '/login') showLogin(); throw new Error(`${json.error || '请求失败'}${json.details ? `；详情：${json.details}` : ''}`); }
  return json;
}
function showLogin() { $('#login-view').hidden = false; $('#app-view').hidden = true; $('#editor').close(); csrf = ''; }
function notice(message, bad = false) { const node = $('#notice'); node.textContent = message; node.classList.toggle('bad', bad); node.hidden = false; }
async function load() { state = await api('/state'); clockOffset = state.serverTime - Date.now(); render(); }
async function enter() {
  $('#login-view').hidden = true; $('#app-view').hidden = false;
  try { await load(); } catch (error) { notice(error.message, true); }
}
function render() {
  const titles = { sources: ['直播源', '管理来源网址和更新节奏，让订阅始终保持最新。', '＋ 添加直播源'], subscriptions: ['订阅链接', '为设备定义好记的地址，从创建时开始计算有效期。', '＋ 创建订阅'], logs: ['更新记录', '检查最近更新结果。自动过滤无效条目；拉取失败或没有有效频道时保留旧列表。', ''] };
  $('#page-title').textContent = titles[tab][0]; $('#page-description').textContent = titles[tab][1]; $('#create').textContent = titles[tab][2]; $('#create').hidden = tab === 'logs';
  document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node.dataset.tab === tab));
  const active = state.subscriptions.filter(sub => sub.enabled && (sub.expiresAt === null || sub.expiresAt > now())).length;
  $('#stats').innerHTML = [[state.sources.length, '直播来源', '个源'], [state.sources.reduce((sum, source) => sum + (source.status?.channels || 0), 0), '已保存频道', '个频道'], [active, '有效订阅', '个链接']].map(([value, label, unit]) => `<div class="stat"><p>${label}</p><strong>${value}</strong><small>${unit}</small></div>`).join('');
  if (tab === 'sources') renderSources(); else if (tab === 'subscriptions') renderSubscriptions(); else renderLogs();
}
function empty(title, description, action) { return `<div class="empty"><span class="empty-icon">◫</span><h2>${title}</h2><p class="muted">${description}</p>${action ? button(action, '', '＋ 开始创建', 'primary') : ''}</div>`; }
function renderSources() {
  if (!state.sources.length) { $('#content').innerHTML = empty('添加你的第一个直播源', '填写 M3U 来源网址，校验通过后即可创建订阅。', 'create-source'); return; }
  $('#content').innerHTML = `<div class="section-bar"><h2>全部来源</h2><span>共 ${state.sources.length} 个来源</span></div><div class="cards">${state.sources.map(source => {
    const status = source.status;
    return `<article class="source-card"><div class="card-heading"><div><h3>${escapeHTML(source.name)}</h3></div>${!source.enabled ? badge('自动更新已停用', 'off') : status?.lastError ? badge('更新异常', 'bad') : status?.lastSuccessAt ? badge('已保存', 'good') : badge('暂无列表', 'off')}</div><div class="url">${escapeHTML(source.url)}</div><dl class="metadata"><div><dt>更新间隔</dt><dd>${Number(source.intervalDays.toFixed(3))} 天</dd></div><div><dt>频道数量</dt><dd>${status?.channels ?? '—'}</dd></div><div><dt>最近成功</dt><dd>${time(status?.lastSuccessAt)}</dd></div><div><dt>下次更新</dt><dd>${source.enabled ? source.nextUpdateAt <= now() ? '等待调度' : time(source.nextUpdateAt) : '已停用'}</dd></div></dl>${status?.lastError ? `<p class="error">${escapeHTML(status.lastError)}</p>` : ''}<div class="card-actions">${button('refresh', source.id, '↻ 立即更新')}${button('edit-source', source.id, '编辑')}${button('rollback', source.id, '回滚')}${button('delete-source', source.id, '删除', 'text-button')}</div></article>`;
  }).join('')}</div>`;
}
function renderSubscriptions() {
  if (!state.subscriptions.length) { $('#content').innerHTML = empty('为你的设备创建订阅', '使用 keting、bedroom 等标识，生成固定的客户端链接。', 'create-subscription'); return; }
  $('#content').innerHTML = `<div class="section-bar"><h2>全部订阅</h2><span>客户端数量不限</span></div><div class="table-wrap"><table><thead><tr><th>备注 / 链接</th><th>直播源</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.subscriptions.map(sub => {
    const source = state.sources.find(source => source.id === sub.sourceId);
    return `<tr><td><strong>${escapeHTML(sub.name)}</strong><span class="link">${escapeHTML(subURL(sub.id))}</span></td><td>${escapeHTML(source?.name || sub.sourceId)}</td><td>${sub.expiresAt === null ? '永久' : time(sub.expiresAt)}<br><span class="hint">创建 ${time(sub.createdAt)}</span></td><td>${!sub.enabled ? badge('已禁用', 'off') : sub.expiresAt !== null && sub.expiresAt <= now() ? badge('已到期', 'bad') : badge('有效', 'good')}</td><td><div class="row-actions">${button('copy', sub.id, '复制链接')}${button('edit-subscription', sub.id, '编辑')}${button('renew', sub.id, '续期')}${button('toggle', sub.id, sub.enabled ? '禁用' : '启用')}${button('delete-subscription', sub.id, '删除', 'danger')}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderLogs() {
  const logs = state.sources.flatMap(source => (source.status?.history || []).map(log => ({ ...log, source: source.name }))).sort((a, b) => b.at - a.at);
  if (!logs.length) { $('#content').innerHTML = empty('还没有更新记录', '添加来源或点击立即更新后，结果将显示在这里。'); return; }
  $('#content').innerHTML = `<div class="section-bar"><h2>最近更新</h2><span>每个源保留最近 10 条记录</span></div><div class="table-wrap"><table><thead><tr><th>更新时间</th><th>来源</th><th>结果</th><th>详情</th></tr></thead><tbody>${logs.map(log => `<tr><td>${time(log.at)}</td><td>${escapeHTML(log.source)}</td><td>${badge(log.ok ? '成功' : '失败', log.ok ? 'good' : 'bad')}</td><td class="log-message">${escapeHTML(log.message)}</td></tr>`).join('')}</tbody></table></div>`;
}
function input(label, key, value = '', attributes = '', hint = '') { return `<label>${label}<input name="${key}" value="${escapeHTML(value)}" ${attributes}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`; }
function daySelect(label = '有效期', defaultDays = 30) { return `<label>${label}<select name="days">${[30, 90, 180, 360, 0].map(days => `<option value="${days}" ${days === defaultDays ? 'selected' : ''}>${days ? `${days} 天` : '永久'}</option>`).join('')}</select><span class="hint">${label === '有效期' ? '从创建订阅的时间开始计算。' : '从现在与原到期时间中较晚的时间开始追加。'}</span></label>`; }
function sourceSelect(value = '') { return `<label>绑定直播源<select name="sourceId" required>${state.sources.map(source => `<option value="${escapeHTML(source.id)}" ${source.id === value ? 'selected' : ''}>${escapeHTML(source.name)}</option>`).join('')}</select></label>`; }
function openEditor(kind, id) {
  if (kind === 'subscription' && !state.sources.length) { notice('请先添加一个直播源。', true); return; }
  const record = kind === 'source' ? state.sources.find(source => source.id === id) : state.subscriptions.find(sub => sub.id === id);
  editing = { kind, record }; $('#form-error').textContent = ''; $('#save').disabled = false;
  $('#dialog-eyebrow').textContent = kind === 'source' ? '直播来源' : '客户端订阅';
  $('#dialog-title').textContent = kind === 'renew' ? '续订有效期' : `${record ? '编辑' : '创建'}${kind === 'source' ? '直播源' : '订阅'}`;
  if (kind === 'source') {
    $('#fields').innerHTML = input('名称', 'name', record?.name, 'required maxlength="100" placeholder="例如：IPv4 直播源"') + input('来源网址', 'url', record?.url, 'required type="url" placeholder="https://example.com/playlist.m3u"', '保存时立即拉取，仅发布有效频道，自动删除停用和错误条目。') + input('更新间隔（天）', 'intervalDays', Math.max(1, Math.ceil(record?.intervalDays || 1)), 'required type="number" min="1" max="3650" step="1"', '1 = 每天，7 = 每周，30 = 每 30 天。自动更新需外部定时服务调用接口；仅部署 Pages 时请手动更新。旧版分钟配置继续按原间隔运行，重新保存时改为整数天。') + (record ? `<label class="check-label"><input name="enabled" type="checkbox" ${record.enabled ? 'checked' : ''}>启用自动更新</label><p class="hint">修改来源网址后，点击「立即更新」发布新内容；停用自动更新不影响订阅读取已保存列表。</p>` : '');
  } else if (kind === 'renew') $('#fields').innerHTML = `<p class="muted">${escapeHTML(record.name)} · 当前到期：${record.expiresAt === null ? '永久' : time(record.expiresAt)}</p>` + daySelect('追加有效期', record.expiresAt === null ? 0 : 30);
  else $('#fields').innerHTML = input('备注', 'name', record?.name, 'required maxlength="100" placeholder="例如：客厅电视"') + input('订阅标识', 'id', record?.id, 'required pattern="[a-zA-Z0-9_-]{1,64}" maxlength="64" placeholder="例如：keting"', '统一转为小写。修改标识后，旧链接失效。') + sourceSelect(record?.sourceId) + (record ? `<label class="check-label"><input type="checkbox" name="enabled" ${record.enabled ? 'checked' : ''}>启用订阅</label><p class="hint">编辑不改变原有效期。需要延长时请使用「续期」。</p>` : daySelect()) + '<p class="hint">订阅客户端数量不限。知道链接的人均可拉取列表。</p>';
  $('#editor').showModal();
}
async function confirmAction(title, description) {
  $('#confirm-title').textContent = title; $('#confirm-text').textContent = description; $('#confirmation').returnValue = '';
  const result = new Promise(resolve => $('#confirmation').addEventListener('close', () => resolve($('#confirmation').returnValue === 'ok'), { once: true }));
  $('#confirmation').showModal(); return result;
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true; $('#login-error').textContent = '';
  try { const result = await api('/login', 'POST', { password: new FormData(event.target).get('password') }); csrf = result.csrf; event.target.reset(); await enter(); }
  catch (error) { $('#login-error').textContent = error.message; } finally { submit.disabled = false; }
});
$('#editor-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('#save'); submit.disabled = true; $('#form-error').textContent = '';
  try {
    const data = Object.fromEntries(new FormData(event.target)), { kind, record } = editing;
    if (kind === 'source') { data.intervalDays = Number(data.intervalDays); data.enabled = data.enabled === 'on'; }
    if (kind === 'subscription') data.enabled = data.enabled === 'on';
    if ('days' in data) data.days = Number(data.days);
    if (kind === 'subscription' && record && data.id.toLowerCase() !== record.id && !await confirmAction('修改订阅地址？', '旧链接将失效，需要在客户端重新填写新链接。')) return;
    const path = kind === 'renew' ? `/subscriptions/${record.id}/renew` : `/${kind === 'source' ? 'sources' : 'subscriptions'}${record ? `/${record.id}` : ''}`;
    const result = await api(path, kind === 'renew' || !record ? 'POST' : 'PUT', data);
    $('#editor').close(); await load();
    notice(result.refresh && !result.refresh.ok ? `源已创建，但列表尚未发布：${result.refresh.error}` : '已保存。', Boolean(result.refresh && !result.refresh.ok));
  } catch (error) { $('#form-error').textContent = error.message; } finally { submit.disabled = false; }
});
document.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () => { tab = node.dataset.tab; $('#notice').hidden = true; render(); }));
$('#create').addEventListener('click', () => openEditor(tab === 'sources' ? 'source' : 'subscription'));
$('#close-editor').addEventListener('click', () => $('#editor').close()); $('#cancel-editor').addEventListener('click', () => $('#editor').close());
$('#reload').addEventListener('click', async () => { try { await load(); notice('已刷新。'); } catch (error) { notice(error.message, true); } });
$('#logout').addEventListener('click', async () => { try { await api('/logout', 'POST'); showLogin(); } catch (error) { notice(error.message, true); } });
$('#content').addEventListener('click', async event => {
  const node = event.target.closest('[data-action]'); if (!node) return;
  const { action, id } = node.dataset; node.disabled = true;
  try {
    if (action.startsWith('create-')) { openEditor(action.endsWith('source') ? 'source' : 'subscription'); return; }
    if (action.startsWith('edit-')) { openEditor(action.endsWith('source') ? 'source' : 'subscription', id); return; }
    if (action === 'renew') { openEditor('renew', id); return; }
    if (action === 'copy') {
      if (navigator.clipboard) { await navigator.clipboard.writeText(subURL(id)); notice('订阅链接已复制。'); }
      else notice(`请复制此链接：${subURL(id)}`);
      return;
    }
    if (action.startsWith('delete-')) {
      if (!await confirmAction('确认删除？', action.endsWith('source') ? '只有没有订阅引用的直播源才能删除。' : '删除后，此订阅链接将无法使用。')) return;
      await api(`/${action.endsWith('source') ? 'sources' : 'subscriptions'}/${id}`, 'DELETE');
    } else if (action === 'toggle') {
      const sub = state.subscriptions.find(sub => sub.id === id);
      await api(`/subscriptions/${id}`, 'PUT', { ...sub, enabled: !sub.enabled });
    } else {
      if (action === 'rollback' && !await confirmAction('回滚列表？', '将当前列表替换为上一份成功保存的版本。')) return;
      const result = await api(`/sources/${id}/${action}`, 'POST');
      await load(); notice(result.ok ? `已${action === 'rollback' ? '回滚' : '更新'}，保留 ${result.channels} 个有效频道，过滤 ${result.removed || 0} 个无效条目。` : `更新失败，旧列表保留：${result.error}`, !result.ok); return;
    }
    await load(); notice('操作已完成。');
  } catch (error) { notice(error.message, true); } finally { node.disabled = false; }
});
(async () => {
  try { csrf = (await api('/session')).csrf; await enter(); }
  catch (error) { showLogin(); if (error.message !== '请先登录') $('#login-error').textContent = error.message; }
})();
