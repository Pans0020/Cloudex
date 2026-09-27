#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
用法：curl -fsSL https://raw.githubusercontent.com/Pans0020/Cloudex/fix/codex-session-history/install-cloudex.sh | bash
只检查：bash install-cloudex.sh --check

需要 macOS/Linux、Git、Node.js >= 22、npm，以及已安装并登录的 Codex CLI。
默认安装到 ~/.local/share/cloudex，FILE_ROOTS=/；优先使用 Tailscale，其次使用已有证书的公网 HTTPS 或局域网。
可设置 CLOUDEX_INSTALL_DIR、FILE_ROOTS、PORT；有自建 HTTPS 反向代理时可设置 CLOUDEX_PUBLIC_URL。
EOF
  exit 0
fi
check_only=false
if [[ "${1:-}" == "--check" ]]; then check_only=true; fi

[[ "$(uname -s)" == "Darwin" || "$(uname -s)" == "Linux" ]] || {
  echo "此安装脚本仅支持 macOS/Linux；Windows 请使用 start-cloudex.ps1。" >&2
  exit 1
}
for command in git curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "缺少 ${command}，请先安装。" >&2; exit 1; }
done
node_major() { "$1" -p 'Number(process.versions.node.split(".")[0])'; }
if ! command -v node >/dev/null 2>&1 || (( $(node_major "$(command -v node)") < 22 )); then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]] && (( $(node_major "$candidate") >= 22 )); then
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi
command -v node >/dev/null 2>&1 && (( $(node_major "$(command -v node)") >= 22 )) || {
  echo "需要 Node.js >= 22。" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || { echo "找不到 npm，请确认 Node.js 安装完整。" >&2; exit 1; }

CODEX_BIN="${CODEX_BIN:-${CODEX_CLI_PATH:-}}"
if [[ -z "$CODEX_BIN" ]]; then
  CODEX_BIN="$(command -v codex || true)"
fi
if [[ -z "$CODEX_BIN" ]]; then
  CODEX_BIN="$HOME/.codex/packages/standalone/current/bin/codex"
fi
[[ -x "$CODEX_BIN" ]] && "$CODEX_BIN" --version >/dev/null || {
  echo "找不到可用的 Codex CLI；请先安装、登录，或通过 CODEX_BIN 指定路径。" >&2
  exit 1
}
export CODEX_BIN

network_mode=""
public_ip=""
tls_certificate=""
if [[ -n "${CLOUDEX_PUBLIC_URL:-}" ]]; then
  [[ "$CLOUDEX_PUBLIC_URL" == https://* ]] || {
    echo "CLOUDEX_PUBLIC_URL 必须是 HTTPS 地址；公网 HTTP 会暴露配对 Token。" >&2
    exit 1
  }
  HOST="${HOST:-127.0.0.1}"
  network_mode="custom-https"
else
  HOST="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -n "$HOST" ]]; then
    network_mode="tailscale"
  else
    read -r lan_ip public_ip < <(node -e '
      const os = require("node:os");
      const interfaces = Object.entries(os.networkInterfaces());
      const preferred = ["en0", "en1", "eth0", "wlan0"];
      const rank = (name) => preferred.indexOf(name) < 0 ? preferred.length : preferred.indexOf(name);
      interfaces.sort(([a], [b]) => rank(a) - rank(b));
      let lan = "-", publicIP = "-";
      for (const [name, addresses] of interfaces) {
        if (/^(docker|veth|br-|virbr|podman|lo)/.test(name)) continue;
        for (const item of addresses || []) {
          const ip = item.address;
          if (item.family !== "IPv4" || item.internal) continue;
          const [a, b] = ip.split(".").map(Number);
          const privateIP = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
          if (privateIP && lan === "-") lan = ip;
          else if (!privateIP && !(a === 100 && b >= 64 && b <= 127) &&
                   a !== 0 && a !== 127 && a !== 169 && a < 224 && publicIP === "-") publicIP = ip;
        }
      }
      console.log(lan, publicIP);
    ')
    if [[ "$public_ip" != "-" ]] && command -v openssl >/dev/null 2>&1 && command -v nginx >/dev/null 2>&1; then
      for certificate in /etc/letsencrypt/live/*/fullchain.pem; do
        if [[ -f "$certificate" ]] && openssl x509 -in "$certificate" -noout -checkip "$public_ip" >/dev/null 2>&1; then
          tls_certificate="$certificate"
          break
        fi
      done
    fi
    if [[ -n "$tls_certificate" ]]; then
      [[ "$EUID" -eq 0 ]] || { echo "公网 HTTPS 自动配置需要以 root 运行。" >&2; exit 1; }
      HOST="127.0.0.1"
      network_mode="public-https"
    elif [[ "$lan_ip" != "-" ]]; then
      HOST="$lan_ip"
      network_mode="lan"
    else
      echo "仅检测到公网地址，但没有找到匹配该 IP 的 HTTPS 证书与 Nginx。请先配置证书/代理，或使用 Tailscale。" >&2
      exit 1
    fi
  fi
fi
export HOST
if "$check_only"; then
  echo "Node $(node --version), npm $(npm --version), Codex $("$CODEX_BIN" --version)"
  echo "网络模式：${network_mode}；监听地址：$HOST"
  if [[ "$network_mode" == "public-https" ]]; then
    echo "公网 IP：${public_ip}；匹配证书：$tls_certificate"
  fi
  exit 0
fi

install_dir="${CLOUDEX_INSTALL_DIR:-$HOME/.local/share/cloudex}"
mkdir -p "$(dirname "$install_dir")"
install_dir="$(cd "$(dirname "$install_dir")" && pwd)/$(basename "$install_dir")"
repo_url="https://github.com/Pans0020/Cloudex.git"
repo_ref="fix/codex-session-history"
if [[ -e "$install_dir" ]]; then
  [[ "$(git -C "$install_dir" remote get-url origin 2>/dev/null || true)" == "$repo_url" ]] || {
    echo "安装目录已存在且不是 Cloudex 仓库：$install_dir" >&2
    exit 1
  }
else
  git clone --depth 1 --single-branch --branch "$repo_ref" "$repo_url" "$install_dir"
fi

state_dir="${CLOUDEX_STATE_DIR:-$install_dir/.cloudex-state}"
mkdir -p "$state_dir"
state_dir="$(cd "$state_dir" && pwd)"
export CLOUDEX_STATE_DIR="$state_dir"

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
port_available() {
  node -e '
    const server = require("node:net").createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.argv[2]), process.argv[1], () => server.close());
  ' "$1" "$2" >/dev/null 2>&1
}
choose_port() {
  local candidate
  for (( candidate = $1; candidate < $1 + 100; candidate++ )); do
    if port_available "$2" "$candidate"; then printf '%s' "$candidate"; return; fi
  done
  echo "找不到可用端口（从 $1 开始）。" >&2
  return 1
}

if [[ "$network_mode" == "public-https" ]]; then
  saved_backend_port=""
  saved_https_port=""
  if [[ -f "$state_dir/backend-port" ]]; then saved_backend_port="$(<"$state_dir/backend-port")"; fi
  if [[ -f "$state_dir/https-port" ]]; then saved_https_port="$(<"$state_dir/https-port")"; fi
  PORT="${PORT:-${saved_backend_port:-$(choose_port 18891 127.0.0.1)}}"
  https_port="${CLOUDEX_HTTPS_PORT:-${saved_https_port:-$(choose_port 8444 0.0.0.0)}}"
  valid_port "$PORT" && valid_port "$https_port" || {
    echo "PORT 或 CLOUDEX_HTTPS_PORT 无效。" >&2
    exit 1
  }
  [[ "$PORT" != "$https_port" ]] || { echo "Cloudex 后端端口和 HTTPS 端口不能相同。" >&2; exit 1; }
  if [[ -n "$saved_backend_port" && "$PORT" != "$saved_backend_port" ]] ||
     [[ -n "$saved_https_port" && "$https_port" != "$saved_https_port" ]]; then
    echo "已有 VPS 端口配置；请不要在重跑时更换 PORT 或 CLOUDEX_HTTPS_PORT。" >&2
    exit 1
  fi
  printf '%s\n' "$PORT" > "$state_dir/backend-port"
  printf '%s\n' "$https_port" > "$state_dir/https-port"
  export CLOUDEX_PUBLIC_URL="https://$public_ip:$https_port"
else
  PORT="${PORT:-8890}"
fi
valid_port "$PORT" || { echo "PORT 必须是 1 到 65535 的端口号。" >&2; exit 1; }
export PORT

file_roots="${FILE_ROOTS:-/}"
cd "$install_dir"
export FILE_ROOTS="$file_roots"
export CLOUDEX_AGENT_PROVIDER="${CLOUDEX_AGENT_PROVIDER:-codex}"
if [[ ! -d node_modules/qrcode-terminal ]]; then
  npm ci --omit=dev --no-audit --no-fund
fi

auth_file="${CLOUDEX_AUTH_TOKEN_FILE:-$state_dir/auth-token}"
auth_token() {
  if [[ -n "${AUTH_TOKEN:-}" ]]; then printf '%s' "$AUTH_TOKEN"
  elif [[ -f "$auth_file" ]]; then printf '%s' "$(<"$auth_file")"
  fi
}
health() {
  local token
  token="$(auth_token)"
  [[ -n "$token" ]] && curl -fsS --noproxy '*' --connect-timeout 1 --max-time 2 \
    -H "Authorization: Bearer $token" "http://$HOST:$PORT/api/health"
}

if ! health >/dev/null 2>&1; then
  node apps/server/bin/cloudex.js serve
  for attempt in {1..30}; do
    if health >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
health >/dev/null || {
  echo "Cloudex 未能启动；请检查 $state_dir/server.stderr.log。" >&2
  exit 1
}

if [[ "$network_mode" == "public-https" ]]; then
  nginx_conf="/etc/nginx/conf.d/cloudex-direct.conf"
  tls_key="$(dirname "$tls_certificate")/privkey.pem"
  [[ -f "$tls_key" ]] || { echo "找不到 HTTPS 证书私钥：$tls_key" >&2; exit 1; }
  if [[ -e "$nginx_conf" ]]; then
    grep -Fq '# Managed by Cloudex install-cloudex.sh' "$nginx_conf" &&
      grep -Fq "listen $https_port ssl;" "$nginx_conf" &&
      grep -Fq "proxy_pass http://127.0.0.1:$PORT;" "$nginx_conf" || {
      echo "现有 Nginx 配置与 Cloudex 安装记录不一致：$nginx_conf" >&2
      exit 1
    }
  else
    nginx_tmp="$(mktemp /etc/nginx/conf.d/.cloudex-direct.XXXXXX)"
    printf '%s\n' \
      '# Managed by Cloudex install-cloudex.sh' \
      'server {' \
      "    listen $https_port ssl;" \
      "    server_name $public_ip;" \
      "    ssl_certificate $tls_certificate;" \
      "    ssl_certificate_key $tls_key;" \
      '    access_log off;' \
      '    client_max_body_size 25m;' \
      '    location / {' \
      "        proxy_pass http://127.0.0.1:$PORT;" \
      '        proxy_http_version 1.1;' \
      '        proxy_set_header Host $host;' \
      '        proxy_set_header Connection "";' \
      '        proxy_set_header X-Forwarded-Proto https;' \
      '        proxy_buffering off;' \
      '        proxy_read_timeout 3600s;' \
      '        proxy_send_timeout 3600s;' \
      '    }' \
      '}' > "$nginx_tmp"
    mv "$nginx_tmp" "$nginx_conf"
    if ! nginx -t; then
      rm "$nginx_conf"
      exit 1
    fi
    if ! systemctl reload nginx 2>/dev/null && ! nginx -s reload; then
      rm "$nginx_conf"
      echo "Nginx 重载失败，已移除新建的 Cloudex 配置。" >&2
      exit 1
    fi
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    ufw allow "$https_port/tcp"
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="$https_port/tcp"
    firewall-cmd --reload
  fi
  curl -fsS --noproxy '*' --max-time 5 \
    --resolve "$public_ip:$https_port:127.0.0.1" \
    -H "Authorization: Bearer $(auth_token)" \
    "$CLOUDEX_PUBLIC_URL/api/health" >/dev/null || {
    echo "本机 HTTPS 验证失败；请检查 ${nginx_conf}。" >&2
    exit 1
  }
  echo "Cloudex 公网 HTTPS 已运行；如手机无法连接，请检查 VPS 服务商的入站端口 ${https_port}。"
elif [[ "$network_mode" == "custom-https" ]]; then
  echo "Cloudex 已运行；请确认 HTTPS 代理转发到 http://$HOST:${PORT}。"
else
  echo "Cloudex 已运行；手机需与这台机器处于同一局域网或 Tailscale 网络。"
fi
echo "文件浏览范围：$FILE_ROOTS"
echo "重启机器后可再次运行此命令；停止服务：cd '$install_dir' && node apps/server/bin/cloudex.js stop"
node apps/server/bin/cloudex.js pair
