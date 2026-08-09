#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
用法：
  npm run server
  ./start-cloudex.sh

可选环境变量：
  AUTH_TOKEN  API 访问 Bearer Token；省略时复用或生成项目内持久化 Token。
  CLOUDEX_AUTH_TOKEN_FILE  Token 文件路径；默认是项目目录下的 .cloudex-state/auth-token。
  HOST        Cloudex 监听地址，默认 0.0.0.0。
  PORT        Cloudex 监听端口，默认 8890。
  CODEX_BIN   Codex CLI 路径；默认使用 PATH 中的 codex。
  CLOUDEX_AGENT_PROVIDER  codex、qwen、claude、both 或 all；未设置时自动检测。
  QWEN_BIN   Qwen Code CLI 路径；Qwen 模式默认使用 PATH 中的 qwen。
  CLAUDE_BIN Claude Code CLI 路径；Claude 模式默认使用 PATH 中的 claude。
EOF
  exit 0
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"
CODEX_BIN="${CODEX_BIN:-$HOME/.codex/packages/standalone/current/bin/codex}"
QWEN_BIN="${QWEN_BIN:-$(command -v qwen 2>/dev/null || true)}"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
if [[ -z "$CLAUDE_BIN" && "$(uname -s)" == "Darwin" ]]; then
  CLAUDE_BIN="$(find "$HOME/Library/Application Support/Claude-3p/claude-code" -path '*/claude.app/Contents/MacOS/claude' -type f -perm -111 -print 2>/dev/null | sort | tail -1)"
fi
if [[ -n "${CLOUDEX_AGENT_PROVIDER:-}" ]]; then
  AGENT_PROVIDER="$CLOUDEX_AGENT_PROVIDER"
elif [[ -n "$QWEN_BIN" && -x "$QWEN_BIN" && -n "$CLAUDE_BIN" && -x "$CLAUDE_BIN" ]]; then
  AGENT_PROVIDER="all"
elif [[ -n "$QWEN_BIN" && -x "$QWEN_BIN" ]]; then
  AGENT_PROVIDER="both"
elif [[ -n "$CLAUDE_BIN" && -x "$CLAUDE_BIN" ]]; then
  AGENT_PROVIDER="claude"
else
  AGENT_PROVIDER="codex"
fi
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8890}"
AUTH_TOKEN_FILE="${CLOUDEX_AUTH_TOKEN_FILE:-$PROJECT_DIR/.cloudex-state/auth-token}"

if [[ "$AGENT_PROVIDER" == "qwen" || "$AGENT_PROVIDER" == "both" || "$AGENT_PROVIDER" == "all" ]]; then
  if [[ -z "$QWEN_BIN" || ! -x "$QWEN_BIN" ]]; then
    echo "找不到 Qwen Code CLI：${QWEN_BIN:-qwen}" >&2
    echo "请先安装 Qwen Code，或通过 QWEN_BIN 指定可执行文件路径。" >&2
    exit 1
  fi
fi
if [[ "$AGENT_PROVIDER" == "claude" || "$AGENT_PROVIDER" == "all" ]]; then
  if [[ -z "$CLAUDE_BIN" || ! -x "$CLAUDE_BIN" ]]; then
    echo "找不到 Claude Code CLI：${CLAUDE_BIN:-claude}" >&2
    exit 1
  fi
fi
if [[ "$AGENT_PROVIDER" == "codex" || "$AGENT_PROVIDER" == "both" ]] && [[ ! -x "$CODEX_BIN" ]]; then
  echo "找不到 standalone Codex CLI：$CODEX_BIN" >&2
  echo "请先安装 Codex，或通过 CODEX_BIN 指定可执行文件路径。" >&2
  exit 1
fi

if [[ -z "${AUTH_TOKEN:-}" ]]; then
  mkdir -p "$(dirname "$AUTH_TOKEN_FILE")"
  if [[ -f "$AUTH_TOKEN_FILE" ]]; then
    AUTH_TOKEN="$(<"$AUTH_TOKEN_FILE")"
    echo "未设置 AUTH_TOKEN，已复用项目内保存的 Token。"
  else
    umask 077
    AUTH_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
    printf '%s\n' "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
    echo "未设置 AUTH_TOKEN，已生成并保存项目内 Token。"
  fi
  export AUTH_TOKEN
fi

export HOST PORT AUTH_TOKEN CODEX_BIN QWEN_BIN CLAUDE_BIN CLOUDEX_AGENT_PROVIDER

SERVER_PID=""
cleanup() {
  [[ -z "$SERVER_PID" ]] && return
  echo
  echo "正在停止 Cloudex 服务…"
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$PROJECT_DIR"

if [[ "$AGENT_PROVIDER" == "qwen" || "$AGENT_PROVIDER" == "claude" ]]; then
  if [[ "$AGENT_PROVIDER" == "claude" ]]; then
    echo "==> 使用 Claude Code provider：$CLAUDE_BIN"
  else
    echo "==> 使用 Qwen Code provider：$QWEN_BIN"
  fi
else
  echo "==> 启动 API-only Codex App Server daemon"
  if ! BOOTSTRAP_OUTPUT="$("$CODEX_BIN" app-server daemon bootstrap 2>&1)"; then
  echo "$BOOTSTRAP_OUTPUT"
  if [[ "$BOOTSTRAP_OUTPUT" == *"app server is running but is not managed by codex app-server daemon"* ]]; then
    echo "检测到 Codex app server 已经在运行，继续复用当前实例。"
  else
    exit 1
  fi
  elif [[ -n "$BOOTSTRAP_OUTPUT" ]]; then
    echo "$BOOTSTRAP_OUTPUT"
  fi
fi

echo "==> 启动 Cloudex 服务器：http://$HOST:$PORT"
npm run server &
SERVER_PID=$!
echo "Cloudex API 已启动，按 Ctrl+C 停止。"
wait "$SERVER_PID"
