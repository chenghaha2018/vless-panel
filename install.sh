#!/usr/bin/env bash
#═══════════════════════════════════════════════════════════════════════════════
#  vless-panel 一键安装 / 升级 / 卸载 (Debian / Ubuntu, 需 root)
#
#  安装或升级:
#    bash <(curl -fsSL https://raw.githubusercontent.com/chenghaha2018/vless-panel/main/install.sh)
#  同时配置 HTTPS 域名访问 (域名需已解析到本机):
#    bash <(curl -fsSL .../install.sh) --domain panel.example.com
#  卸载面板 (不影响已安装的代理协议):
#    bash <(curl -fsSL .../install.sh) --uninstall
#
#  选项:
#    --domain <域名>   用 nginx + Let's Encrypt 证书提供 HTTPS 访问
#    --port <端口>     HTTPS 访问端口, 默认随机 20000-30000 (443 留给代理协议)
#    --email <邮箱>    申请证书用的邮箱 (可选)
#    --uninstall       卸载面板; 加 --purge 同时删除面板配置和证书
#═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="${VLESS_PANEL_REPO:-chenghaha2018/vless-panel}"
BRANCH="${VLESS_PANEL_BRANCH:-main}"
# 测试用: 指向本地已解压的源码目录时不再下载
LOCAL_SRC="${VLESS_PANEL_SRC:-}"

DIR=/opt/vless-panel
DATA=/etc/vless-panel
UNIT=/etc/systemd/system/vless-panel.service
LOGIN=/root/vless-panel-login.txt
STATE="$DATA/install.env"
NGINX_CONF=/etc/nginx/conf.d/vless-panel.conf
WEBROOT=/var/www/html

DOMAIN="" HTTPS_PORT="" EMAIL="" ACTION=install PURGE=false

R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' C=$'\e[36m' B=$'\e[1m' N=$'\e[0m'
info() { echo -e "${C}▸${N} $*"; }
ok()   { echo -e "${G}✓${N} $*"; }
warn() { echo -e "${Y}!${N} $*"; }
die()  { echo -e "${R}✗ $*${N}" >&2; exit 1; }

# 用 bash <(curl ...) 运行时 $0 是一次性管道, 不能再读一遍, 所以帮助文字单独写
usage() {
    cat <<'EOF'
用法: install.sh [选项]
  (无参数)          安装或升级面板, 只监听本机, 通过 SSH 隧道访问
  --domain <域名>   用 nginx + Let's Encrypt 证书提供 HTTPS 访问 (域名需已解析到本机)
  --port <端口>     HTTPS 访问端口, 默认随机 20000-30000 (443 留给代理协议)
  --email <邮箱>    申请证书用的邮箱 (可选)
  --uninstall       卸载面板, 不影响已安装的代理协议; 加 --purge 同时删除配置和证书
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)    DOMAIN="${2:-}"; shift 2 ;;
        --port)      HTTPS_PORT="${2:-}"; shift 2 ;;
        --email)     EMAIL="${2:-}"; shift 2 ;;
        --uninstall) ACTION=uninstall; shift ;;
        --purge)     PURGE=true; shift ;;
        -h|--help)   usage ;;
        *)           die "未知参数: $1 (用 --help 查看用法)" ;;
    esac
done

#─── 检查环境 ───────────────────────────────────────────────────────────────────

[[ $EUID -eq 0 ]] || die "请用 root 运行"
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die "需要 systemd (暂不支持 Alpine / OpenRC)"
command -v apt-get >/dev/null || die "目前只支持 Debian / Ubuntu"
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]] || die "域名格式不正确: $DOMAIN"
[[ -z "$HTTPS_PORT" || ( "$HTTPS_PORT" =~ ^[0-9]+$ && "$HTTPS_PORT" -ge 1 && "$HTTPS_PORT" -le 65535 ) ]] || die "端口不正确: $HTTPS_PORT"

# 端口是否已被监听, 或已写在 nginx 配置里
port_used() {
    ss -tlnu 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0
    [[ -d /etc/nginx ]] && grep -rqE "listen[[:space:]]+([^;[:space:]]*:)?$1([[:space:];]|$)" /etc/nginx 2>/dev/null
}

pick_port() {
    local p
    for _ in $(seq 1 200); do
        p=$((20000 + RANDOM % 10001))
        port_used "$p" || { echo "$p"; return; }
    done
    die "找不到空闲端口"
}

#─── 卸载 ───────────────────────────────────────────────────────────────────────

if [[ "$ACTION" == uninstall ]]; then
    info "停止并删除面板服务..."
    systemctl disable --now vless-panel 2>/dev/null || true
    rm -f "$UNIT"; systemctl daemon-reload
    # 面板里开启的流量同步 / 到期检查定时任务指向 $DIR, 一并移除
    if crontab -l 2>/dev/null | grep -q "$DIR/engine"; then
        # grep -v 过滤后可能一行都不剩 (返回 1), 不能让 pipefail 中断卸载
        { crontab -l | grep -v "$DIR/engine" || true; } | crontab -
        warn "已移除面板创建的定时任务 (流量同步 / 到期检查)"
    fi
    rm -rf "$DIR"
    if [[ -f "$NGINX_CONF" ]]; then
        rm -f "$NGINX_CONF"
        nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
        ok "已删除面板的 nginx 配置"
    fi
    if [[ "$PURGE" == true ]]; then
        [[ -f "$STATE" ]] && . "$STATE" || true
        [[ -n "${PANEL_DOMAIN:-}" && -x /root/.acme.sh/acme.sh ]] && /root/.acme.sh/acme.sh --remove -d "$PANEL_DOMAIN" --ecc >/dev/null 2>&1 || true
        rm -rf "$DATA" "$LOGIN"
        ok "已删除面板配置、证书和登录信息"
    else
        info "面板配置保留在 $DATA (重新安装时沿用原密码); 彻底删除请加 --purge"
    fi
    ok "面板已卸载。已安装的代理协议不受影响, 仍由 xray / sing-box 服务运行。"
    exit 0
fi

#─── 安装依赖 ───────────────────────────────────────────────────────────────────

info "安装依赖 (nodejs jq curl)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs jq curl tar ca-certificates iproute2 cron >/dev/null
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[[ "$node_major" -ge 12 ]] || die "Node.js 版本过低 ($(node -v 2>/dev/null)), 需要 12 以上"
ok "Node.js $(node -v), $(jq --version)"

#─── 下载并安装面板 ─────────────────────────────────────────────────────────────

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [[ -n "$LOCAL_SRC" ]]; then
    info "使用本地源码: $LOCAL_SRC"
    src="$LOCAL_SRC"
else
    [[ "$REPO" == *"__"REPO"__"* ]] && die "安装脚本还没有设置仓库地址 (REPO)"
    info "下载 $REPO ($BRANCH)..."
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar xz -C "$tmp" \
        || die "下载失败, 请检查网络或仓库地址"
    src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)
fi
[[ -f "$src/server/server.js" && -f "$src/engine/vless.sh" && -d "$src/server/node_modules" ]] || die "安装包不完整"

upgrade=false
[[ -d "$DIR" ]] && upgrade=true
rm -rf "$DIR.new"
cp -a "$src" "$DIR.new"
rm -rf "$DIR.new/server/data" "$DIR.new/.git"
chmod +x "$DIR.new"/engine/*.sh "$DIR.new/install.sh" 2>/dev/null || true
[[ -d "$DIR" ]] && { rm -rf "$DIR.old"; mv "$DIR" "$DIR.old"; }
mv "$DIR.new" "$DIR"
ok "面板文件已$([[ $upgrade == true ]] && echo 更新 || echo 安装)到 $DIR"

# 首次安装: 生成配置和密码 (面板端口随机 20000-30000, 只监听本机)
first=false
if [[ ! -f "$DATA/panel.json" ]]; then
    first=true
    panel_port=$(pick_port)
    (umask 077; PANEL_DATA="$DATA" PANEL_PORT="$panel_port" node "$DIR/server/server.js" --reset-password > "$LOGIN")
    ok "已生成管理员账号 (保存在 $LOGIN, 仅 root 可读)"
fi
panel_port=$(jq -r .port "$DATA/panel.json")
base_path=$(jq -r .basePath "$DATA/panel.json")

#─── systemd 服务 ───────────────────────────────────────────────────────────────

install -m 644 "$DIR/deploy/vless-panel.service" "$UNIT"
systemctl daemon-reload
systemctl enable vless-panel >/dev/null 2>&1
systemctl restart vless-panel
for _ in $(seq 1 20); do
    ss -tln | grep -q "127.0.0.1:$panel_port " && break
    sleep 0.5
done
if ! ss -tln | grep -q "127.0.0.1:$panel_port "; then
    journalctl -u vless-panel -n 20 --no-pager >&2 || true
    if [[ -d "$DIR.old" ]]; then
        warn "新版本启动失败, 回滚到旧版本"
        rm -rf "$DIR"; mv "$DIR.old" "$DIR"; systemctl restart vless-panel
    fi
    die "面板启动失败"
fi
rm -rf "$DIR.old"
ok "面板服务已启动 (开机自启, 崩溃自动重启)"

#─── HTTPS (可选) ───────────────────────────────────────────────────────────────

# 升级时沿用上次的域名配置
[[ -f "$STATE" ]] && . "$STATE"
[[ -z "$DOMAIN" ]] && DOMAIN="${PANEL_DOMAIN:-}"
[[ -z "$HTTPS_PORT" ]] && HTTPS_PORT="${PANEL_HTTPS_PORT:-}"

setup_https() {
    local ip resolved
    ip=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
    resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')
    if [[ -n "$ip" && "$resolved" != "$ip" ]]; then
        die "域名 $DOMAIN 解析到 ${resolved:-无}, 不是本机 $ip。请先把域名 A 记录指向本机 (如用 Cloudflare 请关闭小云朵)"
    fi

    if ! command -v nginx >/dev/null; then
        info "安装 nginx..."
        apt-get install -y -qq nginx >/dev/null
        systemctl enable --now nginx >/dev/null 2>&1
    fi
    if ss -tlnp 2>/dev/null | grep -E '[:.]80[[:space:]]' | grep -qv nginx; then
        die "80 端口被非 nginx 程序占用, 无法申请证书"
    fi
    [[ -z "$HTTPS_PORT" ]] && HTTPS_PORT=$(pick_port)
    if [[ ! -f "$NGINX_CONF" ]] && port_used "$HTTPS_PORT"; then
        die "端口 $HTTPS_PORT 已被占用, 换一个: --port <端口>"
    fi

    # 先只放 80 端口的验证配置, 拿到证书后再写 HTTPS
    mkdir -p "$WEBROOT/.well-known/acme-challenge"
    cat > "$NGINX_CONF" <<EOF
# vless-panel: $DOMAIN 证书续期验证
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 404; }
}
EOF
    nginx -t >/dev/null 2>&1 || { rm -f "$NGINX_CONF"; die "nginx 配置检查失败"; }
    systemctl reload nginx

    if [[ ! -x /root/.acme.sh/acme.sh ]]; then
        info "安装 acme.sh..."
        curl -fsSL https://get.acme.sh | sh -s email="${EMAIL:-admin@$DOMAIN}" >/dev/null 2>&1 \
            || die "acme.sh 安装失败"
    fi
    local acme=/root/.acme.sh/acme.sh rc=0
    info "申请证书 ($DOMAIN)..."
    "$acme" --issue -d "$DOMAIN" -w "$WEBROOT" --keylength ec-256 --server letsencrypt >"$tmp/acme.log" 2>&1 || rc=$?
    # rc=2 表示证书还没到续期时间, 沿用现有证书
    if [[ $rc -ne 0 && $rc -ne 2 ]]; then
        tail -n 15 "$tmp/acme.log" >&2
        die "证书申请失败 (常见原因: 域名未解析到本机、云厂商防火墙没放行 80 端口)"
    fi
    install -d -m 700 "$DATA/certs"
    "$acme" --install-cert -d "$DOMAIN" --ecc \
        --fullchain-file "$DATA/certs/fullchain.pem" --key-file "$DATA/certs/key.pem" \
        --reloadcmd "nginx -t && systemctl reload nginx" >/dev/null 2>&1 || die "证书安装失败"
    ok "证书已签发, 到期前会自动续期"

    cat > "$NGINX_CONF" <<EOF
# vless-panel 网页面板: https://$DOMAIN:$HTTPS_PORT -> 127.0.0.1:$panel_port
# 由 install.sh 生成; 重新运行安装脚本会覆盖
server {
    listen $HTTPS_PORT ssl http2;
    listen [::]:$HTTPS_PORT ssl http2;
    server_name $DOMAIN;

    ssl_certificate     $DATA/certs/fullchain.pem;
    ssl_certificate_key $DATA/certs/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 1m;
    access_log /var/log/nginx/vless-panel.access.log;
    error_log  /var/log/nginx/vless-panel.error.log warn;

    location / {
        proxy_pass http://127.0.0.1:$panel_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
    }
}

# 80 端口: 证书续期验证, 其他请求转到 HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host:$HTTPS_PORT\$request_uri; }
}
EOF
    if ! nginx -t >/dev/null 2>&1; then
        nginx -t >&2 || true
        rm -f "$NGINX_CONF"; systemctl reload nginx || true
        die "nginx 配置检查失败, 已撤销"
    fi
    systemctl reload nginx

    # 面板在反代后面: 用 nginx 传来的真实 IP 做登录限流, Cookie 只走 HTTPS
    jq '.secureCookie = true | .trustProxy = true' "$DATA/panel.json" > "$tmp/pc" && cat "$tmp/pc" > "$DATA/panel.json"
    systemctl restart vless-panel

    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow "$HTTPS_PORT/tcp" >/dev/null && ufw allow 80/tcp >/dev/null && ok "已在 ufw 放行 80 和 $HTTPS_PORT 端口"
    fi
    printf 'PANEL_DOMAIN=%s\nPANEL_HTTPS_PORT=%s\n' "$DOMAIN" "$HTTPS_PORT" > "$STATE"
    ok "HTTPS 已配置"
}

[[ -n "$DOMAIN" ]] && setup_https

#─── 结果 ───────────────────────────────────────────────────────────────────────

ipv4=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "服务器IP")
echo
echo "${B}════════════════════════════════════════════════════${N}"
echo "${B}  vless-panel $([[ $upgrade == true ]] && echo 升级 || echo 安装)完成${N}"
echo "${B}════════════════════════════════════════════════════${N}"
if [[ -n "$DOMAIN" ]]; then
    echo "  访问地址: ${G}https://$DOMAIN:$HTTPS_PORT$base_path${N}"
    echo "  ${Y}云服务器请在安全组 / 防火墙放行 TCP 80 和 $HTTPS_PORT${N}"
else
    echo "  面板只监听本机, 在你自己电脑上开 SSH 隧道后访问:"
    echo "    ssh -L $panel_port:127.0.0.1:$panel_port root@$ipv4"
    echo "    浏览器打开 ${G}http://127.0.0.1:$panel_port$base_path${N}"
    echo "  想用域名 HTTPS 访问: 重新运行本脚本并加 --domain 你的域名"
fi
echo "  用户名:   admin"
if [[ "$first" == true ]]; then
    echo "  密码:     ${G}$(sed -n 's/^ *密码: *//p' "$LOGIN" | head -1)${N}"
    echo "  (登录信息也保存在 $LOGIN)"
else
    echo "  密码:     未改变。忘记了可以重置:"
    echo "    cd $DIR/server && node server.js --reset-password > $LOGIN && systemctl restart vless-panel"
fi
echo
echo "  升级: 重新运行同一条安装命令    卸载: 加 --uninstall"
echo "${B}════════════════════════════════════════════════════${N}"
