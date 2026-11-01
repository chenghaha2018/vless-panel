'use strict';
// vless-panel 后端: 鉴权 + 调用 engine/vless.sh --api + 静态页面
// 运行: node server.js            (服务器, 调用真实脚本, 需 root)
//       node server.js --mock     (本地开发, 使用 mock/*.json)
//       node server.js --reset-password

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const QRCode = require('qrcode');

const MOCK = process.argv.includes('--mock') || process.env.PANEL_MODE === 'mock';
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const ENGINE = process.env.PANEL_ENGINE || path.join(ROOT, 'engine', 'vless.sh');
const DATA_DIR = process.env.PANEL_DATA || (MOCK ? path.join(__dirname, 'data') : '/etc/vless-panel');
const CONF_FILE = path.join(DATA_DIR, 'panel.json');

// ─── 配置与密码 ───────────────────────────────────────────────

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}

function newCredentials(conf) {
  const password = crypto.randomBytes(12).toString('base64url');
  conf.salt = crypto.randomBytes(16).toString('hex');
  conf.hash = hashPassword(password, conf.salt);
  return password;
}

function saveConf(conf) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONF_FILE, JSON.stringify(conf, null, 2), { mode: 0o600 });
}

function loadConf() {
  let conf;
  const reset = process.argv.includes('--reset-password');
  try {
    conf = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
  } catch {
    // 首次生成配置; 端口和监听地址可由安装脚本通过环境变量指定
    conf = {
      username: 'admin',
      listen: process.env.PANEL_LISTEN || '127.0.0.1',
      port: Number(process.env.PANEL_PORT) || 54321,
      basePath: MOCK ? '/' : '/' + crypto.randomBytes(6).toString('hex') + '/',
      secureCookie: false,
      trustProxy: false, // 放在 nginx 反代后面时设为 true
      secret: crypto.randomBytes(32).toString('hex'),
    };
    const pw = newCredentials(conf);
    saveConf(conf);
    printLogin(conf, pw, '首次启动, 已生成管理员账号');
    if (reset) process.exit(0); // 刚生成的就是新密码, 不要再重置一次 (否则会打印两个密码)
  }
  if (reset) {
    const pw = newCredentials(conf);
    saveConf(conf);
    printLogin(conf, pw, '密码已重置');
    process.exit(0);
  }
  return conf;
}

function printLogin(conf, pw, title) {
  console.log(`\n  ${title}`);
  console.log(`  地址: http://${conf.listen}:${conf.port}${conf.basePath}`);
  console.log(`  用户名: ${conf.username}`);
  console.log(`  密码:   ${pw}`);
  console.log(`  (配置文件: ${CONF_FILE})\n`);
}

const conf = loadConf();
const BASE = conf.basePath.endsWith('/') ? conf.basePath : conf.basePath + '/';

// ─── 会话 (HMAC 签名的 cookie) ────────────────────────────────

const SESSION_TTL = 12 * 3600 * 1000;
const COOKIE = 'vp_session';

function sign(data) {
  return crypto.createHmac('sha256', conf.secret).update(data).digest('base64url');
}

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL })).toString('base64url');
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=${BASE}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
    (conf.secureCookie ? '; Secure' : '');
}

// 登录失败限流: 每个 IP 10 分钟内最多 5 次
const loginFails = new Map();
function tooManyFails(ip) {
  const rec = loginFails.get(ip);
  return rec && rec.count >= 5 && Date.now() - rec.first < 10 * 60 * 1000;
}
function recordFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() - rec.first > 10 * 60 * 1000) loginFails.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

// ─── 调用引擎 ─────────────────────────────────────────────────

// 动作白名单 → 允许的最多参数个数
const ACTIONS = {
  status: 0, links: 0, logs: 2, settings: 0, 'sub-info': 0,
  svc: 2, 'user-add': 5, 'user-del': 3, 'user-quota': 4, 'user-enable': 4, 'user-expire': 4, 'user-reset': 3,
  'traffic-sync': 0, 'traffic-cron': 2, 'monthly-reset': 1, 'tg-set': 1, 'tg-test': 0,
  'sub-update': 0, 'sub-reset': 0, 'sub-disable': 0,
  'routing-info': 0, 'routing-del': 1, 'system-info': 0, 'versions-refresh': 0, latency: 1,
};
const mockEngine = MOCK ? require('./mock/engine') : null;

function runEngine(action, args = []) {
  if (!(action in ACTIONS) || args.length > ACTIONS[action]) {
    return Promise.reject(new Error('不允许的动作'));
  }
  if (MOCK) return mockEngine(action, args);
  return new Promise((resolve, reject) => {
    execFile('bash', [ENGINE, '--api', action, ...args],
      { timeout: 180000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TERM: 'dumb' } },
      (err, stdout, stderr) => {
        const line = stdout.trim().split('\n').pop() || '';
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error((stderr || (err && err.message) || '引擎无输出').trim().slice(0, 500)));
        }
      });
  });
}

// 写操作串行执行, 避免并发改 db.json
let writeChain = Promise.resolve();
function runWrite(action, args) {
  if (taskActive()) return Promise.resolve({ ok: false, error: '有交互任务正在执行, 请等它结束' });
  const p = writeChain.then(() => runEngine(action, args));
  writeChain = p.catch(() => {});
  return p.finally(() => cache.clear());
}

// ─── 写接口参数校验 (引擎里还会再校验一次) ──────────────────────

class BadRequest extends Error {}
const need = (cond, msg) => { if (!cond) throw new BadRequest(msg); };
const str = (v) => (v === undefined || v === null ? '' : String(v));
const RE = {
  core: /^(xray|singbox)$/, proto: /^[a-z0-9-]{1,32}$/, name: /^[A-Za-z0-9_-]{1,32}$/,
  svc: /^[a-z0-9-]{1,64}$/, int: /^\d{1,6}$/, date: /^\d{4}-\d{2}-\d{2}$/,
};
function userArgs(b) {
  need(RE.core.test(str(b.core)), 'core 参数错误');
  need(RE.proto.test(str(b.proto)), 'proto 参数错误');
  need(RE.name.test(str(b.name)), '用户名只能包含字母、数字、下划线和横线, 最长 32 位');
  return [b.core, b.proto, b.name];
}
function intIn(v, lo, hi, msg) {
  const s = str(v);
  need(RE.int.test(s) && +s >= lo && +s <= hi, msg);
  return s;
}

// 路由 → (请求体) => [引擎动作, 参数]
const WRITES = {
  svc: (b) => {
    need(['start', 'stop', 'restart'].includes(b.action), '动作错误');
    need(b.name === 'all' || RE.svc.test(str(b.name)), '服务名错误');
    return ['svc', [b.action, b.name]];
  },
  'users/add': (b) => {
    const expire = str(b.expire);
    need(!expire || RE.date.test(expire), '到期日期格式应为 YYYY-MM-DD');
    return ['user-add', [...userArgs(b), intIn(b.quota_gb || 0, 0, 1e6, '配额应为 0 或正整数 (GB)'), expire]];
  },
  'users/del': (b) => ['user-del', userArgs(b)],
  'users/quota': (b) => ['user-quota', [...userArgs(b), intIn(b.quota_gb, 0, 1e6, '配额应为 0 或正整数 (GB)')]],
  'users/enable': (b) => {
    need(typeof b.enabled === 'boolean', '状态参数错误');
    return ['user-enable', [...userArgs(b), String(b.enabled)]];
  },
  'users/expire': (b) => {
    const e = str(b.expire) || 'never';
    need(e === 'never' || RE.date.test(e), '日期格式错误');
    return ['user-expire', [...userArgs(b), e]];
  },
  'users/reset': (b) => (b.all === true ? ['user-reset', ['all']] : ['user-reset', userArgs(b)]),
  'traffic/sync': () => ['traffic-sync', []],
  'traffic/cron': (b) => ['traffic-cron', [b.enabled ? 'on' : 'off', intIn(b.interval, 1, 60, '间隔应为 1-60 分钟')]],
  'monthly-reset': (b) => ['monthly-reset', [+b.day === 0 ? 'off' : intIn(b.day, 1, 28, '日期应为 1-28')]],
  tg: (b) => {
    const out = {};
    if (str(b.bot_token)) { need(/^\d+:[A-Za-z0-9_-]+$/.test(b.bot_token), 'Bot Token 格式错误'); out.bot_token = b.bot_token; }
    if ('chat_id' in b) { need(/^-?\d{1,20}$/.test(str(b.chat_id)), 'Chat ID 应为数字'); out.chat_id = str(b.chat_id); }
    for (const k of ['enabled', 'notify_daily']) if (k in b) { need(typeof b[k] === 'boolean', `${k} 参数错误`); out[k] = b[k]; }
    if ('notify_quota_percent' in b) out.notify_quota_percent = +intIn(b.notify_quota_percent, 1, 100, '告警阈值应为 1-100');
    if ('daily_report_hour' in b) out.daily_report_hour = +intIn(b.daily_report_hour, 0, 23, '小时应为 0-23');
    if ('daily_report_minute' in b) out.daily_report_minute = +intIn(b.daily_report_minute, 0, 59, '分钟应为 0-59');
    return ['tg-set', [JSON.stringify(out)]];
  },
  'tg/test': () => ['tg-test', []],
  'sub/update': () => ['sub-update', []],
  'sub/reset': () => ['sub-reset', []],
  'sub/disable': () => ['sub-disable', []],
  'routing/del': (b) => {
    need(/^[A-Za-z0-9_:.-]{1,64}$/.test(str(b.id)), '规则 ID 错误');
    return ['routing-del', [b.id]];
  },
  'versions/refresh': () => ['versions-refresh', []],
};

// ─── 交互式任务: 在后台运行原脚本的菜单流程, 把 read 提示转成网页上的问题 ───────────

const INSTALL_PROTOS = ['vless', 'vless-xhttp', 'vless-vision', 'hy2',
  'ss2022', 'ss-legacy', 'socks', 'snell', 'snell-v5', 'anytls', 'tuic', 'naive', 'vless-enc'];
const TASK_KINDS = {
  install: (b) => { need(INSTALL_PROTOS.includes(b.protocol), '不支持的协议'); return [b.protocol]; },
  uninstall: () => [],
  'sub-setup': () => [],
  // 第四阶段: 直接运行原脚本的管理菜单
  routing: () => [], 'routing-rules': () => [], chain: () => [], warp: () => [], 'ip-routing': () => [],
  direct: () => [], latency: () => [], 'core-update': () => [], bbr: () => [],
  'core-xray': () => [], 'core-singbox': () => [],
  'uninstall-all': (b) => { need(b.confirm === 'UNINSTALL', '请输入 UNINSTALL 确认'); return []; },
};
const MAX_LINES = 5000;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const toWsl = (p) => p.replace(/^([A-Za-z]):/, (_, d) => '/mnt/' + d.toLowerCase()).replace(/\\/g, '/');

let task = null;
let taskSeq = 0;
const taskActive = () => !!(task && !task.ended);

// 从提示前输出的菜单行 "  1) xxx" 中提取选项; 从提示文字中识别 [y/N]、默认值
function buildPrompt(text, secret, pending) {
  const options = [];
  for (const line of pending) {
    const m = line.match(/^\s*([0-9]{1,2}|[a-z])\)\s+(.+?)\s*$/);
    if (m) options.push({ key: m[1], text: m[2] });
  }
  const t = text.trim();
  let confirm = null;
  if (/\[y\/N\]/.test(t)) confirm = 'n';
  else if (/\[Y\/n\]/.test(t)) confirm = 'y';
  let def = '';
  const d = t.match(/\[(?:回车(?:默认|使用)?\s*)?([^\[\]]+?)\]\s*[:：]?\s*$/);
  if (d && !confirm && !/^\d+\s*-\s*\d+$/.test(d[1]) && !/随机|跳过|可选/.test(d[1])) def = d[1].trim();
  // "[1-2，回车默认1]" 这种范围 + 默认值混写的, 只取"默认"后面的值
  const inner = def.match(/默认\s*([^\s,，;；\]]+)\s*$/);
  if (inner) def = inner[1];
  // "按回车继续/返回" 只是暂停, 网页上显示一个"继续"按钮
  const cont = !confirm && !options.length && /按回车|按任意键|press enter/i.test(t);
  return { seq: ++task.promptSeq, text: t, secret, options, confirm, default: def, cont };
}

function pushLine(line) {
  task.lines.push(line);
  task.pending.push(line);
  if (task.pending.length > 60) task.pending.shift();
  if (task.lines.length > MAX_LINES) { task.lines.shift(); task.offset++; }
}

function handleOutput(line) {
  if (line.startsWith('\x1e')) {
    let ev;
    try { ev = JSON.parse(line.slice(1)); } catch { return pushLine(stripAnsi(line.slice(1))); }
    if (ev.type === 'prompt') {
      task.prompt = buildPrompt(stripAnsi(ev.text || ''), !!ev.secret, task.pending);
      task.pending = [];
      task.status = 'waiting';
    } else if (ev.type === 'result') {
      task.results.push(ev);
    }
    return;
  }
  pushLine(stripAnsi(line));
}

function startTask(kind, args, user) {
  need(!taskActive(), '已有任务在运行');
  let argv;
  if (MOCK) {
    const extra = kind === 'uninstall' ? mockEngine.protoList() : args;
    argv = [toWsl(path.join(__dirname, 'mock', 'run-demo.sh')), toWsl(path.join(ROOT, 'engine', 'webtty.sh')), kind, ...extra];
  } else {
    argv = [ENGINE, '--api', 'run', kind, ...args];
  }
  const child = spawn('bash', argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // 独立进程组, 取消时整组结束
    env: { ...process.env, TERM: 'dumb' },
  });
  task = {
    id: ++taskSeq, kind, args, user, status: 'running', started: Date.now(), ended: null, exitCode: null,
    lines: [], offset: 0, pending: [], prompt: null, promptSeq: 0, results: [], child, cancelled: false,
  };
  const t = task;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (task !== t) return;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleOutput(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    stream.on('end', () => { if (buf && task === t) handleOutput(buf); });
  }
  child.stdin.on('error', () => {});
  child.on('error', (e) => { t.lines.push('启动失败: ' + e.message); });
  child.on('close', (code) => {
    t.ended = Date.now();
    t.exitCode = code;
    t.prompt = null;
    t.status = t.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
    cache.clear();
    if (MOCK && t.status === 'done') t.results.forEach((r) => mockEngine.applyResult(r));
    console.log(`[${new Date().toISOString()}] ${user} 任务 #${t.id} ${kind} ${args.join(' ')} → ${t.status} (${code})`);
  });
  console.log(`[${new Date().toISOString()}] ${user} 开始任务 #${t.id} ${kind} ${args.join(' ')}`);
  return t;
}

function answerTask(b) {
  need(taskActive() && task.prompt, '当前没有等待回答的问题');
  need(b.seq === task.prompt.seq, '问题已过期, 请刷新');
  const v = str(b.value);
  need(v.length <= 1024 && !/[\r\n\0]/.test(v), '输入内容无效');
  pushLine(`› ${task.prompt.text} ${task.prompt.secret ? '******' : v}`);
  task.pending = [];
  task.prompt = null;
  task.status = 'running';
  task.child.stdin.write(v + '\n');
}

function cancelTask() {
  need(taskActive(), '没有正在运行的任务');
  task.cancelled = true;
  try {
    if (process.platform !== 'win32') process.kill(-task.child.pid, 'SIGTERM');
    else task.child.kill();
  } catch { task.child.kill(); }
}

function taskView(since) {
  if (!task) return { ok: true, task: null };
  const from = Math.max(since, task.offset);
  return {
    ok: true,
    task: {
      id: task.id, kind: task.kind, args: task.args, status: task.status, started: task.started, ended: task.ended,
      exitCode: task.exitCode, prompt: task.prompt, from, total: task.offset + task.lines.length,
      lines: task.lines.slice(from - task.offset),
    },
  };
}

// status 会探测公网 IP, 做 10 秒缓存
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// ─── HTTP ────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(new Error('JSON 格式错误')); }
    });
  });
}

function serveStatic(res, rel) {
  const file = path.normalize(path.join(WEB_DIR, rel || 'index.html'));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    });
    res.end(data);
  });
}

let latencyRunning = 0;

// 访问者 IP: 开启 trustProxy 且请求来自本机反代时, 用 nginx 传来的 X-Real-IP
// (否则所有人都显示为 127.0.0.1, 一个人输错密码会把所有人一起锁住)
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientIp(req) {
  const peer = req.socket.remoteAddress;
  const real = req.headers['x-real-ip'];
  if (conf.trustProxy && LOCAL.has(peer) && typeof real === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(real)) return real;
  return peer;
}

async function handleApi(req, res, route, url) {
  // 所有 API 请求必须带自定义头, 跨站请求无法伪造 (配合 SameSite=Strict)
  if (req.headers['x-panel'] !== '1') return send(res, 403, { ok: false, error: '缺少请求头' });

  const ip = clientIp(req);

  if (route === 'login' && req.method === 'POST') {
    if (tooManyFails(ip)) return send(res, 429, { ok: false, error: '失败次数过多, 请 10 分钟后再试' });
    const body = await readBody(req);
    const hash = hashPassword(String(body.password || ''), conf.salt);
    const okUser = body.username === conf.username;
    const okPass = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(conf.hash, 'hex'));
    if (!okUser || !okPass) {
      recordFail(ip);
      return send(res, 401, { ok: false, error: '用户名或密码错误' });
    }
    loginFails.delete(ip);
    return send(res, 200, { ok: true, user: conf.username },
      { 'Set-Cookie': sessionCookie(makeToken(conf.username), SESSION_TTL / 1000) });
  }

  const session = verifyToken(parseCookies(req)[COOKIE]);
  if (!session) return send(res, 401, { ok: false, error: '未登录' });

  if (route === 'logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (req.method === 'POST' && route.startsWith('task/')) {
    try {
      const b = await readBody(req);
      if (route === 'task/start') {
        need(b.kind in TASK_KINDS, '未知任务');
        const t = startTask(b.kind, TASK_KINDS[b.kind](b), `${session.u}@${ip}`);
        return send(res, 200, { ok: true, id: t.id });
      }
      if (route === 'task/answer') { answerTask(b); return send(res, 200, { ok: true }); }
      if (route === 'task/cancel') { cancelTask(); return send(res, 200, { ok: true, message: '已取消任务' }); }
    } catch (e) {
      if (e instanceof BadRequest) return send(res, 400, { ok: false, error: e.message });
      throw e;
    }
    return send(res, 404, { ok: false, error: '未知接口' });
  }
  if (req.method === 'POST' && route in WRITES) {
    let action, args;
    try {
      [action, args] = WRITES[route](await readBody(req));
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
    const out = await runWrite(action, args);
    console.log(`[${new Date().toISOString()}] ${session.u}@${ip} ${action} ${args.join(' ')} → ${out.ok ? 'ok' : out.error}`);
    return send(res, out.ok ? 200 : 400, out);
  }
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method Not Allowed' });

  const ttl = url.searchParams.has('fresh') ? 0 : 10000;
  switch (route) {
    case 'me':
      return send(res, 200, { ok: true, user: session.u, mock: MOCK });
    case 'status':
      return send(res, 200, await cached('status', ttl, () => runEngine('status')));
    case 'links':
      return send(res, 200, await cached('links', ttl, () => runEngine('links')));
    case 'logs': {
      const target = url.searchParams.get('target') || 'script';
      const lines = url.searchParams.get('lines') || '100';
      if (!/^[a-z0-9-]{1,64}$/.test(target) || !/^\d{1,4}$/.test(lines)) {
        return send(res, 400, { ok: false, error: '参数错误' });
      }
      return send(res, 200, await runEngine('logs', [target, lines]));
    }
    case 'task':
      return send(res, 200, taskView(Number(url.searchParams.get('since')) || 0));
    case 'settings':
      return send(res, 200, await runEngine('settings'));
    case 'routing':
      return send(res, 200, await cached('routing', ttl, () => runEngine('routing-info')));
    case 'system':
      return send(res, 200, await cached('system', ttl, () => runEngine('system-info')));
    case 'latency': {
      // 每次测速会临时启动一个核心进程, 同时最多 3 个
      const target = url.searchParams.get('target') || '';
      if (!/^[^\r\n\0]{1,128}$/.test(target)) return send(res, 400, { ok: false, error: '参数错误' });
      if (latencyRunning >= 3) return send(res, 429, { ok: false, error: '测速进行中, 请稍候' });
      latencyRunning++;
      try { return send(res, 200, await runEngine('latency', [target])); } finally { latencyRunning--; }
    }
    case 'sub':
      return send(res, 200, await cached('sub', ttl, () => runEngine('sub-info')));
    case 'qr': {
      const text = url.searchParams.get('text') || '';
      if (!text || text.length > 2048) return send(res, 400, 'bad text');
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return send(res, 200, svg, { 'Content-Type': 'image/svg+xml' });
    }
    default:
      return send(res, 404, { ok: false, error: '未知接口' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;

  if (p + '/' === BASE) { res.writeHead(302, { Location: BASE }); return res.end(); }
  if (!p.startsWith(BASE)) return send(res, 404, 'Not Found'); // 隐藏访问路径
  p = p.slice(BASE.length);

  try {
    if (p.startsWith('api/')) return await handleApi(req, res, p.slice(4), url);
    return serveStatic(res, p);
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(conf.port, conf.listen, () => {
  console.log(`vless-panel ${MOCK ? '[mock] ' : ''}监听 http://${conf.listen}:${conf.port}${BASE}`);
});
