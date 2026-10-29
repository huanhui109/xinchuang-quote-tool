#!/usr/bin/env bash
# =============================================================================
#  信创服务器配置报价工具 · 本地启动与运维脚本 (Mac / Linux)
# -----------------------------------------------------------------------------
#  本工具提供两种运行环境：
#    1) python  —— 完整后端环境（server.py）：静态服务 + REST API + JSON 持久化
#    2) node    —— 纯静态兜底环境（server.js）：无 API，前端自动回退 localStorage
#
#  用法:
#    ./start.sh                 # 启动 python 完整环境（默认）
#    ./start.sh start           # 同上
#    ./start.sh start python    # 显式启动 python 环境
#    ./start.sh start node      # 启动 node 纯静态兜底环境
#    ./start.sh start all       # 同时启动 python + node（分别占用不同端口）
#    ./start.sh stop            # 停止所有环境
#    ./start.sh stop python     # 仅停止 python 环境
#    ./start.sh restart         # 重启所有
#    ./start.sh restart node    # 重启 node 环境
#    ./start.sh status          # 查看两环境运行状态与访问地址
#    ./start.sh logs            # 查看 python 日志（tail）
#    ./start.sh logs node       # 查看 node 日志
#    ./start.sh help            # 帮助
#
#  说明:
#    - 运行态产物（PID / 日志）统一放在项目根目录 .run/ 下，已被 .gitignore 忽略
#    - 默认端口 8000；若被占用，脚本自动顺延到下一个空闲端口
# =============================================================================

set -u

# ---- 路径与运行态目录 ----
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

RUN_DIR="$PROJECT_DIR/.run"
mkdir -p "$RUN_DIR"

PY_PID="$RUN_DIR/python.pid"
PY_LOG="$RUN_DIR/python.log"
PY_PORT_FILE="$RUN_DIR/python.port"
NODE_PID="$RUN_DIR/node.pid"
NODE_LOG="$RUN_DIR/node.log"
NODE_PORT_FILE="$RUN_DIR/node.port"

DEFAULT_PORT=8000

# ---- 颜色（终端友好，非 TTY 时自动降级）----
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
fi

log_ok()   { printf "%s[ok]%s   %s\n"   "$C_OK"   "$C_RST" "$1"; }
log_warn() { printf "%s[warn]%s %s\n"   "$C_WARN" "$C_RST" "$1"; }
log_err()  { printf "%s[err]%s  %s\n"   "$C_ERR"  "$C_RST" "$1"; }
log_info() { printf "%s[info]%s %s\n"   "$C_DIM"  "$C_RST" "$1"; }

# ---- 端口仲裁：从 DEFAULT_PORT 找第一个未被监听的端口 ----
find_free_port() {
  local p=$DEFAULT_PORT
  while lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; do
    p=$((p + 1))
  done
  echo "$p"
}

# ---- 检测 Python 解释器（Mac 上通常为 python3）----
detect_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
  elif command -v python >/dev/null 2>&1; then
    echo "python"
  else
    echo ""
  fi
}

# ---- 进程是否存活 ----
is_alive() {
  local pidf=$1
  [ -f "$pidf" ] || return 1
  local pid
  pid="$(cat "$pidf" 2>/dev/null || echo "")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# ---- 等 server 输出监听地址（最多 timeout 秒）----
wait_ready() {
  local logf=$1 timeout=${2:-6} t=0
  while [ "$t" -lt "$timeout" ]; do
    if grep -qE 'http://localhost:' "$logf" 2>/dev/null; then
      return 0
    fi
    # 若进程已退出（日志出现错误），提前失败
    if grep -qiE 'error|traceback|exception' "$logf" 2>/dev/null && [ "$t" -ge 2 ]; then
      return 1
    fi
    sleep 0.5
    t=$((t + 1))
  done
  return 1
}

# ---- 解析日志中的访问地址 ----
read_url() {
  grep -oE 'http://localhost:[0-9]+' "$1" 2>/dev/null | tail -1
}

# ---- 启动单个环境 ----
start_one() {
  local env=$1
  if [ "$env" = "python" ]; then
    if is_alive "$PY_PID"; then
      log_warn "Python 完整环境已在运行 (pid $(cat "$PY_PID")) —— $(read_url "$PY_LOG")"
      return 0
    fi
    local pybin
    pybin="$(detect_python)"
    if [ -z "$pybin" ]; then
      log_err "未找到 Python 解释器，无法启动完整后端环境。"
      log_info "请安装 Python 3.10+：https://www.python.org/downloads/"
      return 1
    fi
    local port
    port="$(find_free_port)"
    log_info "启动 Python 完整环境 (server.py)，端口 $port ..."
    # -u：关闭 stdout 缓冲，使启动日志（含监听地址）即时落盘，便于状态探测
    PORT="$port" nohup "$pybin" -u server.py >"$PY_LOG" 2>&1 &
    echo $! >"$PY_PID"
    if wait_ready "$PY_LOG"; then
      local url; url="$(read_url "$PY_LOG")"
      echo "${url##*:}" >"$PY_PORT_FILE"
      log_ok "Python 完整环境已启动：$url  (日志: $PY_LOG)"
    else
      log_err "Python 环境启动失败，请查看日志：$PY_LOG"
      rm -f "$PY_PID"
      return 1
    fi
  elif [ "$env" = "node" ]; then
    if is_alive "$NODE_PID"; then
      log_warn "Node 纯静态兜底环境已在运行 (pid $(cat "$NODE_PID")) —— $(read_url "$NODE_LOG")"
      return 0
    fi
    if ! command -v node >/dev/null 2>&1; then
      log_err "未找到 Node.js，无法启动纯静态兜底环境。"
      log_info "请安装 Node.js 18+：https://nodejs.org/"
      return 1
    fi
    local port
    port="$(find_free_port)"
    log_info "启动 Node 纯静态兜底环境 (server.js)，端口 $port ..."
    PORT="$port" nohup node server.js >"$NODE_LOG" 2>&1 &
    echo $! >"$NODE_PID"
    if wait_ready "$NODE_LOG"; then
      local url; url="$(read_url "$NODE_LOG")"
      echo "${url##*:}" >"$NODE_PORT_FILE"
      log_ok "Node 纯静态兜底环境已启动：$url  (日志: $NODE_LOG)"
    else
      log_err "Node 环境启动失败，请查看日志：$NODE_LOG"
      rm -f "$NODE_PID"
      return 1
    fi
  else
    log_err "未知环境：$env （可选 python | node）"
    return 1
  fi
}

# ---- 停止单个环境（优雅 SIGTERM -> 必要时 SIGKILL）----
stop_one() {
  local env=$1
  local pidf
  if [ "$env" = "python" ]; then pidf="$PY_PID"; else pidf="$NODE_PID"; fi
  if ! is_alive "$pidf"; then
    if [ -f "$pidf" ]; then rm -f "$pidf"; fi
    log_info "$env 环境未运行。"
    return 0
  fi
  local pid; pid="$(cat "$pidf")"
  log_info "停止 $env 环境 (pid $pid) ..."
  kill -TERM "$pid" 2>/dev/null
  local t=0
  while kill -0 "$pid" 2>/dev/null && [ "$t" -lt 8 ]; do
    sleep 0.5; t=$((t + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    log_warn "$env 环境未能优雅退出，强制终止 ..."
    kill -KILL "$pid" 2>/dev/null
    sleep 0.3
  fi
  rm -f "$pidf"
  log_ok "$env 环境已停止。"
}

# ---- 状态 ----
show_status() {
  printf "\n  信创报价工具 · 运行态 ($(date '+%Y-%m-%d %H:%M'))\n"
  printf "  %-22s %-10s %s\n" "环境" "状态" "访问地址 / 备注"
  printf "  %s\n" "  -----------------------------------------------------"
  for pair in "Python 完整后端:python" "Node 纯静态兜底:node"; do
    local label="${pair%%:*}"; local env="${pair##*:}"
    local pidf portf
    if [ "$env" = "python" ]; then pidf="$PY_PID"; portf="$PY_PORT_FILE"; else pidf="$NODE_PID"; portf="$NODE_PORT_FILE"; fi
    if is_alive "$pidf"; then
      local url; url="$(read_url "${pidf%.pid}.log")"
      printf "  %-22s %-10s %s\n" "$label" "运行中" "${url:-（端口未知）}"
    elif [ -f "$pidf" ]; then
      printf "  %-22s %-10s %s\n" "$label" "已停止" "（检测到残留 pid 文件，已清理）"
      rm -f "$pidf"
    else
      printf "  %-22s %-10s %s\n" "$label" "未启动" "—"
    fi
  done
  printf "\n"
}

# ---- 日志 ----
show_logs() {
  local env=${1:-python}
  local logf
  if [ "$env" = "python" ]; then logf="$PY_LOG"; else logf="$NODE_LOG"; fi
  if [ ! -f "$logf" ]; then
    log_warn "暂无 $env 环境日志（$logf）"
    return 0
  fi
  log_info "===== $env 环境日志 (tail -n 60) ====="
  tail -n 60 "$logf"
}

# ---- 用法 ----
usage() {
  cat <<'EOF'

  信创服务器配置报价工具 · 本地启动与运维脚本

  用法: ./start.sh [命令] [环境]

  命令:
    start            启动环境（默认 python）
    stop             停止环境（默认 all）
    restart          重启环境（默认 all）
    status           查看两环境运行状态与访问地址
    logs             查看日志（默认 python，可跟 node）
    help             显示本帮助

  环境:
    python   —— 完整后端环境（server.py）：静态 + REST API + JSON 持久化
    node     —— 纯静态兜底环境（server.js）：无 API，前端回退 localStorage
    all      —— python + node 同时启动（各自占用不同端口）

  示例:
    ./start.sh                      # 启动 python 完整环境
    ./start.sh start node           # 启动 node 兜底环境
    ./start.sh start all            # 两个环境一起启动
    ./start.sh status               # 查看运行状态
    ./start.sh stop                 # 停止全部
    ./start.sh restart python       # 重启 python 环境

  备注: 运行态产物位于 .run/（PID / 日志），默认端口 8000（占用自动顺延）。

EOF
}

# ---- 主分发 ----
CMD="${1:-start}"
ENV="${2:-}"
# 未显式给环境时，start/stop/restart 的默认行为
case "$CMD" in
  start)
    if [ -z "$ENV" ] || [ "$ENV" = "python" ]; then
      start_one python
    elif [ "$ENV" = "node" ]; then
      start_one node
    elif [ "$ENV" = "all" ]; then
      start_one python
      start_one node
    else
      log_err "未知环境：$ENV"; usage; exit 1
    fi
    ;;
  stop)
    if [ -z "$ENV" ] || [ "$ENV" = "all" ]; then
      stop_one python
      stop_one node
    elif [ "$ENV" = "python" ]; then
      stop_one python
    elif [ "$ENV" = "node" ]; then
      stop_one node
    else
      log_err "未知环境：$ENV"; usage; exit 1
    fi
    ;;
  restart)
    if [ -z "$ENV" ] || [ "$ENV" = "all" ]; then
      stop_one python; stop_one node
      sleep 0.5
      start_one python; start_one node
    elif [ "$ENV" = "python" ]; then
      stop_one python; sleep 0.5; start_one python
    elif [ "$ENV" = "node" ]; then
      stop_one node; sleep 0.5; start_one node
    else
      log_err "未知环境：$ENV"; usage; exit 1
    fi
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs "${ENV:-python}"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    log_err "未知命令：$CMD"; usage; exit 1
    ;;
esac
