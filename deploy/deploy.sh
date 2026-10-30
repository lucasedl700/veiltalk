#!/usr/bin/env bash
# =============================================================================
# VeilTalk 一键部署脚本（Docker Compose 版）
#
# 用法：
#   bash deploy.sh            # 首次/日常部署：生成 .env（随机 TURN 凭据）→ 构建并启动
#   bash deploy.sh up --turn-rest  # 同上，但 TURN 改用 REST 短期凭证（secret + 限时 HMAC，更安全；
#                             # 双侧自动配置：.env 写入 TURN_SHARED_SECRET + coturn 切 use-auth-secret）
#   bash deploy.sh logs       # 跟踪全部服务日志（logs <service> 跟踪单个）
#   bash deploy.sh down       # 停止并移除容器（db/ledger 台账与 .env 保留）
#   bash deploy.sh status     # 查看服务状态与健康检查
#   bash deploy.sh restart    # 重启全部服务
#   bash deploy.sh backup     # 备份元数据台账 db/ledger 到 backups/
#   bash deploy.sh help       # 帮助
#
# 本脚本幂等：重复执行不会覆盖已有 .env，只同步 coturn 凭据使其与 .env 一致。
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.yml"
ENV_FILE="$ROOT_DIR/.env"
COTURN_CONF="$ROOT_DIR/deploy/coturn/turnserver.conf"
BACKUP_DIR="$ROOT_DIR/backups"

log()  { printf '\033[1;32m[deploy]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------ 前置检查 --------------------------------------
check_prereq() {
  command -v docker >/dev/null 2>&1 || die "未检测到 docker，请先安装 Docker Engine（https://docs.docker.com/engine/install/）"
  docker info >/dev/null 2>&1 || die "docker daemon 不可用：服务未启动或当前用户无权限（可 sudo 或加入 docker 组）"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    log "检测到 Docker Compose v2 插件：$(docker compose version --short)"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
    warn "使用旧版 docker-compose（建议升级到 Compose v2 插件）"
  else
    die "未检测到 'docker compose' 插件，也未安装 docker-compose。请先安装：apt/yum 安装 docker-compose-plugin"
  fi
}

# ------------------------------ 生成 .env -------------------------------------
# 随机凭据优先 openssl，退化为 /dev/urandom（仅输出 hex，保证可安全用于 sed/配置文件）
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-48
  fi
}

# 自动探测公网出口 IP（用于 TURN_URLS 默认值）；失败则留占位符提醒手工修改
detect_public_ip() {
  curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -4 -fsS --max-time 5 ifconfig.me 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || true
}

ensure_env() {
  local forced_ip="${1:-}"
  if [ -f "$ENV_FILE" ]; then
    log ".env 已存在，跳过生成（如需重新生成：rm .env 后重跑）"
    return
  fi
  log "生成 $ENV_FILE ..."
  local turn_user="veiltalk"
  local turn_cred server_ip
  turn_cred="$(rand_hex)"
  server_ip="${forced_ip:-$(detect_public_ip)}"
  [ -n "${server_ip:-}" ] || { server_ip="YOUR_SERVER_IP"; warn "未能自动探测公网 IP，TURN_URLS 中的 YOUR_SERVER_IP 需手工替换"; }
  cat > "$ENV_FILE" <<EOF
# VeilTalk 运行环境变量（由 deploy.sh 生成于 $(date '+%F %T')；样例字段说明见 deploy/.env.example）
STUN_URLS=stun:stun.miwifi.com:3478,stun:stun.nextcloud.com:443,stun:global.stun.twilio.com:3478,stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478
TURN_URLS=turn:${server_ip}:3478?transport=udp,turn:${server_ip}:3478?transport=tcp
TURN_USERNAME=${turn_user}
TURN_CREDENTIAL=${turn_cred}
SIGNALING_HTTP=http://signaling:3004
EOF
  chmod 600 "$ENV_FILE"
  log ".env 生成完成（权限 600，含 TURN 凭据，勿提交仓库）"
}

# -------------------- 同步 TURN 凭据到 coturn 配置 ----------------------------
# coturn 不读 .env：deploy.sh 把 .env 中的长期凭证改写进 turnserver.conf 的 user= 行
sync_coturn_credential() {
  local u c
  u="$(sed -n 's/^TURN_USERNAME=//p' "$ENV_FILE" | tail -n1 | tr -d '[:space:]')"
  c="$(sed -n 's/^TURN_CREDENTIAL=//p' "$ENV_FILE" | tail -n1 | tr -d '[:space:]')"
  if [ -z "$u" ] || [ -z "$c" ]; then
    warn ".env 缺少 TURN_USERNAME/TURN_CREDENTIAL，跳过 coturn 凭据同步"
    return
  fi
  if ! printf '%s' "$c" | grep -Eq '^[A-Za-z0-9_-]+$'; then
    warn "TURN_CREDENTIAL 含特殊字符，为避免配置转义问题未自动同步；请改用随机 hex（deploy.sh 生成的默认值即 hex）"
    return
  fi
  sed "s|^user=.*|user=${u}:${c}|" "$COTURN_CONF" > "${COTURN_CONF}.tmp" && mv "${COTURN_CONF}.tmp" "$COTURN_CONF"
  log "已同步长期凭证到 deploy/coturn/turnserver.conf（用户名：${u}）"
}

# ------------------------------ .dockerignore ---------------------------------
# 构建上下文排除大目录/敏感文件（node_modules、.next、.git、.env 等）
ensure_dockerignore() {
  local f="$ROOT_DIR/.dockerignore"
  if [ -f "$f" ]; then return; fi
  cat > "$f" <<'EOF'
node_modules
**/node_modules
.next
.git
db
download
upload
docs
tests
examples
skills
backups
*.log
.env
.env.*
EOF
  log "已生成 .dockerignore（缩小构建上下文，防止 .env 泄入镜像层）"
}

# -------------------- TURN REST 短期凭证（F-35，--turn-rest）-------------------
# 两种鉴权机制互斥：lt-cred-mech（长期凭证） vs use-auth-secret（REST 短期凭证）。
# --turn-rest 一次性完成双侧配置：.env 追加 TURN_SHARED_SECRET（web 容器经 env_file
# 自动获得，/api/ice-config 检测到即切 REST 签发）+ coturn 切 use-auth-secret。

# 确保 .env 含 TURN_SHARED_SECRET：已有则复用，缺失则生成追加；stdout 输出 secret
ensure_turn_rest_secret() {
  local existing
  existing="$(sed -n 's/^TURN_SHARED_SECRET=//p' "$ENV_FILE" | tail -n1 | tr -d '[:space:]')"
  if [ -n "$existing" ]; then
    printf '%s' "$existing"
    return 0
  fi
  local secret
  secret="$(rand_hex)"
  printf '\n# TURN REST 短期凭证共享密钥（deploy.sh --turn-rest 生成；与 coturn static-auth-secret 一致）\nTURN_SHARED_SECRET=%s\n' "$secret" >> "$ENV_FILE"
  log "已生成 TURN_SHARED_SECRET 并追加到 .env（web 容器经 env_file 自动注入）"
  printf '%s' "$secret"
}

# 把 coturn 配置切到 REST secret 模式（幂等；首次切换时备份原长期凭证配置）
switch_coturn_rest() {
  local secret="$1"
  if grep -q '^use-auth-secret' "$COTURN_CONF"; then
    # 已在 REST 模式：仅同步 secret（.env 可能重新生成过）
    sed "s|^static-auth-secret=.*|static-auth-secret=${secret}|" "$COTURN_CONF" > "${COTURN_CONF}.tmp" && mv "${COTURN_CONF}.tmp" "$COTURN_CONF"
    log "coturn 已处于 REST secret 模式，已同步 static-auth-secret"
    return 0
  fi
  if [ ! -f "${COTURN_CONF}.lt-cred.bak" ]; then
    cp "$COTURN_CONF" "${COTURN_CONF}.lt-cred.bak"
    log "已备份原长期凭证配置 → deploy/coturn/turnserver.conf.lt-cred.bak（回退时还原即可）"
  fi
  sed -e 's|^lt-cred-mech|#<disabled-by-turn-rest> lt-cred-mech|' \
      -e 's|^user=|#<disabled-by-turn-rest> user=|' \
      -e 's|^#use-auth-secret|use-auth-secret|' \
      -e "s|^#static-auth-secret=.*|static-auth-secret=${secret}|" \
      "$COTURN_CONF" > "${COTURN_CONF}.tmp" && mv "${COTURN_CONF}.tmp" "$COTURN_CONF"
  log "coturn 已切换为 REST 短期凭证模式（use-auth-secret + static-auth-secret）"
  warn "两种机制互斥：若需回退长期凭证，还原 ${COTURN_CONF}.lt-cred.bak 并重启 coturn"
}

# ------------------------------ 部署与输出 ------------------------------------
do_up() {
  local ip
  ip="$(detect_public_ip)"
  ensure_env "$ip"
  if [ "${TURN_REST:-0}" = "1" ]; then
    # F-35：REST 短期凭证模式（先于 sync_coturn_credential；互斥分支不同时执行）
    local rest_secret
    rest_secret="$(ensure_turn_rest_secret)"
    switch_coturn_rest "$rest_secret"
  else
    sync_coturn_credential
  fi
  ensure_dockerignore
  log "构建并启动服务（首次构建可能需要数分钟）..."
  (cd "$ROOT_DIR" && "${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d --build)
  echo
  log "部署完成！服务清单："
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null \
    || "${COMPOSE[@]}" -f "$COMPOSE_FILE" ps
  [ -n "${ip:-}" ] || ip="<服务器IP>"
  cat <<EOF

  ── 访问入口 ─────────────────────────────────────────────
  Web 页面        http://${ip}:3000          （生产请走反代 HTTPS，见 DEPLOYMENT.md 第 5 节）
  运维 API        http://${ip}:3004/svc/health  curl http://127.0.0.1:3004/svc/health
  ICE 配置下发    http://${ip}:3000/api/ice-config

  ── 端口清单（安全组需放行）──────────────────────────────
  3478/tcp+udp    TURN/STUN 监听            （必须）
  49152-49255/tcp+udp  TURN relay 中继段    （必须）
  5349/tcp+udp    TURN over TLS             （可选，需证书）
  3000/tcp        Web（建议仅内网，经反代对外）
  3003/tcp        信令 WS（建议仅内网，经反代对外）
  3004/tcp        运维 API（建议仅内网）

  ── 重要提醒 ─────────────────────────────────────────────
  1. WebRTC 必须运行在安全上下文：公网访问必须配 HTTPS（或仅 localhost 调试）。
  2. 信令固定走同源 ?XTransformPort=3003 路由：请在服务器上按 DEPLOYMENT.md
     配置 Caddy/nginx 反向代理（3000/3003/3004 无需对公网开放）。
  3. TURN 中继不通时：检查安全组 3478/udp 与 49152-49255/udp，
     并在 coturn/turnserver.conf 中按实际网络配置 external-ip。
EOF
}

do_down() {
  log "停止并移除容器（台账与 .env 保留）..."
  (cd "$ROOT_DIR" && "${COMPOSE[@]}" -f "$COMPOSE_FILE" down --remove-orphans)
  log "已停止。重新部署：bash deploy.sh"
}

do_status() {
  (cd "$ROOT_DIR" && "${COMPOSE[@]}" -f "$COMPOSE_FILE" ps)
  echo
  log "健康探测："
  curl -fsS --max-time 5 http://127.0.0.1:3004/svc/health 2>/dev/null | head -c 300 && echo || warn "signaling /svc/health 不可达"
  curl -fsS --max-time 5 -o /dev/null -w "web /api/ice-config -> HTTP %{http_code}\n" http://127.0.0.1:3000/api/ice-config 2>/dev/null || warn "web /api/ice-config 不可达"
}

do_restart() {
  (cd "$ROOT_DIR" && "${COMPOSE[@]}" -f "$COMPOSE_FILE" restart "$@")
}

do_backup() {
  [ -d "$ROOT_DIR/db/ledger" ] || die "未找到 $ROOT_DIR/db/ledger"
  mkdir -p "$BACKUP_DIR"
  local out="$BACKUP_DIR/ledger-$(date '+%Y%m%d-%H%M%S').tar.gz"
  tar -czf "$out" -C "$ROOT_DIR" db/ledger
  log "台账已备份：$out"
}

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ------------------------------ 入口 ------------------------------------------
case "${1:-up}" in
  help|-h|--help) usage ;;                          # 帮助/备份无需 docker 环境
  backup)  do_backup ;;
  up)
    check_prereq
    TURN_REST=0
    shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --turn-rest) TURN_REST=1 ;;
        *) die "未知参数：$1（用法：bash deploy.sh up [--turn-rest]）" ;;
      esac
      shift
    done
    do_up
    ;;
  logs)    check_prereq; shift || true; (cd "$ROOT_DIR" && "${COMPOSE[@]}" -f "$COMPOSE_FILE" logs -f --tail=100 "$@") ;;
  down)    check_prereq; do_down ;;
  status)  check_prereq; do_status ;;
  restart) check_prereq; shift || true; do_restart "$@" ;;
  *)       die "未知子命令：$1（可用：up [--turn-rest] | logs [service] | down | status | restart | backup | help）" ;;
esac
