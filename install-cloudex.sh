#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
用法：curl -fsSL https://raw.githubusercontent.com/Pans0020/Cloudex/fix/codex-session-history/install-cloudex.sh | bash

需要 macOS/Linux、Git、Node.js >= 22、npm，以及已安装并登录的 Codex CLI。
默认安装到 ~/.local/share/cloudex，使用 Tailscale 或局域网地址配对。
可设置 CLOUDEX_INSTALL_DIR、FILE_ROOTS、PORT；有 HTTPS 反向代理时可设置 CLOUDEX_PUBLIC_URL。
EOF
  exit 0
fi

[[ "$(uname -s)" == "Darwin" || "$(uname -s)" == "Linux" ]] || {
  echo "此安装脚本仅支持 macOS/Linux；Windows 请使用 start-cloudex.ps1。" >&2
  exit 1
}
for command in git node npm curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "缺少 $command，请先安装。" >&2; exit 1; }
done
(( $(node -p 'Number(process.versions.node.split(".")[0])') >= 22 )) || {
  echo "需要 Node.js >= 22。" >&2
  exit 1
}

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

PORT="${PORT:-8890}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || {
  echo "PORT 必须是 1 到 65535 的端口号。" >&2
  exit 1
}
export PORT

if [[ -n "${CLOUDEX_PUBLIC_URL:-}" ]]; then
  [[ "$CLOUDEX_PUBLIC_URL" == https://* ]] || {
    echo "CLOUDEX_PUBLIC_URL 必须是 HTTPS 地址；公网 HTTP 会暴露配对 Token。" >&2
    exit 1
  }
  HOST="${HOST:-127.0.0.1}"
else
  HOST="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -z "$HOST" ]]; then
    HOST="$(node -e '
      const os = require("node:os");
      const interfaces = Object.entries(os.networkInterfaces());
      const preferred = ["en0", "en1", "eth0", "wlan0"];
      const rank = (name) => preferred.indexOf(name) < 0 ? preferred.length : preferred.indexOf(name);
      interfaces.sort(([a], [b]) => rank(a) - rank(b));
      for (const [name, addresses] of interfaces) {
        if (/^(docker|veth|br-|virbr|podman|lo)/.test(name)) continue;
        for (const item of addresses || []) {
          const ip = item.address;
          if (item.family === "IPv4" && !item.internal &&
              (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip))) {
            console.log(ip);
            process.exit();
          }
        }
      }
    ')"
  fi
  [[ -n "$HOST" ]] || {
    echo "没有检测到 Tailscale 或局域网地址。请先配置 Tailscale，或设置 HTTPS 的 CLOUDEX_PUBLIC_URL 和反向代理。" >&2
    exit 1
  }
fi
export HOST

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

file_roots="${FILE_ROOTS:-$PWD}"
cd "$install_dir"
export FILE_ROOTS="$file_roots"
export CLOUDEX_AGENT_PROVIDER="${CLOUDEX_AGENT_PROVIDER:-codex}"
if [[ ! -d node_modules/qrcode-terminal ]]; then
  npm ci --omit=dev --no-audit --no-fund
fi

auth_file="${CLOUDEX_AUTH_TOKEN_FILE:-${CLOUDEX_STATE_DIR:-$install_dir/.cloudex-state}/auth-token}"
health() {
  local token="${AUTH_TOKEN:-}"
  if [[ -z "$token" && -f "$auth_file" ]]; then
    token="$(<"$auth_file")"
  fi
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
  echo "Cloudex 未能启动；请检查 $install_dir/.cloudex-state/server.stderr.log。" >&2
  exit 1
}

echo "Cloudex 已运行；手机需与这台机器处于同一局域网或 Tailscale 网络。"
echo "文件浏览范围：$FILE_ROOTS"
echo "重启机器后可再次运行此命令；停止服务：cd '$install_dir' && node apps/server/bin/cloudex.js stop"
node apps/server/bin/cloudex.js pair
