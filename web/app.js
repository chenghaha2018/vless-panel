'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

// 独立协议不支持多用户
const STANDALONE = ['snell', 'snell-v5', 'snell-shadowtls', 'snell-v5-shadowtls', 'ss2022-shadowtls', 'anytls', 'naive'];
const GB = 1073741824;

// ─── 工具 ────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(2) + ' ' + units[i];
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 4000 : 2000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非 HTTPS 下 clipboard API 不可用
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

async function api(path, opts = {}) {
  const res = await fetch('api/' + path, {
    ...opts,
    headers: { 'X-Panel': '1', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('未登录'); }
  if (opts.raw) return res.text();
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '请求失败');
  return data;
}

const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

// 执行写操作: 按钮显示忙碌, 成功后提示并刷新当前页
async function act(btn, path, body, { reload = true } = {}) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try {
    const r = await post(path, body);
    toast(r.message || '完成');
    if (reload) await route(true);
    return r;
  } catch (e) {
    if (e.message !== '未登录') toast(e.message, true);
    return null;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

// 从分享链接中取协议类型和备注
function parseLink(link) {
  const scheme = link.split('://')[0];
  const remark = decodeURIComponent((link.split('#')[1] || '').trim());
  const m = link.match(/@?\[?([0-9a-fA-F:.]+|[\w.-]+)\]?:(\d+)/);
  return { scheme, remark, port: m ? Number(m[2]) : null };
}

// ─── 弹窗 ────────────────────────────────────────────────────

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  const m = $('#modal');
  if (!m.open) m.showModal();
  return $('#modal-body');
}
const closeModal = () => $('#modal').close();

function confirmBox(title, text, danger = true) {
  return new Promise((resolve) => {
    const body = openModal(title, `<p>${esc(text)}</p>
      <div class="form-actions"><button class="btn" data-no>取消</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>确定</button></div>`);
    const done = (v) => { $('#modal').removeEventListener('close', onClose); closeModal(); resolve(v); };
    const onClose = () => resolve(false);
    $('#modal').addEventListener('close', onClose, { once: true });
    $('[data-yes]', body).onclick = () => done(true);
    $('[data-no]', body).onclick = () => done(false);
  });
}

// 表单弹窗: fields = [{name, label, type, value, options, hint, attrs}], onSubmit(values, btn) 返回 true 时关闭
function formBox(title, fields, submitText, onSubmit) {
  const body = openModal(title, `<form class="form" novalidate>
    ${fields.map((f) => `<label>${esc(f.label)}
      ${f.type === 'select'
        ? `<select name="${f.name}">${f.options.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(f.value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`
        : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.attrs || ''}>`}
      ${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ''}</label>`).join('')}
    <p class="error" hidden></p>
    <div class="form-actions"><button type="button" class="btn" data-cancel>取消</button>
      <button class="btn primary" type="submit">${esc(submitText)}</button></div></form>`);
  const form = $('form', body);
  $('[data-cancel]', form).onclick = closeModal;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    const values = Object.fromEntries(new FormData(form));
    btn.disabled = true;
    try {
      if (await onSubmit(values, btn)) closeModal();
    } catch (ex) {
      const err = $('.error', form);
      err.textContent = ex.message;
      err.hidden = false;
    } finally { btn.disabled = false; }
  };
  $('input, select', form)?.focus();
}

async function showQr(link, label) {
  openModal(label + ' 二维码', '<div class="qr">生成中…</div>');
  try {
    const svg = await api('qr?text=' + encodeURIComponent(link), { raw: true });
    $('#modal-body').innerHTML = `<div class="qr">${svg}</div><p class="qr-link mono">${esc(link)}</p>
      <div class="card-actions"><button class="btn" data-copy="${esc(link)}">复制链接</button></div>`;
  } catch (e) { $('#modal-body').textContent = '生成失败: ' + e.message; }
}

// ─── 状态 ────────────────────────────────────────────────────

const state = { status: null, links: null };

async function load(force) {
  const q = force ? '?fresh=1' : '';
  if (force || !state.status) state.status = await api('status' + q);
  if (force || !state.links) state.links = await api('links' + q);
}

function allUsers() {
  const rows = [];
  for (const p of state.status.protocols) {
    for (const inst of p.instances) {
      for (const u of inst.users) rows.push({ ...u, core: p.core, proto: p.proto, protoName: p.name, port: inst.port });
    }
  }
  return rows;
}

// ─── 页面 ────────────────────────────────────────────────────

const pages = {
  dashboard: { title: '仪表盘', render: renderDashboard },
  protocols: { title: '协议', render: renderProtocols },
  install: { title: '安装协议', render: renderInstall },
  task: { title: '任务', render: renderTask },
  users: { title: '用户', render: renderUsers },
  links: { title: '分享链接', render: renderLinks },
  sub: { title: '订阅服务', render: renderSub },
  notify: { title: '通知与流量', render: renderNotify },
  routing: { title: '分流 / 链式代理', render: renderRouting },
  system: { title: '系统', render: renderSystem },
  logs: { title: '运行日志', render: renderLogs },
};

function renderDashboard(view) {
  const s = state.status;
  const users = allUsers().filter((u) => u.name !== 'default');
  const instances = s.protocols.reduce((n, p) => n + p.instances.length, 0);
  const running = s.services.filter((x) => x.active).length;

  view.innerHTML = `
    <div class="tiles">
      ${tile(s.protocols.length, '已装协议')}
      ${tile(instances, '端口实例')}
      ${tile(users.length, '用户')}
      ${tile(`${running}/${s.services.length}`, '运行中服务')}
      ${tile(s.routing_rules, '分流规则')}
    </div>
    <div class="grid">
      <div class="card">
        <h3>系统</h3>
        <dl class="kv">
          <dt>系统</dt><dd>${esc(s.system.os)}</dd>
          <dt>内核</dt><dd>${esc(s.system.kernel)}</dd>
          <dt>IPv4</dt><dd class="mono">${esc(s.system.ipv4 || '—')}</dd>
          <dt>IPv6</dt><dd class="mono">${esc(s.system.ipv6 || '—')}</dd>
          <dt>脚本版本</dt><dd>v${esc(s.version)}</dd>
        </dl>
      </div>
      <div class="card">
        <h3>核心版本</h3>
        <dl class="kv">
          <dt>Xray</dt><dd>${verBadge(s.cores.xray)}</dd>
          <dt>Sing-box</dt><dd>${verBadge(s.cores.singbox)}</dd>
        </dl>
      </div>
      <div class="card span2">
        <h3>服务</h3>
        ${s.services.length ? `<ul class="svc-list">${s.services.map((x) => `
          <li><span class="dot ${x.active ? 'ok' : 'bad'}"></span>
            <span class="name">${esc(x.name)} <span class="badge ${x.active ? 'ok' : 'bad'}">${x.active ? '运行中' : '已停止'}</span></span>
            ${x.active
              ? `<button class="btn sm" data-svc="restart" data-name="${esc(x.name)}">重启</button>
                 <button class="btn sm" data-svc="stop" data-name="${esc(x.name)}">停止</button>`
              : `<button class="btn sm primary" data-svc="start" data-name="${esc(x.name)}">启动</button>`}
          </li>`).join('')}
        </ul>
        <div class="card-actions">
          <button class="btn" data-svc="restart" data-name="all">全部重启</button>
          <button class="btn" data-svc="start" data-name="all">全部启动</button>
          <button class="btn danger-text" data-svc="stop" data-name="all">全部停止</button>
        </div>` : '<p class="muted">暂无服务</p>'}
      </div>
    </div>`;

  view.onclick = async (e) => {
    const b = e.target.closest('[data-svc]');
    if (!b) return;
    const { svc: action, name } = b.dataset;
    const label = { start: '启动', stop: '停止', restart: '重启' }[action];
    if (action === 'stop' && !(await confirmBox(`${label}服务`,
      name === 'all' ? '停止全部服务后所有节点都会断开, 确定吗?' : `停止 ${name} 后相关节点会断开, 确定吗?`))) return;
    act(b, 'svc', { action, name });
  };
}

const tile = (num, label) => `<div class="card tile"><div class="num">${esc(num)}</div><div class="label">${esc(label)}</div></div>`;

function verBadge(v) {
  if (v === '未安装') return '<span class="badge">未安装</span>';
  if (v === '未知') return '<span class="badge warn">未知</span>';
  return `<span class="mono">${esc(v)}</span>`;
}

function renderProtocols(view) {
  const ps = state.status.protocols;
  if (!ps.length) {
    view.innerHTML = '<div class="card empty"><p>还没有安装协议</p><a class="btn primary" href="#/install">安装协议</a></div>';
    return;
  }
  view.innerHTML = `
    <div class="toolbar"><span class="spacer"></span>
      <button class="btn danger-text" id="uninstall">卸载协议</button>
      <a class="btn primary" href="#/install">安装新协议</a></div>
    <div class="grid">${ps.map((p, i) => {
    const ports = p.instances.map((x) => x.port).join(', ');
    const sni = [...new Set(p.instances.map((x) => x.sni || x.domain).filter(Boolean))].join(', ');
    const nUsers = p.instances.reduce((n, x) => n + x.users.length, 0);
    return `<div class="card">
      <h3>${esc(p.name)} <span class="badge">${p.core === 'xray' ? 'Xray' : 'Sing-box'}</span></h3>
      <dl class="kv">
        <dt>端口</dt><dd class="mono">${esc(ports)}</dd>
        ${sni ? `<dt>SNI / 域名</dt><dd>${esc(sni)}</dd>` : ''}
        <dt>用户</dt><dd>${STANDALONE.includes(p.proto) ? '<span class="muted">独立协议, 固定密钥</span>' : nUsers}</dd>
      </dl>
      <div class="card-actions">
        <button class="btn sm" data-proto-links="${i}">分享链接 / 二维码</button>
        ${STANDALONE.includes(p.proto) ? '' : `<button class="btn sm" data-proto-add="${i}">添加用户</button>`}
      </div>
    </div>`;
  }).join('')}</div>`;

  $('#uninstall').onclick = (e) => runTask(e.currentTarget, { kind: 'uninstall' },
    '卸载协议', '接下来会列出已安装的协议, 选择要卸载的那个。卸载后该协议的所有链接立即失效。');

  view.onclick = (e) => {
    const add = e.target.closest('[data-proto-add]');
    if (add) return addUserForm(ps[Number(add.dataset.protoAdd)]);
    const b = e.target.closest('[data-proto-links]');
    if (!b) return;
    const p = ps[Number(b.dataset.protoLinks)];
    const ports = new Set(p.instances.map((x) => x.port));
    const items = [
      ...state.links.links.filter((l) => ports.has(parseLink(l).port)).map((l) => ({ link: l, label: '默认' })),
      ...state.links.user_links.filter((u) => u.proto === p.proto).map((u) => ({ link: u.link, label: u.user })),
    ];
    openModal(p.name + ' 分享链接', linkList(items));
  };
}

function addUserForm(preset) {
  const protos = state.status.protocols.filter((p) => !STANDALONE.includes(p.proto));
  if (!protos.length) return toast('没有支持多用户的协议', true);
  formBox('添加用户', [
    { name: 'proto', label: '协议', type: 'select', value: preset ? `${preset.core}/${preset.proto}` : '',
      options: protos.map((p) => [`${p.core}/${p.proto}`, `${p.name} (${p.instances.map((i) => i.port).join(',')})`]) },
    { name: 'name', label: '用户名', attrs: 'required maxlength="32" autocomplete="off"', hint: '字母、数字、下划线、横线' },
    { name: 'quota_gb', label: '流量配额 (GB)', type: 'number', value: 0, attrs: 'min="0" step="1"', hint: '0 表示不限' },
    { name: 'expire', label: '到期日期', type: 'date', hint: '留空表示永不过期' },
  ], '添加', async (v) => {
    const [core, proto] = v.proto.split('/');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(v.name)) throw new Error('用户名只能包含字母、数字、下划线和横线');
    const r = await post('users/add', { core, proto, name: v.name, quota_gb: Number(v.quota_gb) || 0, expire: v.expire });
    toast(r.message);
    route(true);
    return true;
  });
}

function renderUsers(view) {
  const rows = allUsers();
  view.innerHTML = `
    <div class="toolbar">
      <input id="user-q" placeholder="搜索用户名 / 协议" aria-label="搜索">
      <span class="muted" id="user-count"></span>
      <span class="spacer"></span>
      <button class="btn" id="sync-traffic">同步流量</button>
      <button class="btn" id="reset-all">重置全部流量</button>
      <button class="btn primary" id="add-user">添加用户</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>用户</th><th>协议</th><th>端口</th><th>流量</th><th>到期</th><th>路由</th><th>启用</th><th>操作</th></tr></thead>
      <tbody id="user-body"></tbody>
    </table></div>`;

  const today = new Date().toISOString().slice(0, 10);
  let list = [];
  const draw = () => {
    const q = $('#user-q').value.trim().toLowerCase();
    list = rows.filter((u) => !q || u.name.toLowerCase().includes(q) || u.protoName.toLowerCase().includes(q));
    $('#user-count').textContent = `共 ${list.length} 个`;
    const body = $('#user-body');
    body.innerHTML = list.map((u, i) => {
      const expired = u.expire_date && u.expire_date < today;
      const managed = !STANDALONE.includes(u.proto);
      return `<tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.protoName)}</td>
        <td class="mono">${esc(u.port)}</td>
        <td>${fmtBytes(u.used)} / ${u.quota ? fmtBytes(u.quota) : '不限'}
          ${u.quota ? `<div class="bar${u.used >= u.quota ? ' over' : ''}"><i data-w="${i}"></i></div>` : ''}</td>
        <td>${u.expire_date ? `<span class="${expired ? 'error' : ''}">${esc(u.expire_date)}</span>` : '<span class="muted">永久</span>'}</td>
        <td>${u.routing ? esc(u.routing) : '<span class="muted">默认</span>'}</td>
        <td>${managed ? `<label class="switch" title="${u.enabled ? '点击禁用' : '点击启用'}">
            <input type="checkbox" data-i="${i}" data-op="enable" ${u.enabled ? 'checked' : ''}><span></span></label>` : ''}</td>
        <td class="row-actions">${managed ? `
          <button class="btn sm" data-i="${i}" data-op="quota">配额</button>
          <button class="btn sm" data-i="${i}" data-op="expire">到期</button>
          <button class="btn sm" data-i="${i}" data-op="reset">清零</button>
          ${u.name === 'default' ? '' : `<button class="btn sm danger-text" data-i="${i}" data-op="del">删除</button>`}` : ''}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">没有匹配的用户</td></tr>';
    // CSP 禁止内联 style 属性, 进度条宽度用 CSSOM 设置
    body.querySelectorAll('[data-w]').forEach((el) => {
      const u = list[Number(el.dataset.w)];
      el.style.width = Math.min(100, (u.used / u.quota) * 100) + '%';
    });
  };
  $('#user-q').oninput = draw;
  draw();

  $('#add-user').onclick = () => addUserForm();
  $('#sync-traffic').onclick = (e) => act(e.currentTarget, 'traffic/sync');
  $('#reset-all').onclick = async (e) => {
    const b = e.currentTarget;
    if (await confirmBox('重置全部流量', '所有协议所有用户的已用流量都会清零, 确定吗?')) act(b, 'users/reset', { all: true });
  };

  $('#user-body').onchange = (e) => {
    const t = e.target.closest('[data-op=enable]');
    if (!t) return;
    const u = list[Number(t.dataset.i)];
    t.disabled = true;
    act(null, 'users/enable', { core: u.core, proto: u.proto, name: u.name, enabled: t.checked })
      .then((r) => { if (!r) { t.checked = !t.checked; t.disabled = false; } });
  };

  $('#user-body').onclick = async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    const u = list[Number(b.dataset.i)];
    const id = { core: u.core, proto: u.proto, name: u.name };
    switch (b.dataset.op) {
      case 'quota':
        return formBox(`设置配额 - ${u.name}`, [
          { name: 'quota_gb', label: '流量配额 (GB)', type: 'number', value: Math.round(u.quota / GB), attrs: 'min="0" step="1"', hint: '0 表示不限' },
        ], '保存', async (v) => !!(await act(null, 'users/quota', { ...id, quota_gb: Number(v.quota_gb) || 0 })));
      case 'expire':
        return formBox(`到期日期 - ${u.name}`, [
          { name: 'expire', label: '到期日期', type: 'date', value: u.expire_date, hint: '清空表示永不过期; 改为未来日期会自动重新启用已过期的用户' },
        ], '保存', async (v) => !!(await act(null, 'users/expire', { ...id, expire: v.expire || 'never' })));
      case 'reset':
        if (await confirmBox('清零流量', `将 ${u.name} 的已用流量 (${fmtBytes(u.used)}) 清零, 确定吗?`)) act(b, 'users/reset', id);
        return;
      case 'del':
        if (await confirmBox('删除用户', `删除 ${u.name} (${u.protoName}) 后其链接立即失效, 无法恢复。确定吗?`)) act(b, 'users/del', id);
    }
  };
}

function renderLinks(view) {
  const items = [
    ...state.links.links.map((l) => ({ link: l, label: parseLink(l).remark || parseLink(l).scheme })),
    ...state.links.user_links.map((u) => ({ link: u.link, label: `${u.user} · ${u.proto}` })),
  ];
  view.innerHTML = `<div class="card">${items.length ? linkList(items) : '<div class="empty">暂无分享链接</div>'}
    ${items.length ? `<div class="card-actions"><button class="btn" id="copy-all">复制全部</button></div>` : ''}</div>`;
  const all = $('#copy-all');
  if (all) all.onclick = () => copy(items.map((x) => x.link).join('\n'));
}

function linkList(items) {
  if (!items.length) return '<div class="empty">暂无链接</div>';
  return items.map((x) => `<div class="link-row">
      <div class="info"><div>${esc(x.label)} <span class="badge">${esc(parseLink(x.link).scheme)}</span></div>
        <code>${esc(x.link)}</code></div>
      <button class="btn sm" data-copy="${esc(x.link)}">复制</button>
      <button class="btn sm" data-qr="${esc(x.link)}" data-label="${esc(x.label)}">二维码</button>
    </div>`).join('');
}

async function renderSub(view, force) {
  view.innerHTML = '<div class="card muted">加载中…</div>';
  const s = await api('sub' + (force ? '?fresh=1' : ''));
  if (!s.enabled) {
    view.innerHTML = `<div class="card empty">
      <p>订阅服务未启用。</p>
      <p class="muted">启用后客户端可以通过一个链接自动获取全部节点 (Clash / Surge / V2Ray)。需要 Nginx, 向导会自动安装。</p>
      <button class="btn primary" id="sub-setup">启用订阅服务</button></div>`;
    $('#sub-setup').onclick = (e) => runTask(e.currentTarget, { kind: 'sub-setup' }, '启用订阅服务', '将按步骤设置订阅端口、域名和 HTTPS。');
    return;
  }
  const rows = [['Clash / Clash Verge (推荐)', s.urls.clash], ['Surge', s.urls.surge], ['V2Ray / Loon / 通用', s.urls.v2ray]];
  view.innerHTML = `
    <div class="grid">
      <div class="card">
        <h3>状态 <span class="badge ok">已启用</span></h3>
        <dl class="kv">
          <dt>端口</dt><dd class="mono">${esc(s.port)}</dd>
          <dt>域名</dt><dd>${esc(s.domain || '未绑定 (使用 IP)')}</dd>
          <dt>HTTPS</dt><dd>${s.https ? '是' : '否'}</dd>
        </dl>
        ${s.https && !s.domain ? '<p class="hint warn-text">使用自签名证书, 部分客户端可能无法拉取订阅, 建议绑定域名或使用 HTTP。</p>' : ''}
        <div class="card-actions">
          <button class="btn" id="sub-update">更新订阅内容</button>
          <button class="btn" id="sub-reconf">重新配置</button>
          <button class="btn" id="sub-reset">重置订阅地址</button>
          <button class="btn danger-text" id="sub-disable">停用</button>
        </div>
      </div>
    </div>
    <div class="card section">
      <h3>订阅链接</h3>
      ${rows.map(([label, url]) => `<div class="link-row">
        <div class="info"><div>${esc(label)}</div><code>${esc(url)}</code></div>
        <button class="btn sm" data-copy="${esc(url)}">复制</button>
        <button class="btn sm" data-qr="${esc(url)}" data-label="${esc(label)}">二维码</button></div>`).join('')}
      <p class="hint muted">订阅路径包含随机 UUID, 请妥善保管。新增/删除用户后点「更新订阅内容」。</p>
    </div>`;
  const reload = () => renderSub(view, true);
  $('#sub-update').onclick = (e) => act(e.currentTarget, 'sub/update', {}, { reload: false });
  $('#sub-reconf').onclick = (e) => runTask(e.currentTarget, { kind: 'sub-setup' }, '重新配置订阅', '可以修改订阅端口、域名和 HTTPS 设置。');
  $('#sub-reset').onclick = async (e) => {
    const b = e.currentTarget;
    if (await confirmBox('重置订阅地址', '旧的订阅链接会立即失效, 所有客户端都需要重新导入。确定吗?')) {
      if (await act(b, 'sub/reset', {}, { reload: false })) reload();
    }
  };
  $('#sub-disable').onclick = async (e) => {
    const b = e.currentTarget;
    if (await confirmBox('停用订阅服务', '会删除订阅文件和 Nginx 订阅配置, 客户端将无法再更新订阅。确定吗?')) {
      if (await act(b, 'sub/disable', {}, { reload: false })) reload();
    }
  };
}

async function renderNotify(view) {
  view.innerHTML = '<div class="card muted">加载中…</div>';
  const { tg, traffic, monthly_reset: mr } = await api('settings');
  const pad = (n) => String(n).padStart(2, '0');
  view.innerHTML = `
    <div class="grid">
      <form class="card form" id="tg-form" novalidate>
        <h3>Telegram 通知</h3>
        <label class="switch-row">启用通知
          <span class="switch"><input type="checkbox" name="enabled" ${tg.enabled ? 'checked' : ''}><span></span></span></label>
        <label>Bot Token
          <input name="bot_token" type="password" autocomplete="off" placeholder="${tg.bot_token_set ? `已设置 ${esc(tg.bot_token_hint)}, 留空不修改` : '123456:ABC-DEF…'}"></label>
        <label>Chat ID<input name="chat_id" value="${esc(tg.chat_id)}" inputmode="numeric" placeholder="例如 123456789"></label>
        <label>流量告警阈值 (%)
          <input name="notify_quota_percent" type="number" min="1" max="100" value="${esc(tg.notify_quota_percent)}">
          <small class="muted">用户已用流量达到配额的这个比例时提醒</small></label>
        <label class="switch-row">每日流量报告
          <span class="switch"><input type="checkbox" name="notify_daily" ${tg.notify_daily ? 'checked' : ''}><span></span></span></label>
        <label>报告时间<input name="report_time" type="time" value="${pad(tg.daily_report_hour)}:${pad(tg.daily_report_minute)}"></label>
        <div class="form-actions">
          <button type="button" class="btn" id="tg-test">发送测试消息</button>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>

      <div>
        <form class="card form" id="traffic-form" novalidate>
          <h3>流量统计</h3>
          <label class="switch-row">自动同步流量
            <span class="switch"><input type="checkbox" name="enabled" ${traffic.cron ? 'checked' : ''}><span></span></span></label>
          <label>同步间隔 (分钟)<input name="interval" type="number" min="1" max="60" value="${esc(traffic.interval)}">
            <small class="muted">通过 crontab 定时从核心读取流量写入数据库</small></label>
          <div class="form-actions"><button class="btn primary" type="submit">保存</button></div>
        </form>

        <form class="card form section" id="reset-form" novalidate>
          <h3>按月自动重置流量</h3>
          <label>重置日期
            <select name="day">
              <option value="0">关闭</option>
              ${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${mr.day === i + 1 ? 'selected' : ''}>每月 ${i + 1} 日</option>`).join('')}
            </select>
            <small class="muted">到期检查任务每天 3:00 执行, 到达当天会清零所有用户流量</small></label>
          <div class="form-actions"><button class="btn primary" type="submit">保存</button></div>
        </form>
      </div>
    </div>`;

  const tgForm = $('#tg-form');
  tgForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = tgForm.elements;
    const [h, m] = (f.report_time.value || '09:00').split(':');
    const body = {
      enabled: f.enabled.checked, notify_daily: f.notify_daily.checked,
      chat_id: f.chat_id.value.trim(), notify_quota_percent: Number(f.notify_quota_percent.value),
      daily_report_hour: Number(h), daily_report_minute: Number(m),
    };
    if (f.bot_token.value.trim()) body.bot_token = f.bot_token.value.trim();
    if (!body.chat_id) delete body.chat_id;
    const r = await act($('[type=submit]', tgForm), 'tg', body, { reload: false });
    if (r) renderNotify(view);
  };
  $('#tg-test').onclick = (e) => act(e.currentTarget, 'tg/test', {}, { reload: false });

  $('#traffic-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    act($('[type=submit]', e.target), 'traffic/cron', { enabled: f.enabled.checked, interval: Number(f.interval.value) }, { reload: false });
  };
  $('#reset-form').onsubmit = (e) => {
    e.preventDefault();
    act($('[type=submit]', e.target), 'monthly-reset', { day: Number(e.target.elements.day.value) }, { reload: false });
  };
}

// ─── 安装协议 ────────────────────────────────────────────────

// 协议目录: Xray / Sing-box 的主流组合
//   install: 交给原脚本安装时用的协议名 (没有 = 脚本还不支持, 显示"待开发")
//   proto:   装好后在数据库里的协议名, 用于标"已安装" (默认同 install)
//   pick:    同一个安装入口下的子选项, 提示用户安装时选哪个
//   tags:    传输 / 安全, star: 推荐
const C = (name, desc, tags, o = {}) => ({ name, desc, tags, ...o });
const CATALOG = [
  ['Xray · VLESS', 'Xray', [
    C('VLESS + Reality + Vision', '抗封锁首选, 不需要域名和证书', ['TCP', 'Reality'], { install: 'vless', star: true }),
    C('VLESS + Reality + XHTTP', '多路复用, 可上下行分离', ['XHTTP', 'Reality'], { install: 'vless-xhttp', pick: '模式选 Reality 模式' }),
    C('VLESS + XHTTP + TLS (CDN)', '套 Cloudflare CDN, 隐藏服务器 IP; 需要域名', ['XHTTP', 'TLS', 'CDN'], { install: 'vless-xhttp', proto: 'vless-xhttp-cdn', pick: '模式选 TLS+CDN' }),
    C('VLESS + TLS + Vision', '真实证书直连, 可做 443 主协议带回落', ['TCP', 'TLS'], { install: 'vless-vision' }),
    C('VLESS Encryption', 'Xray 新版后量子加密 (ML-KEM-768) + Vision, 不需要域名和证书; 需新版客户端', ['TCP', 'ML-KEM'], { install: 'vless-enc' }),
  ]],
  ['Xray · Shadowsocks / SOCKS', 'Xray', [
    C('Shadowsocks 2022', '新版加密, 需要服务器时间准确', ['TCP/UDP', 'AEAD-2022'], { install: 'ss2022', star: true }),
    C('SS2022 + ShadowTLS v3', '用 TLS 握手伪装, 高阻断环境', ['TCP', 'ShadowTLS'], { install: 'ss2022', proto: 'ss2022-shadowtls', pick: '启用 ShadowTLS 选「是」' }),
    C('Shadowsocks 传统版', 'aes-256-gcm 等, 兼容性最好', ['TCP/UDP', 'AEAD'], { install: 'ss-legacy' }),
    C('SOCKS5', '带用户名密码, 适合做落地 / 内网', ['TCP/UDP'], { install: 'socks' }),
  ]],
  ['Sing-box', 'Sing-box', [
    C('Hysteria2', 'UDP 高速, 弱网和高丢包首选', ['QUIC', 'TLS'], { install: 'hy2', star: true }),
    C('TUIC v5', 'QUIC 协议, 低延迟', ['QUIC', 'TLS'], { install: 'tuic' }),
  ]],
  ['独立进程', '独立进程', [
    C('Snell v4', 'Surge 专属', ['TCP'], { install: 'snell' }),
    C('Snell v5', 'Surge 专属, 新版', ['TCP'], { install: 'snell-v5' }),
    C('Snell + ShadowTLS v3', 'Surge 专属, 高阻断环境', ['TCP', 'ShadowTLS'], { install: 'snell', proto: 'snell-shadowtls', pick: '启用 ShadowTLS 选「是」' }),
    C('AnyTLS', '对抗 TLS 指纹识别 (anytls-server)', ['TCP', 'TLS'], { install: 'anytls' }),
    C('NaïveProxy', '基于 Caddy, 需要域名', ['HTTP/2', 'TLS'], { install: 'naive' }),
  ]],
];

function renderInstall(view) {
  const installed = new Set(state.status.protocols.map((p) => p.proto));
  const all = CATALOG.flatMap(([, , items]) => items);
  const ready = all.filter((x) => x.install).length;
  const pickCard = (x, i) => {
    const proto = x.proto || x.install;
    return `<button class="card pick ${x.install ? '' : 'todo'}" data-i="${i}">
      <span class="pick-title">${esc(x.name)}
        ${x.star ? '<span class="badge ok">推荐</span>' : ''}
        ${x.install && installed.has(proto) ? '<span class="badge ok">已安装</span>' : ''}
        ${x.install ? '' : '<span class="badge">待开发</span>'}</span>
      <span class="muted">${esc(x.desc)}</span>
      <span class="tags">${x.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</span>
      ${x.pick ? `<span class="pick-hint">安装时: ${esc(x.pick)}</span>` : ''}
    </button>`;
  };
  view.innerHTML = `
    <p class="muted intro">共 ${all.length} 种主流组合, 其中 ${ready} 种现在就能安装; 灰色的「待开发」是 Xray / Sing-box 官方支持、但脚本还没接入的。
      安装时会按原脚本的步骤询问端口、域名/SNI、证书等, 每一步都可以点选或用默认值。已安装的协议可以再装一个端口实例。</p>
    <div class="toolbar"><label class="muted"><span><input type="checkbox" id="only-ready"> 只看可安装的</span></label></div>
    ${CATALOG.map(([group, , items]) => `<section class="install-group"><h3 class="group">${esc(group)}</h3>
      <div class="grid">${items.map((x) => pickCard(x, all.indexOf(x))).join('')}</div></section>`).join('')}
    `;

  $('#only-ready').onchange = (e) => {
    view.classList.toggle('only-ready', e.target.checked);
    // 整组都是待开发时把组标题也藏起来
    view.querySelectorAll('.install-group').forEach((g) => { g.hidden = e.target.checked && !g.querySelector('.pick:not(.todo)'); });
  };
  view.onclick = (e) => {
    const b = e.target.closest('.pick[data-i]');
    if (!b) return;
    const x = all[Number(b.dataset.i)];
    if (!x.install) return toast(`「${x.name}」还没接入安装流程, 确认保留后再实现`);
    const again = installed.has(x.proto || x.install) ? ' 该协议已安装, 将询问是添加新端口还是重新安装。' : '';
    const pick = x.pick ? ` 安装过程中请${x.pick}。` : '';
    runTask(b, { kind: 'install', protocol: x.install }, `安装 ${x.name}`,
      `会下载核心并生成配置, 整个过程约 1-3 分钟。${pick}${again}`);
  };
}

// ─── 分流 / 系统 ─────────────────────────────────

const IPV = { as_is: '默认', ipv4_only: '仅 IPv4', ipv6_only: '仅 IPv6', prefer_ipv4: '优先 IPv4', prefer_ipv6: '优先 IPv6' };
const WARP_ST = { connected: ['已连接', 'ok'], configured: ['已配置', 'ok'], registered: ['已注册, 未连接', 'warn'], not_configured: ['未配置', ''] };

function fmtOutbound(o) {
  if (!o) return '—';
  if (o.startsWith('chain:')) return `链式节点 <b>${esc(o.slice(6))}</b>`;
  if (o.startsWith('balancer:')) return `负载均衡 <b>${esc(o.slice(9))}</b>`;
  return { direct: '直连', warp: 'WARP', block: '屏蔽' }[o] || esc(o);
}

// 卡片底部的"打开原菜单"按钮: data-task=任务名
const taskBtn = (kind, label, primary) => `<button class="btn ${primary ? 'primary' : ''}" data-task="${kind}">${esc(label)}</button>`;

// 各页面设置自己的提示文字; 点击由下面唯一的全局监听处理 (#view 会被反复渲染, 不能在上面重复绑定)
let taskNotes = {};
function bindTaskButtons(view, notes = {}) { taskNotes = notes; }
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-task]');
  if (!b) return;
  const kind = b.dataset.task;
  runTask(b, { kind }, TASK_TITLES[kind], taskNotes[kind] || '将打开对应的管理菜单, 每一步都可以点选。完成后选「0 返回」退出菜单。');
});

async function renderRouting(view, force) {
  view.innerHTML = '<div class="card muted">加载中…</div>';
  const r = await api('routing' + (force ? '?fresh=1' : ''));
  const [wl, wc] = WARP_ST[r.warp.status] || [r.warp.status, ''];
  view.innerHTML = `
    <div class="card">
      <h3>分流规则 <span class="badge">${r.rules.length}</span></h3>
      ${r.rules.length ? `<div class="table-wrap flat"><table>
        <thead><tr><th>规则</th><th>匹配</th><th>出口</th><th>IP 版本</th><th></th></tr></thead>
        <tbody>${r.rules.map((x) => `<tr>
          <td>${esc(x.type)}${x.id !== x.type ? ` <span class="muted mono">${esc(x.id)}</span>` : ''}</td>
          <td class="wrap mono">${esc(x.domains || '—')}</td>
          <td><span class="out-cell">${fmtOutbound(x.outbound)}${latBtn(x.outbound)}</span></td>
          <td>${esc(IPV[x.ip_version] || x.ip_version)}</td>
          <td><button class="btn sm danger-text" data-del-rule="${esc(x.id)}">删除</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">没有分流规则, 所有流量直连。</p>'}
      <div class="card-actions">${taskBtn('routing-rules', '添加 / 管理规则', true)}
        ${r.rules.some((x) => latTestable(x.outbound)) ? '<button class="btn" id="lat-all">测试全部出口</button>' : ''}</div>
    </div>

    <div class="grid section">
      <div class="card">
        <h3>链式代理节点 <span class="badge">${r.chain.nodes.length}</span></h3>
        ${r.chain.nodes.length ? `<ul class="svc-list">${r.chain.nodes.map((n) => `<li>
          <span class="name"><b>${esc(n.name)}</b> <span class="badge">${esc(n.type)}</span>
            ${n.name === r.chain.active ? '<span class="badge ok">当前</span>' : ''}</span>
          <span class="mono muted">${esc(n.server)}:${esc(n.port)}</span>${latBtn('chain:' + n.name)}</li>`).join('')}</ul>` : '<p class="muted">暂无落地节点</p>'}
        ${r.balancers.length ? `<p class="hint muted">负载均衡组: ${r.balancers.map((g) =>
          `<b>${esc(g.name)}</b> (${esc(g.strategy || '默认')}: ${g.nodes.map(esc).join(', ')})`).join('; ')}</p>` : ''}
        <div class="card-actions">${taskBtn('chain', '添加 / 管理节点', true)}${r.chain.nodes.length ? taskBtn('latency', '测试延迟') : ''}</div>
      </div>
      <div class="card">
        <h3>WARP <span class="badge ${wc}">${esc(wl)}</span></h3>
        <dl class="kv"><dt>模式</dt><dd>${r.warp.mode === 'official' ? '官方客户端 (TCP/SOCKS5)' : 'WGCF (UDP/WireGuard)'}</dd></dl>
        <div class="card-actions">${taskBtn('warp', '管理 WARP', true)}</div>
        <h3 class="section">直连出口</h3>
        <dl class="kv"><dt>IP 版本</dt><dd>${esc(IPV[r.direct_ip_version] || r.direct_ip_version)}</dd></dl>
        <div class="card-actions">${taskBtn('direct', '修改')}</div>
      </div>
      <div class="card">
        <h3>多 IP 入出站 <span class="badge ${r.ip_routing.enabled ? 'ok' : ''}">${r.ip_routing.enabled ? '已启用' : '未启用'}</span></h3>
        ${r.ip_routing.rules.length ? `<ul class="svc-list">${r.ip_routing.rules.map((x) =>
          `<li class="mono">${esc(x.inbound_ip || x.inbound || '')} → ${esc(x.outbound_ip || x.outbound || '')}</li>`).join('')}</ul>`
          : '<p class="muted">多 IP 服务器可以让不同入口 IP 用不同出口 IP。</p>'}
        <div class="card-actions">${taskBtn('ip-routing', '配置')}</div>
      </div>
    </div>
    <p class="hint muted">更多选项 (测试分流效果、WARP 双层链式等) 在 ${taskBtn('routing', '完整分流菜单')} 里。</p>`;

  bindTaskButtons(view, { latency: '会逐个测试所有落地节点的延迟, 需要几十秒。' });
  const all = $('#lat-all');
  if (all) all.onclick = () => [...new Set(r.rules.map((x) => x.outbound).filter(latTestable))].forEach(testLatency);
  view.onclick = async (e) => {
    const t = e.target.closest('[data-lat]');
    if (t) return testLatency(t.dataset.lat);
    const b = e.target.closest('[data-del-rule]');
    if (!b) return;
    if (await confirmBox('删除分流规则', `删除规则 ${b.dataset.delRule} 后, 匹配的流量将改为直连。确定吗?`)) {
      if (await act(b, 'routing/del', { id: b.dataset.delRule }, { reload: false })) renderRouting(view, true);
    }
  };
}

// ─── 出口测速 ──
// 支持 链式节点 / 负载均衡组 / 直连; WARP 和屏蔽不测
const latTestable = (o) => !!o && (o.startsWith('chain:') || o.startsWith('balancer:') || o === 'direct');
const latBtn = (o) => latTestable(o)
  ? ` <button class="btn sm" data-lat="${esc(o)}">测速</button><span class="lat" data-lat-out="${esc(o)}"></span>` : '';

function latBadge(ms, missing) {
  if (missing) return '<span class="badge bad">节点不存在</span>';
  if (ms == null) return '<span class="badge bad">超时</span>';
  return `<span class="badge ${ms < 150 ? 'ok' : ms < 400 ? 'warn' : 'bad'}">${ms} ms</span>`;
}

// 同一出口在页面上可能出现多次 (多条规则共用、节点卡片), 一起更新; 用属性比较而不是拼选择器, 节点名可能含特殊字符
const latEls = (attr, o) => [...document.querySelectorAll(`[${attr}]`)].filter((el) => el.getAttribute(attr) === o);

async function testLatency(o) {
  const btns = latEls('data-lat', o);
  if (btns.some((b) => b.disabled)) return;
  btns.forEach((b) => { b.disabled = true; b.classList.add('busy'); });
  latEls('data-lat-out', o).forEach((el) => { el.innerHTML = '<span class="muted">测速中…</span>'; });
  try {
    const { results } = await api('latency?target=' + encodeURIComponent(o));
    const html = results.length === 1 && !o.startsWith('balancer:')
      ? latBadge(results[0].latency, results[0].missing)
      : results.map((x) => `${esc(x.name)} ${latBadge(x.latency, x.missing)}`).join(' ');
    latEls('data-lat-out', o).forEach((el) => { el.innerHTML = html; el.title = '测于 ' + new Date().toLocaleTimeString(); });
    // 负载均衡组的结果也同步到对应的节点上
    if (o.startsWith('balancer:')) results.forEach((x) => latEls('data-lat-out', 'chain:' + x.name).forEach((el) => { el.innerHTML = latBadge(x.latency); }));
  } catch (e) {
    latEls('data-lat-out', o).forEach((el) => { el.innerHTML = `<span class="error">${esc(e.message)}</span>`; });
  } finally {
    btns.forEach((b) => { if (b.isConnected) { b.disabled = false; b.classList.remove('busy'); } });
  }
}

// 系统页显示的核心, 及各自的"更新/安装"任务
const CORES = {
  xray: { label: 'Xray', task: 'core-xray' },
  'sing-box': { label: 'Sing-box', task: 'core-singbox' },
};

async function renderSystem(view, force) {
  view.innerHTML = '<div class="card muted">加载中…</div>';
  const s = await api('system' + (force ? '?fresh=1' : ''));
  const installed = (v) => v && v !== '未安装' && v !== '未知';
  view.innerHTML = `
    <div class="card">
      <h3>核心版本</h3>
      <div class="table-wrap flat"><table>
        <thead><tr><th>核心</th><th>当前</th><th>最新稳定版</th><th>最新测试版</th><th>状态</th><th></th></tr></thead>
        <tbody>${s.cores.filter((c) => CORES[c.name]).map((c) => {
          const has = installed(c.current);
          const upd = has && c.stable && c.current !== c.stable && !c.current.includes('-');
          return `<tr><td>${esc(CORES[c.name].label)}</td>
            <td>${verBadge(c.current)}</td><td class="mono">${esc(c.stable || '—')}</td><td class="mono muted">${esc(c.prerelease || '—')}</td>
            <td>${upd ? '<span class="badge warn">可更新</span>' : has ? '<span class="badge ok">最新</span>' : '<span class="muted">随协议安装</span>'}</td>
            <td>${taskBtn(CORES[c.name].task, has ? '更新' : '安装', upd).replace('class="btn', 'class="btn sm')}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="card-actions">
        <button class="btn" id="ver-refresh">重新获取版本</button>
      </div>
      <p class="hint muted">更新时可选稳定版、测试版或指定版本, 会短暂重启对应服务。
        Sing-box 只在使用 Hysteria2 / TUIC 时需要, 安装这两个协议时会自动装好, 一般不用单独安装。</p>
    </div>
    <div class="grid section">
      <div class="card">
        <h3>BBR 网络优化 <span class="badge ${s.bbr.enabled ? 'ok' : ''}">${s.bbr.enabled ? '已开启' : '未开启'}</span></h3>
        <dl class="kv"><dt>拥塞控制</dt><dd class="mono">${esc(s.bbr.cc || '—')}</dd>
          <dt>队列算法</dt><dd class="mono">${esc(s.bbr.qdisc || '—')}</dd><dt>内核</dt><dd class="mono">${esc(s.bbr.kernel)}</dd></dl>
        <div class="card-actions">${taskBtn('bbr', s.bbr.enabled ? '重新优化 / 卸载' : '开启 BBR', !s.bbr.enabled)}</div>
      </div>
      <div class="card danger-zone">
        <h3>完全卸载</h3>
        <p class="muted">停止并删除所有协议、配置、证书、订阅和 WARP, 并删除 <code>vless</code> 命令。无法恢复。</p>
        <div class="card-actions"><button class="btn danger" id="uninstall-all">完全卸载…</button></div>
      </div>
    </div>`;

  bindTaskButtons(view, {
    'core-xray': '接下来选择稳定版、测试版或指定版本。更新时会重启 Xray, 所有 Xray 节点会断开几秒。',
    'core-singbox': '接下来选择稳定版、测试版或指定版本; 未安装时会直接安装。Sing-box 只供 Hysteria2 / TUIC 使用。',
    bbr: '会修改内核网络参数 (sysctl), 不需要重启服务器。',
  });
  $('#ver-refresh').onclick = async (e) => { if (await act(e.currentTarget, 'versions/refresh', {}, { reload: false })) renderSystem(view, true); };
  $('#uninstall-all').onclick = () => formBox('完全卸载', [
    { name: 'confirm', label: '输入 UNINSTALL 确认', attrs: 'autocomplete="off" required', hint: '所有节点会立即失效, 订阅链接也会失效。' },
  ], '开始卸载', async (v) => {
    if (v.confirm !== 'UNINSTALL') throw new Error('请输入大写的 UNINSTALL');
    await post('task/start', { kind: 'uninstall-all', confirm: v.confirm });
    location.hash = '#/task';
    return true;
  });
}

// ─── 交互任务 ────────────────────────────────────────────────

const TASK_TITLES = {
  install: '安装协议', uninstall: '卸载协议', 'sub-setup': '配置订阅服务',
  routing: '分流管理', 'routing-rules': '分流规则', chain: '链式代理', warp: 'WARP 管理', 'ip-routing': '多 IP 入出站',
  direct: '直连出口设置', latency: '节点延迟测试', 'core-update': '核心版本管理', bbr: 'BBR 网络优化',
  'core-xray': '更新 Xray', 'core-singbox': '更新 / 安装 Sing-box',
  'uninstall-all': '完全卸载',
};
// 任务结束后的返回入口
const TASK_RETURN = {
  install: ['#/protocols', '查看协议'], uninstall: ['#/protocols', '查看协议'], 'sub-setup': ['#/sub', '返回订阅'],
  'core-update': ['#/system', '返回系统'], bbr: ['#/system', '返回系统'],
  'core-xray': ['#/system', '返回系统'], 'core-singbox': ['#/system', '返回系统'],
  'uninstall-all': ['#/dashboard', '返回仪表盘'],
};

// 日志追加, 并把其中的网址变成可点击链接 (例如证书申请、WARP 等步骤给出的网址)
function appendLog(pre, text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s'"<>]+/g)) {
    frag.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  pre.append(frag);
}
const TASK_STATUS = {
  running: ['执行中', 'warn'], waiting: ['等待你的选择', 'warn'], done: ['已完成', 'ok'],
  failed: ['失败', 'bad'], cancelled: ['已取消', 'bad'],
};

async function runTask(btn, body, title, text) {
  if (!(await confirmBox(title, text, false))) return;
  if (btn) btn.disabled = true;
  try {
    await post('task/start', body);
    location.hash = '#/task';
  } catch (e) {
    toast(e.message, true);
    if (e.message.includes('已有任务')) location.hash = '#/task';
  } finally { if (btn && btn.isConnected) btn.disabled = false; }
}

function stopTimers() {
  clearInterval(renderLogs.timer);
  clearTimeout(renderTask.timer);
}

async function renderTask(view) {
  view.innerHTML = `
    <div class="card task-head" id="task-head"><span class="muted">加载中…</span></div>
    <div class="card task-progress">
      <div class="pbar" id="task-pbar"><i id="task-bar"></i></div>
      <div class="task-now" id="task-now">准备中…</div>
    </div>
    <div id="task-prompt"></div>
    <details class="task-details" id="task-details"><summary>详细日志</summary>
      <pre class="log task-log" id="task-log"></pre></details>`;
  const ui = { since: 0, promptSeq: null, id: null, steps: 0, now: '' };

  const poll = async () => {
    if (!$('#task-log')) return;
    let d;
    try { d = await api('task?since=' + ui.since); } catch (e) { if (e.message === '未登录') return; }
    const t = d && d.task;
    if (!t) {
      $('#task-head').innerHTML = '<span class="muted">当前没有任务。</span> <a href="#/install">去安装协议</a>';
      $('.task-progress').hidden = $('#task-details').hidden = true;
      return;
    }
    $('.task-progress').hidden = $('#task-details').hidden = false;
    if (ui.id !== t.id) {
      Object.assign(ui, { id: t.id, since: 0, steps: 0, now: '' });
      $('#task-log').textContent = '';
      return poll();
    }

    const log = $('#task-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (t.lines.length) appendLog(log, t.lines.join('\n') + '\n');
    for (const raw of t.lines) {
      const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (!line || /^[\s─━═—\-=*#│|+]+$/.test(line)) continue;
      ui.now = line;
      if (/^[▸✓✔→•]/.test(line)) ui.steps++;
    }
    ui.since = t.total;
    if (atBottom) log.scrollTop = log.scrollHeight;

    drawHead(t);
    drawProgress(t);
    if ((t.prompt && t.prompt.seq) !== ui.promptSeq) {
      ui.promptSeq = t.prompt ? t.prompt.seq : null;
      drawPrompt(t.prompt);
    }
    setTaskChip(!t.ended);
    if (!t.ended) renderTask.timer = setTimeout(poll, t.status === 'waiting' ? 1500 : 600);
    else if (t.status === 'done') { state.status = state.links = null; }
  };

  const drawHead = (t) => {
    const [label, cls] = TASK_STATUS[t.status] || [t.status, ''];
    const secs = Math.round(((t.ended || Date.now()) - t.started) / 1000);
    const name = TASK_TITLES[t.kind] + (t.args[0] ? ` · ${t.args[0]}` : '');
    $('#task-head').innerHTML = `
      <div class="task-title"><strong>${esc(name)}</strong> <span class="badge ${cls}">${label}</span>
        <span class="muted">#${t.id} · ${secs}s</span></div>
      <div class="card-actions">${t.ended
        ? (() => {
          const [href, label] = TASK_RETURN[t.kind] || ['#/routing', '返回分流'];
          return `<a class="btn primary" href="${href}">${label}</a>` + (t.kind === 'install' ? ' <a class="btn" href="#/install">继续安装</a>' : '');
        })()
        : '<button class="btn danger-text" id="task-cancel">取消任务</button>'}</div>`;
    const c = $('#task-cancel');
    if (c) c.onclick = async () => {
      if (await confirmBox('取消任务', '会立即终止脚本, 可能留下装了一半的文件 (可再次安装覆盖)。确定吗?')) act(c, 'task/cancel', {}, { reload: false });
    };
  };

  // 脚本没有总步数, 按已完成的步骤和耗时估算进度, 结束前最多到 95%
  const drawProgress = (t) => {
    const secs = ((t.ended || Date.now()) - t.started) / 1000;
    const failed = t.status === 'failed' || t.status === 'cancelled';
    const pct = t.status === 'done' ? 100 : Math.min(95, 100 * (1 - Math.exp(-(ui.steps + secs / 15) / 12)));
    $('#task-bar').style.width = pct.toFixed(1) + '%';
    $('#task-pbar').className = 'pbar' + (t.status === 'done' ? ' ok' : failed ? ' bad' : t.ended ? '' : ' live');
    const now = t.status === 'done' ? '完成'
      : t.status === 'cancelled' ? '已取消'
      : t.status === 'waiting' ? '等待你的选择…'
      : ui.now || '准备中…';
    $('#task-now').textContent = now;
    $('#task-now').className = 'task-now' + (failed ? ' error' : '');
    if (t.status === 'failed' && !ui.opened) { ui.opened = true; $('#task-details').open = true; }
  };

  const drawPrompt = (p) => {
    const box = $('#task-prompt');
    if (!p) { box.innerHTML = ''; return; }
    const text = p.text.replace(/\s*\[[^\]]*\]\s*[:：]?\s*$/, '').replace(/[:：]\s*$/, '') || '脚本在等待输入';
    const opts = p.options.filter((o) => o.text);
    if (p.cont) {
      box.innerHTML = `<form class="card prompt" novalidate>
        <div class="prompt-q">${esc(p.text.replace(/[.。…]+$/, ''))}</div>
        <div class="prompt-opts"><button type="button" class="btn primary" data-ans="">继续</button></div>
        <p class="hint muted">这一步的输出在下方"详细日志"里, 看完后点继续。</p></form>`;
    } else box.innerHTML = `<form class="card prompt" novalidate>
      <div class="prompt-q">${esc(text)}</div>
      ${p.confirm ? `<div class="prompt-opts">
          <button type="button" class="btn ${p.confirm === 'y' ? 'primary' : ''}" data-ans="y">是</button>
          <button type="button" class="btn ${p.confirm === 'n' ? 'primary' : ''}" data-ans="n">否</button></div>` : ''}
      ${opts.length ? `<div class="prompt-opts">${opts.map((o) => `
          <button type="button" class="btn opt ${o.key === p.default ? 'primary' : ''} ${o.key === '0' ? 'muted-opt' : ''}" data-ans="${esc(o.key)}">
            <span class="key">${esc(o.key)}</span>${esc(o.text)}</button>`).join('')}</div>` : ''}
      ${p.confirm ? '' : `<div class="prompt-input">
          <input name="v" type="${p.secret ? 'password' : 'text'}" value="${esc(opts.length ? '' : p.default)}"
            placeholder="${esc(opts.length ? '或手动输入' : p.default ? '回车使用默认值 ' + p.default : '输入内容, 可留空')}" autocomplete="off">
          <button class="btn primary" type="submit">确定</button></div>`}
      <p class="hint muted mono">${esc(p.text)}</p>
    </form>`;
    const form = $('form', box);
    const answer = async (value) => {
      form.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      try {
        await post('task/answer', { seq: p.seq, value });
        clearTimeout(renderTask.timer);
        poll();
      } catch (e) {
        toast(e.message, true);
        form.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
      }
    };
    form.onclick = (e) => { const b = e.target.closest('[data-ans]'); if (b) answer(b.dataset.ans); };
    form.onsubmit = (e) => { e.preventDefault(); answer(form.elements.v ? form.elements.v.value : ''); };
    const first = $('input', form) && !opts.length ? $('input', form) : $('.btn.primary, .btn', form);
    first && first.focus();
  };

  poll();
}

function setTaskChip(active) { $('#task-chip').hidden = !active; }

function renderLogs(view) {
  const targets = [['script', '脚本日志'], ['watchdog', 'Watchdog'],
    ...state.status.services.filter((s) => s.name !== 'vless-watchdog').map((s) => [s.name, s.name])];
  view.innerHTML = `
    <div class="toolbar">
      <select id="log-target" aria-label="日志来源">${targets.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>
      <select id="log-lines" aria-label="行数"><option>100</option><option>300</option><option>1000</option></select>
      <label class="muted"><span><input type="checkbox" id="log-auto"> 每 5 秒自动刷新</span></label>
    </div>
    <pre class="log" id="log-text">加载中…</pre>`;

  const fetchLog = async () => {
    const t = $('#log-target'), l = $('#log-lines');
    if (!t) return stopAuto();
    try {
      const d = await api(`logs?target=${encodeURIComponent(t.value)}&lines=${l.value}`);
      const pre = $('#log-text');
      pre.textContent = d.text || '(空)';
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { $('#log-text').textContent = '读取失败: ' + e.message; }
  };
  const stopAuto = () => { clearInterval(renderLogs.timer); renderLogs.timer = null; };
  $('#log-target').onchange = fetchLog;
  $('#log-lines').onchange = fetchLog;
  $('#log-auto').onchange = (e) => {
    stopAuto();
    if (e.target.checked) renderLogs.timer = setInterval(fetchLog, 5000);
  };
  fetchLog();
}

// ─── 全局点击 ────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) return copy(c.dataset.copy);
  const q = e.target.closest('[data-qr]');
  if (q) return showQr(q.dataset.qr, q.dataset.label);
});
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// ─── 路由 / 登录 ─────────────────────────────────────────────

async function route(force) {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'dashboard';
  const page = pages[name] || pages.dashboard;
  stopTimers();
  if (name !== 'task') api('task').then((d) => setTaskChip(!!(d.task && !d.task.ended))).catch(() => {});
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === name));
  $('#page-title').textContent = page.title;
  const view = $('#view');
  view.onclick = null;
  try {
    await load(force);
    await page.render(view, force);
  } catch (e) {
    if (e.message !== '未登录') view.innerHTML = `<div class="card error">加载失败: ${esc(e.message)}</div>`;
  }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form [name=password]').focus();
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  api('me').then((me) => { $('#mock-badge').hidden = !me.mock; }).catch(() => {});
  route();
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const err = $('#login-error');
  err.hidden = true;
  try {
    await api('login', { method: 'POST', body: JSON.stringify({ username: f.get('username'), password: f.get('password') }) });
    e.target.reset();
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
};

$('#logout').onclick = async () => {
  await api('logout', { method: 'POST' }).catch(() => {});
  state.status = state.links = null;
  showLogin();
};
$('#refresh').onclick = () => route(true).then(() => toast('已刷新'));
window.addEventListener('hashchange', () => route());

(async () => {
  try {
    await api('me');
    showApp();
  } catch { /* 已在 api() 中跳到登录页 */ }
})();
