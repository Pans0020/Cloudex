#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
cloudex_node="$(command -v node || true)"
if [[ -z "$cloudex_node" ]]; then
  for candidate in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then cloudex_node="$candidate"; break; fi
  done
fi
if [[ -z "$cloudex_node" ]]; then
  print "未找到 Node.js，请先安装 Node.js。"
  exit 1
fi
print "即将正常退出并重新打开 Codex Desktop，连接共享 app-server。"
exec "$cloudex_node" apps/server/bin/connect-desktop.js --restart
