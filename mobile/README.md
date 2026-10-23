# HomeChef Android v0.2.5

独立运行的安卓客户端：库存、菜谱、推荐、烹饪、结算和设置都在手机本地执行。无需启动电脑服务或连接网络。手机与电脑各自保存数据；本版不提供账号、同步或 AI。

## 使用与数据

- Android 7.0 / API 24 及以上，使用系统 Android WebView。安装签名 APK 后从桌面打开。
- 首次启动执行仓库中的 15 个迁移，不自动导入测试菜谱包或测试库存。设置 → 初始内容可选导入常用食材与 1211 道测试菜谱，库存由用户录入。导入器直接复用 `server/src/content/v024`（旧 seed 路径保留兼容入口），只新增、重名跳过、单位冲突跳过，整批事务保护。
- 设置 → 手机数据 → 导出备份，使用系统文件选择器保存文件。卸载或清除应用数据前先备份。
- 恢复会替换手机上的全部数据，需要确认。当前只接受相同数据库结构和迁移记录的 HomeChef 安卓备份，不支持导入电脑数据库。备份文件未加密，请妥善保存。
- 返回键先关闭支持 Escape 的弹窗，再返回上一页；首页返回会把应用移到后台，不清除数据。
- 升级需要相同签名证书。签名密钥不在仓库内，不应重新生成密钥后覆盖发布。

## 构建

需要 Node.js（满足 Capacitor 8 的要求）、JDK 21、Android SDK 36、Build Tools 36.0.0，以及首次下载依赖的网络环境。在仓库根目录下的 `mobile` 文件夹执行：

```powershell
npm ci
npm run typecheck
npm run build
npm run android:sync
cd android
.\gradlew.bat --no-daemon assembleDebug
```

发布构建改用 `assembleRelease`，再用私有且持续保留的签名密钥签署生成的 unsigned APK。不要把密钥、密码、SDK、缓存、数据库或备份提交到 Git。

本地 Android SDK 路径由 `ANDROID_HOME` 或未跟踪的 `android/local.properties` 配置。Gradle 限制为 768 MB 堆、2 个 worker；内存较小时编译与模拟器错开运行。

## 复用边界

Vite 直接读取上层仓库的 React 页面、路由、业务服务、Drizzle schema 和 SQL 迁移。手机不运行 Node.js/Fastify 服务。`runtime/router.ts` 在进程内注册既有处理器并执行 AJV 校验；同步 JavaScript 接口通过原生 SQLite 适配器保持既有 Drizzle 事务语义。

所有数据库操作（包括备份和恢复）在同一个专用线程执行。Activity 销毁时在该线程回滚未完成事务并关闭连接，避免旧页面的 SQLite 会话锁住新页面。

SQLCipher 4.17.0 提供随包分发的现代 SQLite 引擎，当前使用空密码，数据库不加密。数据库位于应用私有目录；应用禁止 WebView 加载远程脚本、页面及网络资源，关闭系统自动备份。

`overrides/` 仅替换 5 个平台入口（应用导航、请求层、设置页、数据库初始化和测试故障注入）。`baseline.json` 对原文件校验 SHA-256；共享文件变化时构建会停止，需审查覆盖实现后更新哈希。不要绕过校验。

## 验证

测试使用模拟器私有数据库，不读取或修改电脑真实库。`validation` / `content-validation` 构建且仅 Debug 启动参数 `homechef_validation=true` 才运行 `runtime/validate-*.ts`；生产构建不包含这些测试模块。

已验证原生环境的 22 项核心检查及 7 项回滚/边界检查，包括迁移、严格参数校验、库存/菜谱、推荐防重复、烹饪结算、重复结算不重复扣减、故障回滚、库存不足及关联完整性。没有声称完成全站浏览器 E2E 或真机测试。

依赖许可见 `THIRD_PARTY_NOTICES.txt` 和 `public/licenses.txt`。
