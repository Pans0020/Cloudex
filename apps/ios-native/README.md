# Cloudex Native iOS

这是与 `apps/mobile` 完全独立的 SwiftUI 原生 iOS 客户端，不依赖 Expo、React Native 或第三方 Swift 包。

## 已实现

- 服务器地址与 Bearer Token 设置、持久化
- 读取电脑上的项目和 Codex CLI 对话
- 新建、继续、停止、归档对话
- 模型读取与选择
- SSE 实时任务状态和流式回复
- 错误信息同步显示
- 浏览并附加电脑端文件
- 打开对话后自动定位到最新记录
- 首页同时显示已保存主机的在线状态、运行任务和待审批数；切换主机时隔离项目列表与草稿
- 输入栏可选手机照片并上传为附件，麦克风可将语音转成可编辑草稿
- 从系统分享菜单将截图、照片、网页或文字加入待分享收件箱；打开 Cloudex 后选择主机和会话，再检查并发送
- 主屏幕和锁屏小组件显示最近一次 App 同步的主机与运行任务（不是后台实时状态）
- 手机退出或切到后台时断开会话订阅，服务端释放对 Codex Desktop 的占用

## 运行

1. 先在项目根目录运行 `./start-cloudex.sh`，确保本地服务器的 `8890` 端口可访问。
2. 用本机可用的 `Xcode-beta.app` 打开 `CloudexNative.xcodeproj`。
3. 选择模拟器或已签名的真机，运行 `CloudexNative` Scheme。
4. 在 App 右上角设置中填写：
   - 局域网：`http://电脑局域网IP:8890`
   - Tailscale：`http://电脑TailscaleIP:8890`
   - 启动脚本终端中显示的访问 Token

真机不能使用 `127.0.0.1` 访问电脑。项目已在 `Info.plist` 中声明本地网络用途并允许开发阶段的 HTTP 连接。
分享扩展和小组件使用 `group.com.cloudex.native` App Group；真机签名须为主 App 和两个扩展启用同一 App Group。手机上传的图片保存在服务器的 `.cloudex-state/uploads`，会一直保留，管理服务器磁盘时请一并考虑此目录。

## 命令行编译检查

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild \
  -project CloudexNative.xcodeproj \
  -scheme CloudexNative \
  -sdk iphonesimulator \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO \
  build
```
