# vless-panel

给 `vless` 多协议部署脚本加的网页管理面板。

- 第一阶段：仪表盘、协议、用户列表、分享链接/二维码、运行日志
- 第二阶段：服务启停/重启、用户增删、配额/到期/启用/清零、流量同步与定时任务、按月重置、TG 通知、订阅（更新/重置地址/停用）
- 第三阶段：安装协议向导（15 种协议）、卸载协议、启用/重新配置订阅服务
- 第四阶段：分流规则（查看/删除，增改走原菜单）、链式代理与负载均衡、节点延迟、WARP、直连出口、多 IP 入出站、核心版本（查看/刷新/更新）、BBR、完全卸载（需输入 UNINSTALL）

- 新增协议（原脚本没有）：`vless-enc`（VLESS Encryption，ML-KEM-768 后量子 + Vision，无需证书，密钥由 `xray vlessenc` 生成）。
  已接入：配置生成、多用户、分享链接、V2Ray / Clash 订阅、安装与卸载。Surge 不支持，订阅里不会出现。
  引擎里还留着 `vless-grpc` / `trojan-grpc` 的配置代码，但已从安装入口移除（Xray 26 起 gRPC 传输已弃用，改用 XHTTP）。

Reality 真实域名模式的本地回落端口不再写死 8443：如果 8443 已被其他站点占用（比如带 `proxy_protocol` 的自定义 nginx），会自动换一个空闲端口并记录在 `$CFG/reality_https_port`，卸载最后一个 Reality 节点时一并清理。

### 交互任务是怎么工作的

安装、卸载这类流程直接运行原脚本里的函数（`do_install_server` 等），没有另外重写一份。
`engine/webtty.sh` 覆盖了 bash 的 `read`：脚本每次等待键盘输入时，先向 stderr 写一行事件（`\x1e` + JSON），
后端把它和前面输出的菜单行 `N) 文本` 一起解析成"问题 + 选项按钮 / 是否 / 默认值"，用户在网页上点选后，再把答案写回脚本的 stdin。
从文件、here-string、管道读取的 `read` 不受影响。同一时间只能运行一个任务，任务运行期间其他写操作会被拒绝。

注意：流量同步和到期检查的 crontab 会指向 `engine/vless.sh` 的实际路径，部署后不要再移动该目录。

```
install.sh            一键安装 / 升级 / 卸载
engine/vless.sh       改造后的脚本（原菜单不变，新增 --api 模式）
engine/webtty.sh      交互流程桥接（把 read 提示转成网页上的问题）
deploy/               systemd 服务文件、nginx 高级用法模板
server/server.js      Node 后端（鉴权 + 调用引擎 + 静态页面）
server/mock/          本地开发用的假数据、假引擎、模拟交互流程 (run-demo.sh, 经由 WSL bash 运行)
web/                  前端（原生 JS，无需构建）
```

## 本地开发

```bash
cd server && npm install && npm run dev
```

首次启动会在控制台打印账号密码，配置保存在 `server/data/panel.json`。

## 一键安装（Debian / Ubuntu，root）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/chenghaha2018/vless-panel/main/install.sh)
```

运行后先显示菜单：

```
══════════ vless-panel 管理 ══════════
  1) 安装面板 / 升级面板
  2) 卸载面板
  3) 绑定 / 更换域名
  4) 查看访问地址
  5) 重置密码
  6) 重启面板
  0) 退出
```

- **安装**先问后装：① 输入域名（会检查是否已解析到本机；解析不对可以改完 DNS 再输，或回车跳过）→ ② 确认端口（给出一个随机空闲端口，回车采用或自己填）→ ③ 确认后才开始安装
- 自动安装 Node.js、jq，把面板装到 `/opt/vless-panel`，注册为 systemd 服务（开机自启、崩溃自动重启），生成随机访问路径和密码（结束时显示，也保存在 `/root/vless-panel-login.txt`，仅 root 可读）
- **装好后在服务器上输入 `vp` 就能随时打开这个菜单**
- 不绑定域名时，面板只监听本机，用 SSH 隧道访问：`ssh -L 端口:127.0.0.1:端口 root@服务器`，然后打开 `http://127.0.0.1:端口/随机路径/`
- 绑定域名前：把域名 A 记录指向本机（Cloudflare 要关掉小云朵），并在云服务商安全组放行 TCP 80 和面板 HTTPS 端口。绑定后自动安装 nginx 和 acme.sh、申请 Let's Encrypt 证书（自动续期），面板走单独的 HTTPS 端口，443 留给代理协议
- 升级保留配置、密码和域名；卸载不影响已安装的代理协议，可选择是否同时删除配置和证书
- 新服务器不需要先装原来的 `vless` 脚本，协议、证书、订阅都可以在面板里安装

不经菜单、直接执行（适合批量 / 自动化部署）：

```bash
URL=https://raw.githubusercontent.com/chenghaha2018/vless-panel/main/install.sh
bash <(curl -fsSL $URL) --domain panel.example.com [--port 端口]   # 安装并绑定域名
bash <(curl -fsSL $URL) --no-domain                                # 安装, 不绑定域名
bash <(curl -fsSL $URL) --uninstall [--purge]                      # 卸载 (--purge 连配置和证书一起删)
```

暂不支持：Alpine（OpenRC）、CentOS。443 已经被 nginx stream 按 SNI 分流的服务器，参考 [deploy/nginx-vless-panel.conf](deploy/nginx-vless-panel.conf) 手动配置。

## 手动部署

```bash
apt install -y nodejs jq
cp -r vless-panel /opt/                       # node_modules 是纯 JS, 可直接拷贝, 不需要 npm
cd /opt/vless-panel/server
umask 077; node server.js --reset-password > /root/vless-panel-login.txt   # 生成配置和密码
cp ../deploy/vless-panel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now vless-panel
```

配置在 `/etc/vless-panel/panel.json`（端口、随机访问路径、监听地址）。改完执行 `systemctl restart vless-panel`。

用 nginx 加 HTTPS 反代时：
反代后在 `panel.json` 里设置 `"secureCookie": true`（Cookie 只走 HTTPS）和 `"trustProxy": true`（用 nginx 传来的 `X-Real-IP` 识别访问者，
否则所有人都显示为 127.0.0.1，登录失败限流会把所有人一起锁住），然后重启面板。nginx 必须用 `proxy_set_header X-Real-IP` 覆盖这个头。

重置密码（面板只在启动时读取配置，所以要重启）：

```bash
cd /opt/vless-panel/server && node server.js --reset-password > /root/vless-panel-login.txt && systemctl restart vless-panel
```

常用：`systemctl status vless-panel`、`journalctl -u vless-panel -f`（操作日志：谁、从哪个 IP、做了什么）。

## 引擎 API

```bash
bash engine/vless.sh --api status
bash engine/vless.sh --api links
bash engine/vless.sh --api logs <script|watchdog|服务名> [行数]
bash engine/vless.sh --api svc <start|stop|restart> <服务名|all>
bash engine/vless.sh --api user-add <core> <proto> <用户名> [配额GB] [YYYY-MM-DD]
bash engine/vless.sh --api user-del|user-reset <core> <proto> <用户名>   # user-reset all 重置全部
bash engine/vless.sh --api user-quota <core> <proto> <用户名> <GB>
bash engine/vless.sh --api user-enable <core> <proto> <用户名> <true|false>
bash engine/vless.sh --api user-expire <core> <proto> <用户名> <YYYY-MM-DD|never>
bash engine/vless.sh --api traffic-sync | traffic-cron <on|off> [分钟] | monthly-reset <1-28|off>
bash engine/vless.sh --api settings | tg-set '<JSON>' | tg-test
bash engine/vless.sh --api sub-info | sub-update | sub-reset | sub-disable
bash engine/vless.sh --api routing-info | routing-del <规则ID> | system-info | versions-refresh
bash engine/vless.sh --api run install <协议> | run uninstall | run sub-setup   # 交互任务, 由面板驱动
bash engine/vless.sh --api run routing | routing-rules | chain | warp | ip-routing | direct | latency
bash engine/vless.sh --api run tunnel | core-update | bbr | uninstall-all
```

所有写操作在后端串行执行，并打印操作日志（用户、IP、动作、结果）到控制台。
