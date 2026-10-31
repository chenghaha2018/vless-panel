#!/bin/bash
# 本地开发用: 模拟原脚本的交互流程, 走真实的 webtty 桥接
# 用法: run-demo.sh <webtty.sh 路径> install <proto> | uninstall <proto:名称>... | sub-setup

source "$1"; shift
_webtty_init

R='\e[31m'; G='\e[32m'; Y='\e[33m'; C='\e[36m'; W='\e[97m'; D='\e[2m'; NC='\e[0m'
_line() { echo -e "${D}─────────────────────────────────────────────${NC}" >&2; }
_info() { echo -e "  ${C}▸${NC} $1" >&2; }
_ok()   { echo -e "  ${G}✓${NC} $1" >&2; }
_err()  { echo -e "  ${R}✗${NC} $1" >&2; }
_warn() { echo -e "  ${Y}!${NC} $1" >&2; }
_item() { echo -e "  ${G}$1${NC}) $2" >&2; }
result() { printf '\x1e{"type":"result",%s}\n' "$1" >&2; }
step() { _info "$1"; sleep "${2:-0.6}"; }

install() {
    local proto="$1" port stls=n
    echo -e "  ${W}服务端安装向导${NC}" >&2
    step "检测基础依赖..."
    _ok "依赖已满足"
    step "检测网络环境..."
    echo -e "  IPv4: 203.0.113.10" >&2
    echo -e "  IPv6: 2001:db8::10" >&2

    if [[ "$proto" == snell* || "$proto" == ss2022 ]]; then
        _line; echo -e "  ${W}ShadowTLS 插件${NC}" >&2; _line
        read -rp "  是否启用 ShadowTLS (v3) 插件? [y/N]: " stls
    fi

    local def=443
    [[ "$proto" == hy2 || "$proto" == tuic ]] && def=20443
    while true; do
        echo -e "  ${D}推荐端口: $def (未被占用)${NC}" >&2
        read -rp "  请输入端口 [回车使用 $def]: " port
        port="${port:-$def}"
        [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) && break
        _err "端口无效, 请输入 1-65535"
    done
    if [[ "$port" == 443 && "$proto" != vless ]]; then
        _warn "端口 443 已被 VLESS-REALITY 占用"
        echo "" >&2
        _item 1 "与现有协议共用 (回落)"
        _item 2 "换一个端口"
        _item 0 "取消安装"
        read -rp "  请选择 [1]: " c
        case "${c:-1}" in
            0) _warn "已取消"; return 1 ;;
            2) port=$((port + 7000)); _info "改用端口 $port" ;;
        esac
    fi

    case "$proto" in
        vless|vless-xhttp|vless-vision|trojan|hy2|anytls|tuic)
            echo "" >&2; _line; echo -e "  ${W}选择伪装域名 (SNI)${NC}" >&2; _line
            _item 1 "www.microsoft.com ${D}(推荐)${NC}"
            _item 2 "www.apple.com"
            _item 3 "www.amazon.com"
            _item 4 "自定义"
            read -rp "  选择 SNI [1]: " s
            case "${s:-1}" in
                2) sni=www.apple.com ;; 3) sni=www.amazon.com ;;
                4) read -rp "  输入自定义 SNI: " sni ;;
                *) sni=www.microsoft.com ;;
            esac ;;
        socks)
            read -rp "  用户名 [回车随机生成]: " su
            read -rsp "  密码 [回车随机生成]: " sp
            echo "" >&2 ;;
    esac

    echo "" >&2; _line
    echo -e "  端口: ${G}$port${NC}  SNI: ${G}${sni:--}${NC}  ShadowTLS: ${G}${stls:-n}${NC}" >&2
    _line
    read -rp "  确认安装? [Y/n]: " confirm
    [[ "$confirm" =~ ^[nN]$ ]] && { _warn "已取消安装"; return 1; }

    step "下载核心 (mock)..." 1
    echo "  100%[==================>] 12.3M  4.1MB/s  in 3.0s" >&2
    step "生成服务端配置..."
    step "创建系统服务..."
    step "启动服务..." 1
    _ok "安装完成"
    echo "" >&2
    echo -e "  ${Y}分享链接:${NC}" >&2
    echo -e "  ${G}${proto}://11111111-2222-4333-8444-555555555555@203.0.113.10:${port}?sni=${sni:-}#US-${proto}${NC}" >&2
    result "\"kind\":\"install\",\"proto\":\"$proto\",\"port\":$port,\"sni\":\"${sni:-}\""
}

uninstall() {
    local i=1 item
    _line; echo -e "  ${W}卸载指定协议${NC}" >&2; _line
    for item in "$@"; do _item "$i" "${item#*:}"; ((i++)); done
    _item 0 "返回"
    read -rp "  选择要卸载的协议 [0-$((i - 1))]: " choice
    [[ "$choice" == 0 || -z "$choice" ]] && return 0
    [[ "$choice" =~ ^[0-9]+$ ]] && (( choice < i )) || { _err "无效选择"; return 1; }
    item="${!choice}"
    read -rp "  确认卸载 ${item#*:}? [y/N]: " confirm
    [[ "$confirm" =~ ^[yY]$ ]] || return 0
    step "停止服务..."
    step "删除配置..."
    _ok "${item#*:} 已卸载"
    result "\"kind\":\"uninstall\",\"proto\":\"${item%%:*}\""
}

sub_setup() {
    echo -e "  ${W}配置订阅服务${NC}" >&2; _line
    step "检查 Nginx..."
    read -rp "  订阅端口 [18443]: " port; port="${port:-18443}"
    read -rp "  绑定域名 (可选, 回车跳过): " domain
    read -rp "  启用 HTTPS? [Y/n]: " https
    local h=true; [[ "$https" =~ ^[nN]$ ]] && h=false
    step "生成订阅文件..."
    step "配置 Nginx..."
    _ok "订阅服务已启用"
    result "\"kind\":\"sub-setup\",\"port\":\"$port\",\"domain\":\"$domain\",\"https\":$h"
}

# 通用管理菜单: menu <标题> <选项1> <选项2> ... ; 选 0 返回, 其他选项模拟执行一步
menu() {
    local title="$1" i c; shift
    while true; do
        echo "" >&2; _line; echo -e "  ${W}$title${NC}" >&2; _line
        i=1; for c in "$@"; do _item "$i" "$c"; ((i++)); done
        _item 0 "返回"
        _line
        read -rp "  请选择: " c
        [[ "$c" == 0 ]] && return 0
        if [[ "$c" =~ ^[0-9]+$ ]] && (( c >= 1 && c < i )); then
            step "(mock) 执行: ${!c}"
            [[ "${!c}" == *添加* || "${!c}" == *导入* ]] && read -rp "  请输入分享链接或名称: " _x
            _ok "完成"
        else
            _err "无效选择"
        fi
    done
}

uninstall_all() {
    _warn "将停止并删除所有协议、配置、证书和订阅"
    read -rp "  确认卸载? [y/N]: " confirm
    [[ "$confirm" =~ ^[yY]$ ]] || return 0
    step "停止所有服务..."; step "删除配置..."; _ok "已完全卸载 (mock, 未改动数据)"
}

case "$1" in
    install)       install "$2" ;;
    uninstall)     shift; uninstall "$@" ;;
    sub-setup)     sub_setup ;;
    routing)       menu "分流管理" "WARP 管理" "链式代理" "配置分流规则" "直连出口设置" "多IP入出站配置" "测试分流效果" "查看当前配置" ;;
    routing-rules) menu "分流规则" "添加分流规则" "删除分流规则" "清空所有规则" "测试分流效果" ;;
    chain)         menu "链式代理" "添加节点 (分享链接)" "导入订阅" "创建负载均衡组" "测试所有节点延迟" "删除节点" ;;
    warp)          menu "WARP 管理" "切换到官方客户端模式" "重新获取 WGCF 配置" "测试 WARP 连接" "卸载 WGCF" ;;
    ip-routing)    menu "多IP入出站配置" "添加/修改映射规则" "删除映射规则" "启用多IP路由" ;;
    direct)        menu "直连出口设置" "仅 IPv4" "仅 IPv6" "优先 IPv4" "优先 IPv6" "AsIs" ;;
    latency)       step "测试节点延迟..." 1; echo "  sg     38ms" >&2; echo "  jp-1   61ms" >&2; read -rp "  按回车返回..." _ ;;
    core-update)   menu "核心版本管理" "更新 Xray" "更新 Sing-box" "更新 Snell v5" "重新获取版本" ;;
    bbr)           menu "BBR 网络优化" "重新优化 (更新参数)" "卸载 BBR 优化" ;;
    core-xray|core-singbox)
        n=Xray; [[ "$1" == core-singbox ]] && n=Sing-box
        echo -e "  ${W}$n 版本选择${NC}" >&2; _line
        _item 1 "稳定版"; _item 2 "测试版"; _item 3 "指定版本"; _item 0 "返回"
        read -rp "  请选择: " c
        [[ "$c" == 0 || -z "$c" ]] && exit 0
        read -rp "  确认更新 $n? [Y/n]: " y; [[ "$y" =~ ^[nN]$ ]] && exit 0
        step "下载 $n (mock)..." 1; step "替换并重启服务..."; _ok "$n 已更新 (mock, 未改动数据)" ;;
    uninstall-all) uninstall_all ;;
esac
