# Cloudex 原生玻璃视觉

用户选择：原生玻璃感。浅色通透，深色沉稳；避免大面积蓝色、不透明的蓝框，以及为了装饰增加滚动模糊和阴影。

## 视觉来源

通过 `imagegen-codex-cli` 的独立 Codex CLI 子任务调用内置 `image_gen` 生成参考图。提示词见 [glass-ui-prompt.md](glass-ui-prompt.md)，生成结果见 [cloudex-glass-concept.png](cloudex-glass-concept.png)。默认的 Desktop CLI 路径不可用，使用 runner 支持的 `CODEX_CLI_BIN` 指向本机已安装 CLI；没有改动认证配置，也没有调用独立图片 API。

第 9 版首页采用用户确认的[新版首页参考](cloudex-home-concept-v2-edited.png)，并删除收起项目中的“轻点展开对话”。生成与修改提示词分别见 [cloudex-home-v2-prompt.md](cloudex-home-v2-prompt.md) 和 [cloudex-home-v3-prompt.md](cloudex-home-v3-prompt.md)；生图工具未返回具体模型名。

参考图是视觉探索，不是运行截图。实际界面保留 Cloudex 已有功能，不把图中的示例服务器、版本号或虚构功能加入产品。运行时不加载这张大图，也不把文字和按钮烘焙到位图中。

## 实现

- `CloudexTheme.swift` 集中定义暖白/炭灰背景、表面、冰青强调色、边线和按钮反色；UIKit 聊天背景使用同一个动态颜色。
- 首页：暖白背景、左对齐标题、连接胶囊和独立设置按钮；项目标题与实际数量形成清楚层级。项目字母标识保留 44 pt 图标区，收起时只显示名称、会话数量和箭头，展开后显示新对话与会话列表。会话行采用文档/运行图标、时间、状态和选中底色。继续使用原生 List 承载滚动与滑动操作。
- 大字号：正文与输入文字随系统缩放，装饰图标保持稳定尺寸；搜索框采用最小高度而非固定高度，防止最大辅助字号裁切。连接菜单的辅助功能值包含完整服务器名称和连接状态。
- 会话：20 pt 圆角的中性回复卡片、轻微青色用户气泡、统一角色图标、独立过程卡片；聊天文字保持系统字号和可选择文本。
- 子智能体（第 11 版）：主会话顶部保留紧凑的彩色头像组、子树数量和状态计数。点开原生列表查看直属子智能体，再进入只读会话；更深的子智能体沿同一入口查看。失败、中断、关闭、等待和未知状态各自显示，只有明确完成才计入完成数。列表和详情均有 44 pt 关闭入口，保留系统返回操作。
- 消息编辑（第 12 版）：已发送的用户消息增加铅笔入口，原生编辑页预填文字与附件，提供取消、移除附件和重新发送。原输入栏草稿不用于承载编辑内容。发送失败在编辑页保留内容；已有分支可查看或继续发送，结果未确认时先核对历史。新分支替换当前导航位置，返回目录后可重新打开原会话。
- 输入区：附件、语音、模型、权限仍在上排，输入与发送仍在下排；聚焦通过细边线提示。发送按钮适配深色，附件保留固定高度占位。
- 设置：扫码仍在第一组首行，服务器使用统一图标块，连接/通知/构建信息分组，增加明确的“完成”按钮。
- 文件页面：目录图标、列表底色与卡片密度统一；不改变文件操作与审阅协议。
- 透明度降低或对比度提高时，固定玻璃控件回退为实色表面和可辨边线。列表中的卡片使用轻量填充，不为每个 cell 增加实时模糊或阴影。

## 验证

`testGlassAppearanceInLightAndDark` 保存首页收起/展开、设置、会话的两套运行截图；已有输入框与键盘、快速滑动、底部留白、过程展开和缓存一致性用例同时验证。最终结果以当天 bugfix 记录为准；生成参考图不替代实际 UI 验证。

最终模拟器运行截图（缩小保存，iOS 27.0）：

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 首页（第 9 版展开） | [查看](screenshots/home9-light-home-expanded.png) | [查看](screenshots/home9-dark-home-expanded.png) |
| 首页（第 9 版收起） | [查看](screenshots/home9-light-home-collapsed.png) | [查看](screenshots/home9-dark-home-collapsed.png) |
| 对话 | [查看](screenshots/light-conversation.png) | [查看](screenshots/dark-conversation.png) |
| 设置 | [查看](screenshots/light-settings.png) | [查看](screenshots/dark-settings.png) |

第 9 版的最大辅助字号[运行截图](screenshots/home9-light-large-text.png)。以上首页截图使用模拟器测试数据；不是生成概念图或真机截图。

第 11 版子智能体实际模拟器截图：[主会话入口](screenshots/subagents11-parent.png)、[状态列表](screenshots/subagents11-directory.png)、[活动详情](screenshots/subagents11-child.png)、[嵌套详情](screenshots/subagents11-nested.png)、[完成状态更新](screenshots/subagents11-completed.png)。截图使用隔离测试数据。

第 12 版消息编辑实际模拟器截图：[编辑页](screenshots/edit12-editor.png)、[修改后的分支](screenshots/edit12-branch.png)、[失败后保留内容](screenshots/edit12-retry.png)、[核对未确认结果](screenshots/edit12-unconfirmed.png)。
