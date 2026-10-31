#!/bin/bash
# webtty: 让原脚本的交互式流程 (安装/卸载/订阅配置...) 在面板里运行
#
# 原理: 覆盖 read。凡是从"应答通道"读取的 read (即原本等待键盘输入的那些),
# 先往 stderr 写一行事件 (\x1e + JSON), 再从应答通道读一整行作为答案。
# 面板把事件渲染成按钮 / 输入框, 用户操作后把答案写进进程的 stdin。
# 从文件、here-string、管道读取的 read 不受影响。
#
# 用法: source webtty.sh; _webtty_init

_webtty_init() {
    exec 7<&0                       # fd 7 = 应答通道 (启动时的 stdin)
    clear() { :; }                  # 面板里不清屏
    _pause() { :; }                 # 也不需要"按回车继续"
    export TERM=dumb
}

# 去掉 ANSI 颜色 (真实 ESC 字符和字面量 \e[..m 两种), 转成 JSON 字符串
_webtty_json_str() {
    local s
    s=$(printf '%s' "$1" | sed -e $'s/\x1b\\[[0-9;]*[mK]//g' -e 's/\\e\[[0-9;]*m//g' -e 's/\\033\[[0-9;]*m//g')
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\t'/ }
    s=${s//$'\r'/}
    s=${s//$'\n'/ }
    printf '"%s"' "$s"
}

_webtty_event() { printf '\x1e%s\n' "$1" >&2; }

read() {
    # 不是从应答通道读 → 原样执行
    if [[ ! /proc/self/fd/0 -ef /proc/self/fd/7 ]]; then
        builtin read "$@"
        return
    fi

    # 局部变量一律加 __wt_ 前缀: read 要赋值给调用者的变量,
    # 同名 local 会遮住它 (例如脚本里的 read -rp ... c 会写进这里的 c)
    local __wt_prompt="" __wt_secret=false __wt_a __wt_c __wt_i __wt_v __wt_flags
    local -a __wt_args=(-r)
    while (( $# )); do
        __wt_a="$1"; shift
        if [[ "$__wt_a" == -?* && "$__wt_a" != "--" ]]; then
            __wt_flags="${__wt_a#-}"
            for (( __wt_i = 0; __wt_i < ${#__wt_flags}; __wt_i++ )); do
                __wt_c="${__wt_flags:__wt_i:1}"
                case "$__wt_c" in
                    s) __wt_secret=true ;;
                    p|n|N|t|d|i|u|a)
                        # 带参数的选项: 值可能紧跟在后面 (-n1), 也可能是下一个参数
                        if (( __wt_i < ${#__wt_flags} - 1 )); then __wt_v="${__wt_flags:__wt_i+1}"; else __wt_v="$1"; shift; fi
                        case "$__wt_c" in
                            p) __wt_prompt="$__wt_v" ;;
                            a) __wt_args+=(-a "$__wt_v") ;;
                        esac                 # 其余 (-n -t -d ...) 面板总是整行作答, 忽略
                        break ;;
                    *) ;;                    # -r -e 等
                esac
            done
        else
            __wt_args+=("$__wt_a")
        fi
    done

    _webtty_event "{\"type\":\"prompt\",\"text\":$(_webtty_json_str "$__wt_prompt"),\"secret\":$__wt_secret}"
    builtin read "${__wt_args[@]}"
}
