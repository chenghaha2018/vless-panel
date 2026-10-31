'use strict';
// 本地开发用的假引擎: 行为对齐 engine/vless.sh --api, 状态只保存在内存里

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const status = read('status.json');
const links = read('links.json');
const settings = {
  ok: true,
  tg: { enabled: false, bot_token_set: false, bot_token_hint: '', chat_id: '', notify_quota_percent: 80,
    notify_daily: false, daily_report_hour: 9, daily_report_minute: 0 },
  traffic: { cron: true, interval: 5 },
  monthly_reset: { day: 0 },
};
let sub = { ok: true, enabled: true, port: '8443', domain: '', https: true, uuid: crypto.randomUUID() };
const routing = {
  ok: true,
  rules: [
    { id: 'netflix', type: 'netflix', outbound: 'chain:sg', domains: 'geosite:netflix', ip_version: 'as_is' },
    { id: 'ai-intl', type: 'ai-intl', outbound: 'chain:sg', domains: 'geosite:category-ai-!cn', ip_version: 'as_is' },
    { id: 'custom-1', type: 'custom', outbound: 'balancer:asia', domains: 'example.com,example.org', ip_version: 'prefer_ipv4' },
  ],
  chain: { active: 'sg', nodes: [
    { name: 'sg', type: 'shadowsocks', server: '198.51.100.7', port: 8633 },
    { name: 'jp-1', type: 'socks', server: '198.51.100.20', port: 1080 },
  ] },
  balancers: [{ name: 'asia', strategy: 'leastPing', nodes: ['sg', 'jp-1'] }],
  warp: { mode: 'wgcf', status: 'configured' },
  direct_ip_version: 'as_is',
  ip_routing: { enabled: false, rules: [] },
};
const system = {
  ok: true, version: '1.0',
  cores: [
    { name: 'xray', current: '26.2.6', stable: '26.3.27', prerelease: '26.4.1-beta' },
    { name: 'sing-box', current: '未安装', stable: '1.14.4', prerelease: '1.15.0-alpha.13' },
  ],
  bbr: { enabled: true, cc: 'bbr', qdisc: 'fq', kernel: '6.1.0-28-amd64' },
  tunnel: { installed: false, version: '未安装', status: '未安装', name: '', hostname: '' },
};

const ok = (message) => ({ ok: true, message });
const err = (error) => ({ ok: false, error });
const GB = 1073741824;

function findProto(core, proto) {
  return status.protocols.find((p) => p.core === core && p.proto === proto);
}
function findUser(core, proto, name) {
  const p = findProto(core, proto);
  if (!p) return [null, err(`协议 ${proto} 不存在`)];
  for (const inst of p.instances) {
    const u = inst.users.find((x) => x.name === name);
    if (u) return [u, null, p, inst];
  }
  return [null, err(`用户 ${name} 不存在`)];
}

function subInfo() {
  if (!sub.enabled) return { ok: true, enabled: false };
  const base = `${sub.https ? 'https' : 'http'}://${sub.domain || status.system.ipv4}:${sub.port}/sub/${sub.uuid}`;
  return { ok: true, enabled: true, port: sub.port, domain: sub.domain, https: sub.https,
    urls: { clash: base + '/clash', surge: base + '/surge', v2ray: base + '/v2ray' } };
}

const handlers = {
  status: () => status,
  links: () => links,
  logs: ([target]) => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    return { ok: true, text: Array.from({ length: 20 }, (_, i) => `[${now}] [INFO] (mock) ${target} 日志第 ${i + 1} 行`).join('\n') };
  },
  svc: ([action, name]) => {
    const list = name === 'all' ? status.services : status.services.filter((s) => s.name === name);
    if (!list.length) return err(`未知服务: ${name}`);
    for (const s of list) s.active = action !== 'stop';
    return ok(`${name === 'all' ? '所有服务' : name} 已执行 ${action}`);
  },
  'user-add': ([core, proto, name, quota, expire]) => {
    const p = findProto(core, proto);
    if (!p) return err(`协议 ${proto} 不存在`);
    if (['snell', 'snell-v5', 'anytls', 'naive'].includes(proto)) return err('独立协议不支持多用户');
    if (p.instances.some((i) => i.users.some((u) => u.name.toLowerCase() === name.toLowerCase()))) return err(`用户 ${name} 已存在`);
    p.instances[0].users.push({ name, used: 0, quota: Number(quota) * GB, enabled: true, expire_date: expire || '', routing: '' });
    links.user_links.push({ proto, user: name,
      link: `${proto === 'hy2' ? 'hysteria2' : 'vless'}://${crypto.randomUUID()}@${status.system.ipv4}:${p.instances[0].port}?security=reality#US-${name}` });
    return ok(`用户 ${name} 已添加`);
  },
  'user-del': ([core, proto, name]) => {
    const [u, e, , inst] = findUser(core, proto, name);
    if (!u) return e;
    inst.users.splice(inst.users.indexOf(u), 1);
    links.user_links = links.user_links.filter((l) => !(l.proto === proto && l.user === name));
    return ok(`用户 ${name} 已删除`);
  },
  'user-quota': ([core, proto, name, gb]) => {
    const [u, e] = findUser(core, proto, name);
    if (!u) return e;
    u.quota = Number(gb) * GB;
    return ok(`配额已设置为 ${gb} GB`);
  },
  'user-enable': ([core, proto, name, en]) => {
    const [u, e] = findUser(core, proto, name);
    if (!u) return e;
    u.enabled = en === 'true';
    return ok(`用户 ${name} 已${u.enabled ? '启用' : '禁用'}`);
  },
  'user-expire': ([core, proto, name, exp]) => {
    const [u, e] = findUser(core, proto, name);
    if (!u) return e;
    u.expire_date = exp === 'never' ? '' : exp;
    if ((exp === 'never' || exp > new Date().toISOString().slice(0, 10)) && !u.enabled && !(u.quota && u.used >= u.quota)) u.enabled = true;
    return ok('到期日期已更新');
  },
  'user-reset': ([core, proto, name]) => {
    if (core === 'all') {
      let n = 0;
      for (const p of status.protocols) for (const i of p.instances) for (const u of i.users) { u.used = 0; n++; }
      return ok(`已重置 ${n} 个用户的流量`);
    }
    const [u, e] = findUser(core, proto, name);
    if (!u) return e;
    u.used = 0;
    return ok(`用户 ${name} 流量已清零`);
  },
  'traffic-sync': () => ok('流量已同步'),
  'traffic-cron': ([mode, interval]) => {
    settings.traffic = { cron: mode === 'on', interval: Number(interval) };
    return ok(mode === 'on' ? `已启用流量自动同步 (每 ${interval} 分钟)` : '已停用流量自动同步');
  },
  'monthly-reset': ([day]) => {
    settings.monthly_reset.day = day === 'off' ? 0 : Number(day);
    return ok(day === 'off' ? '已停用按月重置' : `每月 ${day} 日自动重置流量`);
  },
  settings: () => settings,
  'tg-set': ([json]) => {
    const v = JSON.parse(json);
    if ('bot_token' in v) {
      settings.tg.bot_token_set = true;
      settings.tg.bot_token_hint = v.bot_token.slice(0, 4) + '…' + v.bot_token.slice(-4);
      delete v.bot_token;
    }
    Object.assign(settings.tg, v);
    return ok('通知设置已保存');
  },
  'tg-test': () => (settings.tg.bot_token_set && settings.tg.chat_id ? ok('测试消息已发送 (mock)') : err('请先设置 Bot Token 和 Chat ID')),
  'sub-info': () => subInfo(),
  'sub-update': () => (sub.enabled ? ok('订阅内容已更新') : err('订阅服务未启用')),
  'sub-reset': () => { if (!sub.enabled) return err('订阅服务未启用'); sub.uuid = crypto.randomUUID(); return ok('订阅地址已重置, 请在客户端更新链接'); },
  'sub-disable': () => { if (!sub.enabled) return err('订阅服务未启用'); sub = { ...sub, enabled: false }; return ok('订阅服务已停用'); },
  'routing-info': () => routing,
  'routing-del': ([id]) => {
    if (!routing.rules.some((r) => r.id === id)) return err('规则不存在');
    routing.rules = routing.rules.filter((r) => r.id !== id);
    return ok(`规则 ${id} 已删除`);
  },
  'system-info': () => system,
  'versions-refresh': () => ok('版本信息已刷新'),
  latency: ([target]) => {
    const fake = (name) => ({ name, latency: name === 'jp-1' ? null : 30 + Math.floor(Math.random() * 120), ip: '198.51.100.7' });
    if (target === 'direct') return { ok: true, results: [{ name: '直连', latency: 12 }] };
    if (target.startsWith('balancer:')) {
      const g = routing.balancers.find((b) => b.name === target.slice(9));
      return g ? { ok: true, results: g.nodes.map(fake) } : err('找不到出口');
    }
    const name = target.replace(/^chain:/, '');
    return routing.chain.nodes.some((n) => n.name === name) ? { ok: true, results: [fake(name)] } : err(`找不到出口: ${target}`);
  },
};

module.exports = async function mockEngine(action, args) {
  await new Promise((r) => setTimeout(r, action === 'latency' ? 1500 : 300)); // 模拟脚本耗时
  // 返回深拷贝, 防止调用方修改内部状态
  return JSON.parse(JSON.stringify(handlers[action](args)));
};

const NAMES = {
  vless: 'VLESS-REALITY', 'vless-xhttp': 'VLESS-XHTTP', 'vless-ws': 'VLESS-WS-TLS', 'vmess-ws': 'VMess-WS',
  'vless-vision': 'VLESS-Vision', trojan: 'Trojan', hy2: 'Hysteria2', ss2022: 'SS2022', 'ss-legacy': 'Shadowsocks',
  socks: 'SOCKS5', snell: 'Snell', 'snell-v5': 'Snell v5', anytls: 'AnyTLS', tuic: 'TUIC', naive: 'NaïveProxy',
  'vless-grpc': 'VLESS-gRPC', 'trojan-grpc': 'Trojan-gRPC', 'vless-enc': 'VLESS-Encryption',
};
const SINGBOX = ['hy2', 'tuic', 'snell', 'snell-v5', 'anytls', 'naive'];

// 卸载菜单需要的已装协议列表 "proto:名称"
module.exports.protoList = () => status.protocols.map((p) => `${p.proto}:${p.name}`);

// 演示流程结束后, 按 result 事件更新内存状态
module.exports.applyResult = (r) => {
  if (r.kind === 'install') {
    const inst = { port: r.port, sni: r.sni || '', domain: '', users: [{ name: 'default', used: 0, quota: 0, enabled: true, expire_date: '', routing: '' }] };
    const p = status.protocols.find((x) => x.proto === r.proto);
    if (p) p.instances.push(inst);
    else status.protocols.push({ core: SINGBOX.includes(r.proto) ? 'singbox' : 'xray', proto: r.proto, name: NAMES[r.proto] || r.proto, instances: [inst] });
    links.links.push(`${r.proto}://11111111-2222-4333-8444-555555555555@${status.system.ipv4}:${r.port}?sni=${r.sni || ''}#US-${NAMES[r.proto] || r.proto}`);
  } else if (r.kind === 'uninstall') {
    status.protocols = status.protocols.filter((p) => p.proto !== r.proto);
  } else if (r.kind === 'sub-setup') {
    sub = { ...sub, enabled: true, port: r.port, domain: r.domain, https: r.https, uuid: crypto.randomUUID() };
  }
};
