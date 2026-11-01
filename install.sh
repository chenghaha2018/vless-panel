#!/usr/bin/env bash
#═══════════════════════════════════════════════════════════════════════════════
#  vless-panel 一键安装 / 管理脚本 (Debian / Ubuntu, 需 root)
#
#  bash <(curl -fsSL https://raw.githubusercontent.com/chenghaha2018/vless-panel/main/install.sh)
#
#  运行后显示菜单: 安装/升级、卸载、绑定域名、查看访问地址、重置密码、重启。
#  安装完成后, 在服务器上输入 vp 即可随时打开这个菜单。
#
#  不经菜单 (自动化部署):
#    --domain <域名> [--port <端口>]   安装并绑定域名
#    --no-domain                      安装, 不绑定域名
#    --uninstall [--purge]            卸载 (--purge 同时删除配置和证书)
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
SHORTCUT=/usr/local/bin/vp

DOMAIN="" HTTPS_PORT="" PANEL_PORT_WANT="" EMAIL="" ACTION="" PURGE=false ASK_DOMAIN=yes

R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' C=$'\e[36m' B=$'\e[1m' D=$'\e[2m' N=$'\e[0m'
info() { echo -e "${C}▸${N} $*"; }
ok()   { echo -e "${G}✓${N} $*"; }
warn() { echo -e "${Y}!${N} $*"; }
die()  { echo -e "${R}✗ $*${N}" >&2; exit 1; }

# 用 bash <(curl ...) 运行时 $0 是一次性管道, 不能再读一遍, 所以帮助文字单独写
usage() {
    cat <<'EOF'
用法: install.sh [选项]          (不带选项: 显示菜单; 安装后可用 vp 打开)
  --domain <域名>   安装并绑定域名: nginx + Let's Encrypt 证书提供 HTTPS 访问
  --port <端口>     绑定域名时的 HTTPS 端口, 默认随机 20000-30000 (443 留给代理协议)
  --no-domain       安装, 不绑定域名 (面板只监听本机, 通过 SSH 隧道访问)
  --email <邮箱>    申请证书用的邮箱 (可选)
  --uninstall       卸载面板, 不影响已安装的代理协议; 加 --purge 同时删除配置和证书
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)    DOMAIN="${2:-}"; ACTION=install; shift 2 ;;
        --port)      HTTPS_PORT="${2:-}"; shift 2 ;;
        --email)     EMAIL="${2:-}"; shift 2 ;;
        --no-domain) ASK_DOMAIN=no; ACTION=install; shift ;;
        --install)   ACTION=install; shift ;;
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
DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "域名格式不正确: $DOMAIN"
[[ -z "$HTTPS_PORT" || ( "$HTTPS_PORT" =~ ^[0-9]+$ && "$HTTPS_PORT" -ge 1 && "$HTTPS_PORT" -le 65535 ) ]] || die "端口不正确: $HTTPS_PORT"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

#─── 通用工具 ───────────────────────────────────────────────────────────────────

# 是否有终端可以交互 (bash <(curl ...) 和 vp 都有; 放在自动化脚本里运行时没有)
has_tty() { { : < /dev/tty; } 2>/dev/null; }

# 从终端读一行: ask "提示" 变量名
ask() { local __v=""; read -rp "$1" __v < /dev/tty || true; printf -v "$2" '%s' "$__v"; }

# 是否回答"是": confirm "提示" y|n(默认)
confirm() {
    local a hint="[Y/n]"; [[ "${2:-y}" == n ]] && hint="[y/N]"
    ask "$1 $hint: " a
    a="${a:-${2:-y}}"
    [[ "$a" =~ ^[yY] ]]
}

installed() { [[ -f "$UNIT" && -d "$DIR" ]]; }

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

valid_port() { [[ "$1" =~ ^[0-9]+$ && "$1" -ge 1 && "$1" -le 65535 ]]; }
valid_domain() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; }

PUBLIC_IP=""
public_ip() {
    [[ -z "$PUBLIC_IP" ]] && PUBLIC_IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
    echo "$PUBLIC_IP"
}

# 域名的 A 记录 (每行一个)。先查 Cloudflare 公共 DNS, 避免本机解析缓存刚改完的旧记录;
# 不依赖 jq, 安装依赖之前也能用
resolve_v4() {
    local ips
    ips=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' \
        "https://cloudflare-dns.com/dns-query?name=$1&type=A" 2>/dev/null \
        | grep -oE '"type":1,[^}]*"data":"[0-9.]+"' | grep -oE '[0-9]+(\.[0-9]+){3}' || true)
    [[ -z "$ips" ]] && ips=$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u || true)
    echo "$ips"
}

# 域名是否解析到本机 (任意一条 A 记录等于本机公网 IP 即可; 查不到本机 IP 时不拦)
dns_points_here() {
    local ip; ip=$(public_ip)
    [[ -z "$ip" ]] && return 0
    resolve_v4 "$1" | grep -qx "$ip"
}

load_state() {
    PANEL_DOMAIN="" PANEL_HTTPS_PORT="" PANEL_WEB=""
    [[ -f "$STATE" ]] && . "$STATE"
    return 0
}

CADDYFILE=/etc/caddy/Caddyfile
# 本机是否已由 Caddy 占用 80/443 (这种机器上由 Caddy 反代面板、自动申请证书, 不另装 nginx)
caddy_owns_web() {
    systemctl is-active --quiet caddy 2>/dev/null && [[ -f "$CADDYFILE" ]] \
        && ss -tlnp 2>/dev/null | grep -E '[:.](80|443)[[:space:]]' | grep -q caddy
}

# 访问地址里的端口: 443 不写
url_port() { [[ "$1" == 443 ]] && echo "" || echo ":$1"; }

#─── 交互: 域名 / 端口 ──────────────────────────────────────────────────────────

# 询问域名; 解析不对时可以改完 DNS 再输, 或回车跳过。结果写入 DOMAIN
ask_domain() {
    local input ips
    echo
    echo "${B}① 绑定域名 (可选)${N}"
    echo "  绑定后直接用 https://域名:端口 打开面板, 不用 SSH 隧道; 证书自动申请、自动续期。"
    echo "  请先把域名的 A 记录指向本机 ${G}$(public_ip | sed 's/^$/本机公网IP/')${N} (Cloudflare 要关闭小云朵代理),"
    echo "  并在云服务商安全组放行 TCP 80 和面板 HTTPS 端口。"
    while true; do
        ask "  输入域名 (回车跳过, 不绑定): " input
        input=$(printf '%s' "$input" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
        input="${input#http://}"; input="${input#https://}"; input="${input%%/*}"; input="${input%%:*}"
        if [[ -z "$input" ]]; then
            DOMAIN=""
            echo "  ${D}不绑定域名, 面板只监听本机, 通过 SSH 隧道访问${N}"
            return 0
        fi
        if ! valid_domain "$input"; then
            warn "域名格式不对, 例如 panel.example.com"
            continue
        fi
        if ! dns_points_here "$input"; then
            ips=$(resolve_v4 "$input" | paste -sd, -)
            warn "$input 现在解析到 ${ips:-（没有 A 记录）}, 不是本机 $(public_ip)"
            warn "改好 DNS 后通常几分钟内生效, 可以稍后重新输入; 或回车跳过"
            continue
        fi
        ok "$input 已解析到本机"
        DOMAIN="$input"
        return 0
    done
}

# 询问端口: ask_port "说明" 变量名 [默认值]  (默认值为空时随机挑一个空闲端口)
ask_port() {
    local label="$1" var="$2" def="${3:-}" input
    [[ -z "$def" ]] && def=$(pick_port)
    while true; do
        ask "  $label [回车使用 $def]: " input
        input=$(printf '%s' "$input" | tr -d '[:space:]')
        input="${input:-$def}"
        if ! valid_port "$input"; then
            warn "端口应为 1-65535 的数字"
        elif [[ "$input" != "$def" ]] && port_used "$input"; then
            warn "端口 $input 已被占用, 换一个"
        else
            printf -v "$var" '%s' "$input"
            return 0
        fi
    done
}

#─── 卸载 ───────────────────────────────────────────────────────────────────────

do_uninstall() {
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
    [[ -f "$SHORTCUT" ]] && grep -q "$DIR/install.sh" "$SHORTCUT" 2>/dev/null && rm -f "$SHORTCUT"
    caddy_remove_block && ok "已删除 Caddy 里的面板站点"
    if [[ -f "$NGINX_CONF" ]]; then
        rm -f "$NGINX_CONF"
        nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
        ok "已删除面板的 nginx 配置"
    fi
    if [[ "$PURGE" == true ]]; then
        load_state
        [[ -n "$PANEL_DOMAIN" && -x /root/.acme.sh/acme.sh ]] && /root/.acme.sh/acme.sh --remove -d "$PANEL_DOMAIN" --ecc >/dev/null 2>&1 || true
        rm -rf "$DATA" "$LOGIN"
        ok "已删除面板配置、证书和登录信息"
    else
        info "面板配置保留在 $DATA (重新安装时沿用原密码); 彻底删除请加 --purge"
    fi
    ok "面板已卸载。已安装的代理协议不受影响, 仍由 xray / sing-box 服务运行。"
}

#─── HTTPS ──────────────────────────────────────────────────────────────────────

CADDY_BEGIN="# >>> vless-panel (由 vless-panel install.sh 管理, 卸载面板时自动删除)"
CADDY_END="# <<< vless-panel"

# 从 Caddyfile 删除面板站点段; 有改动并重载成功返回 0
caddy_remove_block() {
    [[ -f "$CADDYFILE" ]] && grep -qF "$CADDY_BEGIN" "$CADDYFILE" || return 1
    cp -a "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
    sed -i "\|^$CADDY_BEGIN|,\|^$CADDY_END|d" "$CADDYFILE"
    systemctl reload caddy 2>/dev/null || true
    return 0
}

# Caddy 模式: 在 Caddyfile 末尾加一个带标记的站点段, 证书由 Caddy 自动申请和续期
setup_caddy() {
    local panel_port="$1" bak code
    bak="$CADDYFILE.bak.$(date +%s)"
    cp -a "$CADDYFILE" "$bak"
    restore() { cp -a "$bak" "$CADDYFILE"; systemctl reload caddy 2>/dev/null || true; }

    sed -i "\|^$CADDY_BEGIN|,\|^$CADDY_END|d" "$CADDYFILE"     # 换域名: 先去掉旧段
    if grep -qE "^[^#]*(^|[[:space:],])$DOMAIN([[:space:],{]|$)" "$CADDYFILE"; then
        restore
        die "Caddyfile 里已经有 $DOMAIN 的站点, 请换一个域名或先删除原配置"
    fi
    cat >> "$CADDYFILE" <<EOF

$CADDY_BEGIN
$DOMAIN {
	reverse_proxy 127.0.0.1:$panel_port {
		header_up X-Real-IP {remote_host}
	}
	header Strict-Transport-Security "max-age=31536000"
}
$CADDY_END
EOF
    if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >"$tmp/caddy.log" 2>&1; then
        tail -n 5 "$tmp/caddy.log" >&2
        restore
        die "Caddy 配置检查失败, 已恢复原配置 (备份: $bak)"
    fi
    systemctl reload caddy || { restore; die "Caddy 重载失败, 已恢复原配置"; }
    ok "已加入 Caddy 站点 (原配置备份: $bak)"

    jq '.secureCookie = true | .trustProxy = true' "$DATA/panel.json" > "$tmp/pc" && cat "$tmp/pc" > "$DATA/panel.json"
    systemctl restart vless-panel
    HTTPS_PORT=443
    printf 'PANEL_DOMAIN=%s\nPANEL_HTTPS_PORT=443\nPANEL_WEB=caddy\n' "$DOMAIN" > "$STATE"

    # Caddy 在重载后自动申请证书, 一般十几秒
    info "等待 Caddy 申请证书..."
    for _ in $(seq 1 30); do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" 2>/dev/null || true)
        [[ "$code" =~ ^[2-4][0-9][0-9]$ ]] && { ok "证书已就绪, HTTPS 可用 (Caddy 会自动续期)"; return 0; }
        sleep 2
    done
    warn "暂时还没拿到证书, Caddy 会在后台继续申请; 请确认云服务商放行了 80 和 443 端口"
}

setup_https() {
    local panel_port; panel_port=$(jq -r .port "$DATA/panel.json")
    if ! dns_points_here "$DOMAIN"; then
        die "域名 $DOMAIN 解析到 $(resolve_v4 "$DOMAIN" | paste -sd, - | sed 's/^$/无/'), 不是本机 $(public_ip)。请先把域名 A 记录指向本机 (如用 Cloudflare 请关闭小云朵)"
    fi
    if caddy_owns_web; then
        info "检测到本机由 Caddy 提供网站 (占用 80/443), 改由 Caddy 反代面板"
        [[ -f "$NGINX_CONF" ]] && { rm -f "$NGINX_CONF"; nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true; }
        setup_caddy "$panel_port"
        return 0
    fi
    # 之前是 Caddy 模式, 现在不是了: 清掉旧的 Caddy 段
    caddy_remove_block || true

    if ! command -v nginx >/dev/null; then
        info "安装 nginx..."
        apt-get install -y -qq nginx >/dev/null
        systemctl enable --now nginx >/dev/null 2>&1
    fi
    if ss -tlnp 2>/dev/null | grep -E '[:.]80[[:space:]]' | grep -qv nginx; then
        die "80 端口被非 nginx 程序占用, 无法申请证书"
    fi
    [[ -z "$HTTPS_PORT" ]] && HTTPS_PORT=$(pick_port)
    # 换端口时旧配置还占着原端口, 检查前先排除自己的配置
    if port_used "$HTTPS_PORT" && ! grep -qE "listen[[:space:]]+$HTTPS_PORT[[:space:]]" "$NGINX_CONF" 2>/dev/null; then
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
        rm -f "$NGINX_CONF"; systemctl reload nginx 2>/dev/null || true
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
    printf 'PANEL_DOMAIN=%s\nPANEL_HTTPS_PORT=%s\nPANEL_WEB=nginx\n' "$DOMAIN" "$HTTPS_PORT" > "$STATE"
    ok "HTTPS 已配置"
}

#─── 安装 / 升级 ────────────────────────────────────────────────────────────────

install_deps() {
    info "安装依赖 (nodejs jq curl)..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nodejs jq curl tar ca-certificates iproute2 cron >/dev/null
    local node_major
    node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    [[ "$node_major" -ge 12 ]] || die "Node.js 版本过低 ($(node -v 2>/dev/null)), 需要 12 以上"
    ok "Node.js $(node -v), $(jq --version)"
}

# 预装代理依赖和 Xray / Sing-box 核心, 之后在面板里装协议不用再等下载
# (已装好的会直接跳过; 失败不影响面板, 装协议时还会再装一次)
prepare_cores() {
    info "预装代理依赖和核心 (Xray, Sing-box)..."
    local out
    if out=$(bash "$DIR/engine/vless.sh" --api prepare 2> >(sed -u 's/\x1b\[[0-9;]*m//g; s/^/    /' >&2)) \
        && [[ "$(jq -r .ok <<< "$out" 2>/dev/null)" == true ]]; then
        ok "核心已就绪: Xray $(jq -r .xray <<< "$out"), Sing-box $(jq -r .singbox <<< "$out")"
    else
        warn "核心预装失败 (多半是网络问题), 面板照常可用; 装协议时会再自动安装, 也可以在「系统」页安装"
    fi
}

do_install() {
    local upgrade=false first=false src panel_port base_path
    installed && upgrade=true
    load_state
    # 升级时沿用上次的域名配置
    [[ -z "$DOMAIN" ]] && DOMAIN="$PANEL_DOMAIN"
    [[ -z "$HTTPS_PORT" ]] && HTTPS_PORT="$PANEL_HTTPS_PORT"

    install_deps

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

    rm -rf "$DIR.new"
    cp -a "$src" "$DIR.new"
    rm -rf "$DIR.new/server/data" "$DIR.new/.git"
    chmod +x "$DIR.new"/engine/*.sh "$DIR.new/install.sh" 2>/dev/null || true
    [[ -d "$DIR" ]] && { rm -rf "$DIR.old"; mv "$DIR" "$DIR.old"; }
    mv "$DIR.new" "$DIR"
    ok "面板文件已$([[ $upgrade == true ]] && echo 更新 || echo 安装)到 $DIR"

    # 首次安装: 生成配置和密码 (面板只监听本机)
    if [[ ! -f "$DATA/panel.json" ]]; then
        first=true
        panel_port="${PANEL_PORT_WANT:-$(pick_port)}"
        (umask 077; PANEL_DATA="$DATA" PANEL_PORT="$panel_port" node "$DIR/server/server.js" --reset-password > "$LOGIN")
        ok "已生成管理员账号 (保存在 $LOGIN, 仅 root 可读)"
    fi
    panel_port=$(jq -r .port "$DATA/panel.json")

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

    # 短命令 vp: 随时打开本菜单
    if [[ ! -e "$SHORTCUT" ]] || grep -q "$DIR/install.sh" "$SHORTCUT" 2>/dev/null; then
        printf '#!/bin/bash\n# vless-panel 管理菜单 (由 install.sh 创建)\nexec bash %s "$@"\n' "$DIR/install.sh" > "$SHORTCUT"
        chmod 755 "$SHORTCUT"
        ok "已创建短命令: ${B}vp${N} (随时打开管理菜单)"
    else
        warn "$SHORTCUT 已被其他程序占用, 未创建短命令; 可用 bash $DIR/install.sh 打开菜单"
    fi

    prepare_cores

    [[ -n "$DOMAIN" ]] && setup_https

    show_info "$([[ $upgrade == true ]] && echo 升级 || echo 安装)完成" "$first"
}

# 安装前先问清楚: 域名 → 端口 → 确认, 然后才开始装
interactive_install() {
    if installed; then
        load_state
        echo
        info "面板已安装$([[ -n "$PANEL_DOMAIN" ]] && echo ", 已绑定 $PANEL_DOMAIN")。将从 GitHub 升级到最新版, 配置和密码保持不变。"
        confirm "  确认升级?" y || { echo "  已取消"; return 0; }
        do_install
        return 0
    fi

    ask_domain
    echo
    echo "${B}② 确认端口${N}"
    if [[ -n "$DOMAIN" ]] && caddy_owns_web; then
        HTTPS_PORT=443
        echo "  本机已由 Caddy 占用 80/443, 面板将由 Caddy 反代在 443 提供 HTTPS, 证书由 Caddy 自动申请"
    elif [[ -n "$DOMAIN" ]]; then
        ask_port "面板 HTTPS 端口 (443 留给代理协议)" HTTPS_PORT "$HTTPS_PORT"
    else
        ask_port "面板端口 (只监听本机, SSH 隧道用)" PANEL_PORT_WANT
    fi

    echo
    echo "${B}③ 确认安装${N}"
    if [[ -n "$DOMAIN" ]]; then
        echo "  访问方式: ${G}https://$DOMAIN$(url_port "$HTTPS_PORT")${N} (自动申请证书)"
    else
        echo "  访问方式: SSH 隧道, 面板端口 ${G}$PANEL_PORT_WANT${N}"
    fi
    echo "  安装位置: $DIR    短命令: vp"
    confirm "  开始安装?" y || { echo "  已取消, 没有做任何改动"; return 0; }
    do_install
}

interactive_uninstall() {
    if ! installed; then
        warn "面板没有安装, 无需卸载"
        return 0
    fi
    echo
    warn "将卸载面板 (服务、程序文件、vp 短命令、面板 nginx 配置)。已安装的代理协议不受影响。"
    confirm "  确认卸载?" n || { echo "  已取消"; return 0; }
    confirm "  同时删除面板配置、证书和登录信息? (选否则重装时沿用原密码)" n && PURGE=true
    do_uninstall
}

interactive_bind_domain() {
    installed || { warn "请先安装面板"; return 0; }
    load_state
    [[ -n "$PANEL_DOMAIN" ]] && info "当前已绑定: $PANEL_DOMAIN (HTTPS 端口 $PANEL_HTTPS_PORT)"
    ask_domain
    [[ -z "$DOMAIN" ]] && { echo "  未做改动"; return 0; }
    echo
    echo "${B}② 确认端口${N}"
    if caddy_owns_web; then
        HTTPS_PORT=443
        echo "  本机已由 Caddy 占用 80/443, 面板将由 Caddy 反代在 443 提供 HTTPS, 证书由 Caddy 自动申请"
    else
        ask_port "面板 HTTPS 端口" HTTPS_PORT "$PANEL_HTTPS_PORT"
    fi
    confirm "  确认绑定 https://$DOMAIN$(url_port "$HTTPS_PORT") ?" y || { echo "  已取消"; return 0; }
    command -v jq >/dev/null || install_deps
    setup_https
    show_info "域名绑定完成" false
}

reset_password() {
    installed || { warn "请先安装面板"; return 0; }
    confirm "  重置面板密码? (旧密码立即失效)" n || { echo "  已取消"; return 0; }
    (umask 077; PANEL_DATA="$DATA" node "$DIR/server/server.js" --reset-password > "$LOGIN")
    systemctl restart vless-panel
    show_info "密码已重置" true
}

#─── 显示访问信息 ───────────────────────────────────────────────────────────────

# show_info "标题" 是否显示密码(true/false)
show_info() {
    local title="$1" show_pw="${2:-false}" panel_port base_path
    if [[ ! -f "$DATA/panel.json" ]]; then warn "面板没有安装"; return 0; fi
    panel_port=$(jq -r .port "$DATA/panel.json" 2>/dev/null || sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$DATA/panel.json")
    base_path=$(jq -r .basePath "$DATA/panel.json" 2>/dev/null || sed -n 's/.*"basePath": *"\([^"]*\)".*/\1/p' "$DATA/panel.json")
    load_state
    echo
    echo "${B}════════════════════════════════════════════════════${N}"
    echo "${B}  vless-panel $title${N}"
    echo "${B}════════════════════════════════════════════════════${N}"
    echo "  状态:     $(systemctl is-active vless-panel 2>/dev/null | sed "s/^active$/${G}运行中${N}/")"
    if [[ -n "$PANEL_DOMAIN" ]]; then
        echo "  访问地址: ${G}https://$PANEL_DOMAIN$(url_port "$PANEL_HTTPS_PORT")$base_path${N}"
        echo "  ${Y}云服务器请在安全组 / 防火墙放行 TCP 80 和 $PANEL_HTTPS_PORT${N}"
    else
        echo "  面板只监听本机, 在你自己电脑上开 SSH 隧道后访问:"
        echo "    ssh -L $panel_port:127.0.0.1:$panel_port root@$(public_ip | sed 's/^$/服务器IP/')"
        echo "    浏览器打开 ${G}http://127.0.0.1:$panel_port$base_path${N}"
    fi
    echo "  用户名:   admin"
    if [[ "$show_pw" == true && -f "$LOGIN" ]]; then
        echo "  密码:     ${G}$(sed -n 's/^ *密码: *//p' "$LOGIN" | tail -1)${N}"
        echo "  (登录信息也保存在 $LOGIN)"
    else
        echo "  密码:     见 $LOGIN (忘记了可在菜单里重置)"
    fi
    echo
    echo "  管理菜单: 输入 ${B}vp${N}"
    echo "${B}════════════════════════════════════════════════════${N}"
}

#─── 菜单 ───────────────────────────────────────────────────────────────────────

menu() {
    local choice status
    while true; do
        load_state
        if installed; then
            status="${G}已安装${N}, $(systemctl is-active vless-panel 2>/dev/null | sed "s/^active$/运行中/; s/^inactive$/${R}已停止${N}/")"
            [[ -n "$PANEL_DOMAIN" ]] && status+=", 域名 $PANEL_DOMAIN"
        else
            status="${D}未安装${N}"
        fi
        echo
        echo "${B}══════════ vless-panel 管理 ══════════${N}"
        echo "  状态: $status"
        echo "──────────────────────────────────────"
        echo "  ${G}1${N}) $(installed && echo '升级面板' || echo '安装面板')"
        echo "  ${G}2${N}) 卸载面板"
        echo "  ${G}3${N}) 绑定 / 更换域名"
        echo "  ${G}4${N}) 查看访问地址"
        echo "  ${G}5${N}) 重置密码"
        echo "  ${G}6${N}) 重启面板"
        echo "  ${G}0${N}) 退出"
        echo "──────────────────────────────────────"
        ask "  请选择: " choice
        case "$choice" in
            1) interactive_install; return 0 ;;
            2) interactive_uninstall; return 0 ;;
            3) interactive_bind_domain ;;
            4) show_info "访问信息" true ;;
            5) reset_password ;;
            6) if installed; then systemctl restart vless-panel && ok "面板已重启"; else warn "面板没有安装"; fi ;;
            0|"") return 0 ;;
            *) warn "无效选择" ;;
        esac
    done
}

#─── 入口 ───────────────────────────────────────────────────────────────────────

case "$ACTION" in
    install)   do_install ;;
    uninstall) do_uninstall ;;
    "")
        if has_tty; then
            menu
        else
            do_install   # 没有终端 (自动化): 直接安装/升级, 不绑定域名
        fi
        ;;
esac
