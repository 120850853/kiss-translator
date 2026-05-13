# AGENTS.md instructions for /Users/liuchuanpeng/work_bench/GitHub/kiss-translator

<INSTRUCTIONS>

## 项目说明

这是一个浏览器扩展和油猴脚本项目，用于网页双语翻译。

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

### 专用开发 profile

Playwright 使用独立 profile，不污染日常 Chrome：

```text
.tmp/chrome-dev-profile
```

该目录已加入 `.gitignore`，可以在需要重置测试浏览器状态时删除。

### 相关文件

- `tests/extension.spec.js`：扩展加载测试
- `tests/dev-extension-runner.js`：常驻开发浏览器 runner
- `tests/dev-extension-runner-utils.js`：常驻 runner 的防抖和队列工具
- `playwright.config.js`：Playwright 配置
- `package.json`：`dev:chrome`、`dev:chrome:open`、`watch:chrome`、`test:extension` 脚本

</INSTRUCTIONS>
