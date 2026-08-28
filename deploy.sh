#!/usr/bin/env bash
#
# voice-conversation-demo 云服务器部署脚本 (Ubuntu/Debian)
#
# 用法:
#   chmod +x deploy.sh
#   sudo DOMAIN=your.domain.com ./deploy.sh          # 首次完整部署
#   sudo DOMAIN=your.domain.com ./deploy.sh deploy   # 更新代码后重新部署
#   sudo ./deploy.sh restart                         # 重启服务
#   ./deploy.sh status                               # 查看状态
#
# 部署前请确保:
#   1. 已安装 git，并将本项目放到服务器 (如 /opt/voice-conversation-demo)
#   2. 已配置 backend/.env (至少 OPENAI_API_KEY)
#   3. 域名已解析到本机 (若使用 HTTPS)
#   4. 生产环境需 HTTPS，浏览器才允许使用麦克风 (非 localhost)
#
set -euo pipefail

APP_NAME="voice-conversation-demo"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"
VENV_DIR="${BACKEND_DIR}/.venv"
ENV_FILE="${BACKEND_DIR}/.env"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
BACKEND_WORKERS="${BACKEND_WORKERS:-2}"
DOMAIN="${DOMAIN:-}"
PUBLIC_PORT="${PUBLIC_PORT:-80}"
SKIP_NGINX="${SKIP_NGINX:-0}"
GIT_PULL="${GIT_PULL:-1}"

SYSTEMD_UNIT="/etc/systemd/system/${APP_NAME}.service"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "缺少命令: $1"
    exit 1
  fi
}

require_root_for_system() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "此操作需要 root 权限，请使用: sudo $0 $*"
    exit 1
  fi
}

check_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    err "未找到 ${ENV_FILE}"
    err "请先复制 backend/.env.example 并填入 OPENAI_API_KEY 等配置"
    exit 1
  fi

  if ! grep -qE '^OPENAI_API_KEY=.+$' "${ENV_FILE}"; then
    err "${ENV_FILE} 中未配置有效的 OPENAI_API_KEY"
    exit 1
  fi
}

install_system_packages() {
  require_root_for_system
  log "安装系统依赖 (python3-venv, nginx, curl)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 python3-venv python3-pip nginx curl ca-certificates
}

setup_backend() {
  log "配置 Python 后端..."
  require_cmd python3

  if [[ ! -d "${VENV_DIR}" ]]; then
    python3 -m venv "${VENV_DIR}"
  fi

  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
  pip install -q --upgrade pip
  pip install -q -r "${BACKEND_DIR}/requirements.txt"
  deactivate
}

setup_frontend() {
  log "构建前端..."
  require_cmd node
  require_cmd npm

  pushd "${FRONTEND_DIR}" >/dev/null
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
  popd >/dev/null

  if [[ ! -f "${FRONTEND_DIR}/dist/index.html" ]]; then
    err "前端构建失败: 未找到 frontend/dist/index.html"
    exit 1
  fi
}

write_systemd_unit() {
  require_root_for_system
  log "写入 systemd 服务: ${SYSTEMD_UNIT}"

  cat >"${SYSTEMD_UNIT}" <<EOF
[Unit]
Description=OpenAI Realtime Demo API
After=network.target

[Service]
Type=simple
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${VENV_DIR}/bin/uvicorn main:app --host ${BACKEND_HOST} --port ${BACKEND_PORT} --workers ${BACKEND_WORKERS}
Restart=always
RestartSec=3

# 安全加固 (可按需调整)
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${APP_NAME}"
  systemctl restart "${APP_NAME}"
}

write_nginx_site() {
  require_root_for_system

  if [[ -z "${DOMAIN}" ]]; then
    warn "未设置 DOMAIN，将使用服务器 IP / _ 作为 Nginx server_name"
    DOMAIN="_"
  fi

  log "写入 Nginx 配置: ${NGINX_SITE}"

  cat >"${NGINX_SITE}" <<EOF
server {
    listen ${PUBLIC_PORT};
    server_name ${DOMAIN};

    root ${FRONTEND_DIR}/dist;
    index index.html;

    # 前端静态资源
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # 后端 API (SDP 握手)
    location /api/ {
        proxy_pass http://${BACKEND_HOST}:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }
}
EOF

  ln -sf "${NGINX_SITE}" "${NGINX_LINK}"
  nginx -t
  systemctl reload nginx
}

deploy_app() {
  log "开始部署 ${APP_NAME} ..."
  log "项目目录: ${ROOT_DIR}"

  if [[ "${GIT_PULL}" == "1" ]] && [[ -d "${ROOT_DIR}/.git" ]]; then
    log "拉取最新代码..."
    git -C "${ROOT_DIR}" pull --ff-only
  fi

  check_env_file
  setup_backend
  setup_frontend

  if [[ "${SKIP_NGINX}" == "1" ]]; then
    warn "SKIP_NGINX=1，跳过 Nginx/systemd 配置"
    warn "请手动运行后端:"
    warn "  cd ${BACKEND_DIR} && source .venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port ${BACKEND_PORT}"
    warn "并用 Nginx/Caddy 托管 ${FRONTEND_DIR}/dist"
    return
  fi

  install_system_packages
  write_systemd_unit
  write_nginx_site

  log "部署完成"
  echo ""
  if [[ "${DOMAIN}" != "_" ]]; then
    echo "  访问地址: http://${DOMAIN}"
    echo "  HTTPS:    建议执行 certbot --nginx -d ${DOMAIN}  (WebRTC 麦克风需要 HTTPS)"
  else
    echo "  访问地址: http://<你的服务器IP>"
    echo "  HTTPS:    生产环境请配置域名 + SSL 证书"
  fi
  echo "  健康检查: curl http://127.0.0.1:${BACKEND_PORT}/api/health"
  echo ""
}

restart_services() {
  require_root_for_system
  systemctl restart "${APP_NAME}"
  if command -v nginx >/dev/null 2>&1; then
    nginx -t && systemctl reload nginx
  fi
  log "服务已重启"
}

show_status() {
  echo "=== systemd: ${APP_NAME} ==="
  if systemctl is-active "${APP_NAME}" >/dev/null 2>&1; then
    systemctl status "${APP_NAME}" --no-pager -l || true
  else
    warn "服务未运行或未安装"
  fi

  echo ""
  echo "=== 健康检查 ==="
  if curl -fsS "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" 2>/dev/null; then
    echo ""
  else
    warn "后端 /api/health 不可达"
  fi
}

usage() {
  cat <<EOF
用法: $0 [command]

命令:
  deploy    完整部署 (默认)
  restart   重启后端与 Nginx
  status    查看运行状态
  help      显示帮助

常用环境变量:
  DOMAIN=voice.example.com   域名 (写入 Nginx server_name)
  BACKEND_PORT=8000          后端端口
  BACKEND_WORKERS=2          uvicorn worker 数
  GIT_PULL=0                 部署时不 git pull
  SKIP_NGINX=1               只构建，不写 systemd/Nginx

示例:
  sudo DOMAIN=voice.example.com ./deploy.sh
  sudo ./deploy.sh restart
EOF
}

main() {
  local cmd="${1:-deploy}"

  case "${cmd}" in
    deploy)
      deploy_app
      ;;
    restart)
      restart_services
      ;;
    status)
      show_status
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      err "未知命令: ${cmd}"
      usage
      exit 1
      ;;
  esac
}

main "$@"
