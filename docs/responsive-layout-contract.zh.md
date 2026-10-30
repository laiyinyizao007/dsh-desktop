# 窄屏 / 手机响应式布局契约

`dsh-desktop-responsive` 让上游 Harness Web UI 在窄视口（≤ 640px）下可用，同时把对上游 DOM 的依赖压缩成一份可测试的清单，方便上游升级时定位和修复。

## 现状与范围

- 上游 `ui-layout` 在宽度 < 1024px 时已有自己的窄屏模式：侧栏收起为细栏（Windows 标题栏和 macOS 下宽度为 0），展开时仍然占用网格列，挤压中间栏。手机宽度下中间栏只剩约 100px。
- 本插件只在 ≤ 640px 时接管两处布局，其余宽度保持上游行为：
  - “侧栏展开”状态：侧栏浮在内容上方成为抽屉，下面铺一层遮罩。
  - 设置弹窗：上游固定 800px 宽、左侧 188px 导航。手机上改为铺满标题栏以下区域，导航变成顶部可横向滚动的标签条，操作按钮和关闭按钮与标题同一行，侧栏底部的企业版入口隐藏。
- 当前阶段只覆盖 Electron 窗口拉窄的场景。手机通过桥接访问完整 UI 属于后续阶段，需要单独做安全评审（见下文“后续阶段”）。

## 分层：按升级抗性选择手段

| 层 | 手段 | 本插件中的用法 |
| --- | --- | --- |
| L0 公开接缝 | 上游 API、slot、token | `ctx.layout.toggleSidebar()` 开关抽屉；`shell.overlay`（list，可追加）挂遮罩；`ctx.layout.panelInfo` 与 `ctx.sessions.list` 判断导航；`--dsw-alias-bg-mask-1`、`--dsh-frame-chrome-top` |
| L1 插件 CSS | 宿主插件注入的作用域样式 | 所有规则都以 `html[data-dsh-viewport=compact]` 开头，或只作用于插件自己的遮罩元素 |
| L2 marker 补丁 | 只给上游节点加属性 | `data-dsh-region="frame/sidebar/center"`（layout 补丁），`data-dsh-region="hero-workspace-row"`（conversation 补丁），`data-dsh-region="settings-nav/settings-nav-list/settings-content/settings-header"`（settings-general 补丁） |
| L3 扩展点补丁 | 新增 slot 或布局选项 | 暂未使用 |
| L4 回馈上游 | 向上游提交 marker 或断点 | 上游合入后删除对应 L2 补丁 |

禁止的做法：复制上游组件，在 preload 里注入 DOM，用 hash 类名（如 `pI_x6G_frame`）或界面文案写选择器，大段改写 `dist/assets/index-*.js`。

## marker 清单

`packages/dsh-desktop-responsive/client.js` 导出 `MARKERS`，它是插件依赖上游 DOM 的唯一来源。样式只能用这里列出的选择器。

| key | 选择器 | 来源 |
| --- | --- | --- |
| `frame` | `[data-dsh-region=frame]` | layout 补丁 |
| `sidebar` | `[data-dsh-region=sidebar]` | layout 补丁 |
| `center` | `[data-dsh-region=center]` | layout 补丁 |
| `heroWorkspaceRow` | `[data-dsh-region=hero-workspace-row]` | conversation 补丁 |
| `sidebarCollapsed` | `[data-sidebar-collapsed]` | 上游原生属性 |
| `sidebarHandle` | `[data-side=sidebar]` | 上游原生属性 |
| `settingsPanel` | `[data-shortcut-modal=settings]` | 上游原生属性 |
| `settingsNav` | `[data-dsh-region=settings-nav]` | settings-general 补丁 |
| `settingsNavList` | `[data-dsh-region=settings-nav-list]` | settings-general 补丁 |
| `settingsContent` | `[data-dsh-region=settings-content]` | settings-general 补丁 |
| `settingsHeader` | `[data-dsh-region=settings-header]` | settings-general 补丁 |
| `settingsFooter` | `[data-dsh-settings-sidebar-footer]` | 已有的桌面补丁接缝 |

`test/responsive-layout.test.mjs` 在 VM 中加载已打补丁的 `ui-layout`，分别以展开和收起状态渲染 AppFrame，逐个断言上面的 marker 存在，并检查中间栏仍然是框架的直接网格子元素（抽屉依赖把它固定在第 2 列）。首页工作区行要渲染整个会话运行时，设置弹窗通过模态层 portal 渲染，二者都改用安装包源码检查：确认属性出现在带对应 class 的元素上。另有一条断言要求 `MARKERS` 的每个 key 都被渲染检查或源码检查覆盖，新增 marker 时不会漏测。

## 行为约定

- 视口：`matchMedia('(max-width: 640px)')` 决定 `<html data-dsh-viewport="compact|regular">`，插件卸载时移除。
- 抽屉：侧栏展开且处于 compact 时，侧栏改为绝对定位（宽 280px，最多到视口宽度减 48px），中间栏固定在第 2 列，隐藏侧栏拖拽手柄。
- 关闭方式：点击遮罩、按 Esc、切换正文会话、切换主面板。Esc 在三种情况下不处理：事件已被 `defaultPrevented`；事件起点位于菜单、对话框或列表框内；页面上有可见的此类弹层（已挂载但隐藏的弹层不算）。最后两种是手机导航抽屉的惯例；上游窄屏模式不覆盖内容，所以不会自动收起。
- 卸载插件后恢复上游原样：样式、视口属性、键盘监听和遮罩 slot 都通过 Cordis effect 清理。

## 上游升级流程

1. `npm ci` 后确认 patch-package 能重放全部补丁，`test/patch-hunk-counts.test.ts` 通过。
2. 运行 `npm test -- test/responsive-layout.test.mjs`。失败信息会指出缺失的 marker；只修 marker 补丁，不改插件 CSS。
3. 在开发 Profile 下用 390×844、768×1024 和桌面宽度检查：抽屉开关、遮罩、Esc、选择会话后自动收起、首页工作区行换行、设置弹窗各标签页，以及亮色和暗色主题。
4. 检查上游是否已经原生提供等价的 marker 或手机布局。若已提供，删除对应补丁或 CSS。

## 后续阶段（未实现）

- 通过手机桥接（`src/main/mobile/lan-mobile-bridge.ts`）提供完整 UI：现有 RPC 白名单 `HARNESS_ENDPOINTS` 会失效，需要重新做威胁评估（隧道外网暴露、文件和进程类 API）。
- 浏览器中没有 preload：`__DSH_BOOT__` 需要从 `/api/desktop/boot` 获取；依赖桌面 IPC 的插件需要检测并降级。
- 右侧面板：手机宽度下上游不会为它分配网格列（`computeColumns` 要求中间栏至少 400px）。若要在手机上使用，需要补扩展点。
