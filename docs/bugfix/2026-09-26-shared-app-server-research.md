# Cloudex 与 Codex Desktop 共用 app-server：研究结果

日期：2026-09-26。结论：**协议层可行；当前 Desktop 实例尚未改接共享服务，不能宣称完整接入已验收。**

## 1. 本机实际架构与版本

| 客户端 | 后端 | 版本 |
| --- | --- | --- |
| Desktop | `/Applications/ChatGPT.app/Contents/Resources/codex`，由 Desktop 启动，通过 stdio 通信 | `0.155.0-alpha.16.4` |
| Cloudex | `codex app-server proxy` → Unix control socket → 独立托管 daemon | 本次运行中的 daemon `0.157.1`；研究时 CLI `0.157.0` |

两者访问同一个用户的持久化会话，却不属于同一个 app-server。之前只记录 CLI `0.157.0` 作为整体基线不充分，升级兼容检查必须分别记录 Desktop 内置二进制、CLI 和运行中的 daemon 版本。

本机 Desktop 进程的 Unix FD 未发现可供外部连接的命名监听 socket；无法直接把 Cloudex 指向当前 Desktop 进程的 stdio。

## 2. 切换会话为何不立即释放

从当前安装的 `app.asar` 只读检查可见，Desktop 的后台 owner 会话回收逻辑包含：

- `fy=108e5`：空闲阈值 10,800,000 ms，即 3 小时。
- `py=10`：符合回收候选条件的普通后台 owner 会话超过 10 个时可提前回收较旧项。
- 活跃视图、有 follower、运行中或等待交互等情况会影响回收资格。

这解释了日志中切换页面后 `active=false`、`streamRole=owner` 仍然存在的现象。不是保证所有任务恰好 3 小时后释放，也不能把 `owner` 日志字段单独当成当前 OS writer 锁的完整证明。

证据位置：安装包 `.vite/build/main-C-Mhak1n.js` 中 `getNextCheckAtMs`、`getInactiveOwnerConversationIdsToUnsubscribe`、`shouldKeepConversationLoaded`。这些文件名和私有逻辑可能随 Desktop 更新改变。

## 3. Desktop 存在 WebSocket 接入路径

安装包 `.vite/build/src-DldfpmrL.js` 的 `wQ` 函数读取 `CODEX_APP_SERVER_WS_URL`，否则使用主机配置 `websocket_url`；`CODEX_APP_SERVER_FORCE_CLI=1` 会绕过该路径。主程序通过 `W5` 选择相应 transport，WebSocket transport 支持重连。

这属于当前安装包中发现的入口，不是经过官方文档保证的稳定配置接口。本轮已通过本机 LaunchAgent 为**下次启动的** Desktop 设置环境变量；没有改应用包或重启当前 Desktop。

## 4. 隔离双客户端实测

可运行脚本：[probes/shared-app-server.mjs](probes/shared-app-server.mjs)。要求 Node.js 支持内置 WebSocket（本机 Node 可运行）。

```sh
node docs/bugfix/probes/shared-app-server.mjs
node docs/bugfix/probes/shared-app-server.mjs /Applications/ChatGPT.app/Contents/Resources/codex
node docs/bugfix/probes/shared-app-server.mjs /Users/pans0020/.local/bin/codex --unix-bridge
node docs/bugfix/probes/shared-app-server.mjs /Applications/ChatGPT.app/Contents/Resources/codex --unix-bridge
```

每次创建独立临时 `CODEX_HOME` 和 cwd，启动仅监听 `127.0.0.1` 的测试 app-server 与本地 Responses SSE 模拟服务；不读取真实会话，不调用付费模型。测试目录保留在输出的 `root` 路径，便于排查；结束时关闭测试连接、测试进程及模拟服务。

| 检查项 | CLI 0.157.0 | Desktop 二进制 0.155.0-alpha.16.4 |
| --- | --- | --- |
| A 创建会话并完成首轮，B resume 同一 ID | 通过 | 通过 |
| A 仍订阅时，B 发起回合并完成 | 通过 | 通过 |
| A 与 B 均收到 B 回合的完成事件 | 通过 | 通过 |
| B unsubscribe 后 A 发起下一轮并完成 | 通过 | 通过 |

每次运行 3 次本地模拟模型请求，均返回 completed。测试没有模拟整个 Desktop UI，也没有覆盖审批、工具调用或同时提交两个 turn。

补充实测：CLI `0.157.0` 通过了 `--unix-bridge` 模式，测试用本机 TCP 字节桥将 WebSocket 握手和帧转发到隔离 app-server 的 Unix socket，上述四项检查同样通过。Desktop 二进制的自定义 Unix socket 模式未连接成功，不能宣称通过；两版直接 WebSocket 测试均通过。该桥仅为隔离测试原型，没有接入真实 daemon，不具备生产鉴权/Origin 校验。

第一次使用无历史的 ephemeral 会话时 B resume 返回 `no rollout found`；最终测试使用写入临时目录的正常会话，并先完成首轮。跨客户端处理新建、尚未落盘的会话需要额外回归，不能据此宣称 ephemeral 可共享。

## 5. 推荐接入设计

让 Desktop 和 Cloudex 连接**同一个长驻 app-server 进程**。不删除锁、不强抢现有 writer。

路径 A：共享 app-server 监听本机 WebSocket，Desktop 使用上述入口；Cloudex 增加直接 WebSocket transport。需要处理共享服务的启动管理，以及 Desktop 原来通过 CLI 参数传入的工具/运行环境配置。

路径 B 已在本机实施：`apps/server/bin/desktop-bridge.js` 监听 `127.0.0.1:8891`，检查 URL 中的随机令牌，再把 WebSocket 字节流转发到当前 daemon 的 Unix control socket。令牌只保存在 Git 忽略的 `.cloudex-state/desktop-bridge-token`，权限为 `0600`。`~/Library/LaunchAgents/com.pans0020.cloudex-desktop-bridge.plist` 在登录时启动桥，桥启动后通过 `launchctl setenv CODEX_APP_SERVER_WS_URL` 为之后启动的 Desktop 提供地址。手机仍走原 Cloudex HTTP/SSE 接口，不直接连接此桥。

本机验证：错误令牌返回 403；合法连接的握手及双向帧转发单测通过；对真实 daemon 的只读 `initialize` 成功，且连接维持正常。测试客户端主动关闭时收到 1006，仍需在 Desktop GUI 连接后观察关闭/重连行为。当前运行的 Desktop 仍用原 stdio 后端，所以共享 writer 的最终效果尚未验收。

这套 LaunchAgent 含本机绝对路径，不会随 Git 自动安装到另一台 Mac。迁移时须按该 plist 的 `ProgramArguments`、`WorkingDirectory`、`RunAtLoad`、`KeepAlive`、`EnvironmentVariables` 配置新的用户级 LaunchAgent，并确保 `node`、仓库和 daemon socket 路径正确。桥只应监听 loopback，令牌不能放进仓库、日志或公网代理。回滚时退出 Desktop、卸载该 LaunchAgent、执行 `launchctl unsetenv CODEX_APP_SERVER_WS_URL`，再启动 Desktop；无需删除历史会话。若桥停止但覆盖变量仍在，Desktop 下次启动可能连不上服务，先检查桥状态或按上述步骤回滚。

## 6. 正式切换前必须验证

1. Desktop 通过 WebSocket 成功初始化并显示真实会话；所需实验协议与二进制版本相容。
2. 手机发起任务时审批/用户输入路由正确，Desktop 的 codex-app-tools、code-mode-host、工作区权限仍可用。
3. Desktop 发起与手机发起两种方向均能看到完整事件；手机取消订阅不会卸载 Desktop 正在使用的会话。
4. 重连、后台恢复、同一会话同时点击发送、新建未落盘会话，均有确定行为。
5. 有明确回滚：取消连接覆盖并恢复原启动方式即可；不改历史文件。

切换现有 Desktop 必须让它重新建立连接，通常需要一次重启，运行中的任务应先结束。本轮没有中断当前 Desktop；只有重启后完成上面的 GUI 验收，才能称 writer 冲突已通过共享服务解决。
