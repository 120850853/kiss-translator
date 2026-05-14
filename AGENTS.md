# AGENTS.md instructions for /Users/liuchuanpeng/work_bench/GitHub/kiss-translator

<INSTRUCTIONS>

## 项目说明

这是一个浏览器扩展和油猴脚本项目，用于网页双语翻译。

## 代码仓库

这是一个 GitHub 项目。代码提交和推送默认使用 GitHub 远程仓库，不要上传、推送或同步到 Gitee 仓库。

## Chrome 扩展自动化开发测试

本项目已配置 Playwright 自动化测试，用于减少 Chrome 扩展开发时的人工参与。

### 一次性构建并测试

```sh
pnpm dev:chrome
```

该命令会依次执行：

1. 构建 Chrome 扩展到 `build/chrome`
2. 使用 Playwright 启动专用开发浏览器 profile
3. 加载 `build/chrome` 作为 unpacked extension
4. 打开扩展的 `options.html` 并验证页面可用

### 持续监听源码变化

```sh
pnpm watch:chrome
```

该命令会监听 `src/**/*` 和 `public/**/*`，每次修改后自动执行：

```text
build:chrome -> test:extension
```

该命令带有 1500ms 防抖，避免编辑器自动保存时在文件尚未写完的中间状态频繁触发构建。

### 常驻开发浏览器

```sh
pnpm dev:chrome:open
```

该命令用于日常扩展开发：

1. 构建 Chrome 扩展到 `build/chrome`
2. 使用 Playwright 启动专用开发浏览器 profile
3. 加载 `build/chrome` 作为 unpacked extension
4. 打开扩展的 `options.html`
5. 保持浏览器打开
6. 监听 `src/**/*` 和 `public/**/*`
7. 源码变化后重新构建，构建成功则重启开发浏览器并重新打开扩展页面
8. 构建失败时保留当前浏览器，并在终端打印错误

可以通过环境变量调整防抖时间：

```sh
DEV_CHROME_DEBOUNCE_MS=2500 pnpm dev:chrome:open
```

### 复用已登录 Chrome profile 调试

调试需要登录态的网站（例如 x.com）时，使用真实 Chrome profile，并把“业务扩展”和“开发重载器”分开：

```sh
pnpm dev:chrome:profile
```

该命令会：

1. 生成 reloader extension 到 `build/dev-reloader`
2. 启动本地 WebSocket server：`ws://127.0.0.1:17787/kiss-dev-reloader`
3. 监听 `src/**/*` 和 `public/**/*`
4. 首次启动和每次源码变化后执行 `build:chrome:dev`
5. 构建成功后通知 reloader extension
6. reloader extension 优先让目标扩展自己调用 `browser.runtime.reload()`
7. 如果外部消息失败，再回退到 `chrome.management.setEnabled()` 兜底

### 操作步骤

1. 在真实 Chrome profile 里手动加载一次 `build/chrome`
2. 同一个 profile 里手动加载一次 `build/dev-reloader`
3. 保持 `pnpm dev:chrome:profile` 运行
4. 修改源码后等待自动构建完成
5. 看到 runner 打出 `reloaded ...` 后，再到目标页面按快捷键验证

### 验证方式

- 看 `dev:chrome:profile` 日志里是否有 `reloaded 简约翻译 ...`
- 看 Chrome profile 里目标扩展的 `last_update_time` 是否更新
- 看目标页面是否重新注入了扩展节点

### 常见坑

- 只 reload 业务扩展，不 reload `build/dev-reloader`，新逻辑不会生效
- 只看 `chrome.management.get()` 的版本号不够，最好同时看 `Secure Preferences`
- 目标页面里的旧注入节点可能还在，必要时刷新一次页面再测快捷键
- 如果 `ws://127.0.0.1:17787` 连接失败，先确认 `pnpm dev:chrome:profile` 真的在跑
- 如果自动识别目标扩展 ID 失败，可以显式设 `DEV_RELOADER_TARGET_ID`

如果需要只生成 reloader extension，可运行：

```sh
pnpm dev:chrome:profile:reloader
```

如果自动识别目标扩展 ID 失败，可以显式指定：

```sh
DEV_RELOADER_TARGET_ID=<extension-id> pnpm dev:chrome:profile
```

### 专用开发 profile

Playwright 使用独立 profile，不污染日常 Chrome：

```text
.tmp/chrome-dev-profile
```

该目录已加入 `.gitignore`，可以在需要重置测试浏览器状态时删除。

### 相关文件

- `tests/extension.spec.js`：扩展加载测试
- `tests/dev-external-reload-build.spec.js`：dev build 的 external reload 构建语义测试
- `tests/dev-profile-reloader.js`：真实 Chrome profile 的 reloader runner
- `tests/dev-profile-reloader.spec.js`：reloader 构建与 WebSocket framing 测试
- `tests/dev-reloader-extension/`：独立开发 reloader extension 模板
- `tests/dev-extension-runner.js`：常驻开发浏览器 runner
- `tests/dev-extension-runner-utils.js`：常驻 runner 的防抖和队列工具
- `playwright.config.js`：Playwright 配置
- `package.json`：`dev:chrome`、`dev:chrome:open`、`dev:chrome:profile`、`watch:chrome`、`test:extension` 脚本

</INSTRUCTIONS>
