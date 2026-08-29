# CinaSeek 桌面与移动应用

CinaSeek 的桌面和移动应用复用 `https://cinaseek.ai` 的线上前端，以保留 Cloudflare Access、CinaAuth Cookie、WebSocket RPC 和 Gatekeeper OAuth 的同源行为。远程页面不获得 Node.js 或敏感原生插件能力。

## Electron（Windows、macOS、Linux）

开发运行：

```powershell
pnpm app:electron
```

在 Windows 生成 NSIS 安装包：

```powershell
pnpm app:electron:package:win
```

制品写入 `packages/app-electron/release/`。macOS DMG/ZIP 必须在 macOS 运行 `pnpm --filter @cinaseek/app-electron package:mac`；Linux AppImage/DEB 应在 Linux 运行 `pnpm --filter @cinaseek/app-electron package:linux`。

发布签名前设置 electron-builder 支持的 Windows 代码签名或 Apple Developer ID 环境变量。macOS 配置已启用 Hardened Runtime，但正式发布仍需要证书、公证与 Apple Team 信息。

安全边界：主窗口只能导航到 `https://cinaseek.ai`；认证子窗口只允许无内嵌凭据的 HTTPS；外部 HTTPS 链接交给系统浏览器；Node integration、`webview`、非沙箱渲染器和默认设备权限均被禁用。发行包还会启用 Cookie 系统加密和 ASAR 完整性校验，并禁用 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`、CLI Inspector 与额外 `file://` 权限。

## iOS / Android（Capacitor）

同步本地启动页和 Capacitor 配置：

```powershell
pnpm app:mobile:sync
```

生成品牌图标和启动图：

```powershell
pnpm --filter @cinaseek/app-mobile assets
```

Android：安装 Android Studio 2025.2.1+ 及其 SDK/JDK，然后运行：

```powershell
pnpm app:mobile:android
pnpm --filter @cinaseek/app-mobile build:android:debug
pnpm --filter @cinaseek/app-mobile build:android:release
```

iOS：在装有 Xcode 26+ 的 macOS 上运行：

```bash
pnpm app:mobile:ios
pnpm --filter @cinaseek/app-mobile build:ios:release
```

应用 ID 为 `ai.cinaseek.app`。商店发布前，需要在 Android Studio 配置上传密钥，在 Xcode 配置 Apple Team、Bundle ID、签名和 provisioning profile。

移动壳使用本地 CSP 限制的启动页，再顶层导航到 CinaSeek。远程页面不安装任何 Capacitor 插件；允许的顶层认证域名仅包括 CinaSeek、CinaAuth、Cloudflare Access、Google 和 GitHub。移动端通过 `CinaSeekMobile/1.0` User-Agent 标记使用同窗口登录，确保 Access 会话 Cookie 与应用 WebView 位于同一会话中。

> 当前移动架构依赖受限的远程顶层导航来兼容现有 Cloudflare Access Cookie。若要通过 App Store 的“最低功能”审核并获得系统浏览器 PKCE 登录、推送、离线能力或安全钥匙串，应把 CinaAuth 增加为原生 OAuth 客户端，并为移动 API 提供可验证的 Bearer Token 链路；这属于下一阶段的原生能力增强。

## CI 制品

GitHub Actions 的 `Native apps` 工作流支持手动运行，也会在推送 `app-v*` 标签时运行。它会生成 Windows/macOS/Linux Electron 制品、Android Debug APK 和无需签名的 iOS Simulator `.app`。Android AAB、iOS IPA、Windows Authenticode、macOS Developer ID 与公证仍需要把对应商店证书安全地接入发布工作流。
