# Cloudex 原生玻璃视觉

用户选择：原生玻璃感。浅色通透，深色沉稳；避免大面积蓝色、不透明的蓝框，以及为了装饰增加滚动模糊和阴影。

## 视觉来源

通过 `imagegen-codex-cli` 的独立 Codex CLI 子任务调用内置 `image_gen` 生成参考图。提示词见 [glass-ui-prompt.md](glass-ui-prompt.md)，生成结果见 [cloudex-glass-concept.png](cloudex-glass-concept.png)。默认的 Desktop CLI 路径不可用，使用 runner 支持的 `CODEX_CLI_BIN` 指向本机已安装 CLI；没有改动认证配置，也没有调用独立图片 API。

参考图是视觉探索，不是运行截图。实际界面保留 Cloudex 已有功能，不把图中的示例服务器、版本号或虚构功能加入产品。运行时不加载这张大图，也不把文字和按钮烘焙到位图中。

## 实现

- `CloudexTheme.swift` 集中定义暖白/炭灰背景、表面、冰青强调色、边线和按钮反色；UIKit 聊天背景使用同一个动态颜色。
- 首页：项目字母标识、44 pt 图标区、明确的展开状态、会话计数、柔和卡片与选中底色；会话行统一标题、时间、运行状态与层次。
- 会话：20 pt 圆角的中性回复卡片、轻微青色用户气泡、统一角色图标、独立过程卡片；聊天文字保持系统字号和可选择文本。
- 输入区：附件、语音、模型、权限仍在上排，输入与发送仍在下排；聚焦通过细边线提示。发送按钮适配深色，附件保留固定高度占位。
- 设置：扫码仍在第一组首行，服务器使用统一图标块，连接/通知/构建信息分组，增加明确的“完成”按钮。
- 文件页面：目录图标、列表底色与卡片密度统一；不改变文件操作与审阅协议。
- 透明度降低或对比度提高时，固定玻璃控件回退为实色表面和可辨边线。列表中的卡片使用轻量填充，不为每个 cell 增加实时模糊或阴影。

## 验证

`testGlassAppearanceInLightAndDark` 保存首页收起/展开、设置、会话的两套运行截图；已有输入框与键盘、快速滑动、底部留白、过程展开和缓存一致性用例同时验证。最终结果以当天 bugfix 记录为准；生成参考图不替代实际 UI 验证。

最终模拟器运行截图（缩小保存，iOS 27.0）：

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 首页 | [查看](screenshots/light-home.png) | [查看](screenshots/dark-home.png) |
| 对话 | [查看](screenshots/light-conversation.png) | [查看](screenshots/dark-conversation.png) |
| 设置 | [查看](screenshots/light-settings.png) | [查看](screenshots/dark-settings.png) |
