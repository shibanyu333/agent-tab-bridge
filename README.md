# Agent Tab Bridge

Let any local AI agent (Claude Code, Codex CLI, Cursor…) drive Chrome **in parallel, in the background, without stepping on each other** — one colored tab group per agent, like the official Codex browser extension. **No `chrome.debugger`, so no "started debugging this browser" banner, ever.**

*[中文说明见下方](#中文说明)*

```
Claude Code ─MCP─┐
Codex CLI   ─MCP─┤                     ┌─ group "claude" (blue)  tab tab
scripts/REST─────┼→ bridge :8737 ─WS→ extension ─→ ├─ group "codex" (green)  tab
                 │  (local daemon)      (your Chrome)  └─ your own tabs (never touched)
```

- **One agent = one session = one colored, named tab group.** Commands only affect tabs that session opened; sessions are fully isolated.
- **True parallelism**: concurrent across tabs and sessions (unlike the single-connection, serial chrome-devtools MCP).
- **Background by default**: every tab opens with `active:false`, never stealing your focus (one caveat under *Screenshots*).
- **No debugger banner**: v0.2.0 dropped `chrome.debugger` entirely. Screenshot, `evaluate`, and console capture now use ordinary extension APIs — Chrome never shows the yellow "an external app is debugging this browser" bar.

## Install (3 steps)

### 1. Dependencies
```bash
cd ~/project/agent-tab-bridge && npm install
```

### 2. Load the extension into Chrome
> ⚠️ Branded Google Chrome has disabled the `--load-extension` command-line flag, so you **must load it through the UI**:

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the folder: `~/project/agent-tab-bridge/extension`

Click the extension icon; **● Connected to local bridge** means success (the bridge is auto-started on first use).

### 3. Connect your agent

**Claude Code:**
```bash
claude mcp add tab-bridge -- node ~/project/agent-tab-bridge/mcp/index.js
```

**Codex / Cursor / any MCP client:**
```json
{ "mcpServers": { "tab-bridge": { "command": "node",
  "args": ["/Users/shibanyu/project/agent-tab-bridge/mcp/index.js"],
  "env": { "AGENT_NAME": "codex" } } } }
```
`AGENT_NAME` sets the tab-group name (defaults to the client's name).

## Tools (21, all scoped to the calling session)

| | | |
|---|---|---|
| `browser_open_tab` | `browser_list_tabs` | `browser_close_tab` |
| `browser_navigate` | `browser_snapshot` | `browser_screenshot` |
| `browser_click` | `browser_fill` | `browser_fill_form` |
| `browser_select` | `browser_hover` | `browser_press_key` |
| `browser_submit_form` | `browser_upload_file` | `browser_scroll` |
| `browser_evaluate` | `browser_wait_for` | `browser_console` |
| `browser_extract` | `browser_activate_tab` | `browser_session_end` |

Typical flow: `open_tab` → `snapshot` (get uids) → `click`/`fill` (by uid) → `submit_form` → `wait_for` → `screenshot`.

**Highlights added in v0.2.0**
- `browser_upload_file` — feeds file bytes straight into `<input type=file>` via `DataTransfer`; **no OS file-picker dialog** pops up. Works even when the input is CSS-hidden, and handles drag-and-drop dropzones.
- `browser_submit_form` — native `requestSubmit`, so **hidden fields (nonce / CSRF) are carried automatically** and HTML validation fires. Use this for admin forms (WordPress/WooCommerce) instead of hand-rolled `fetch` POSTs.
- `browser_snapshot` — now lists hidden inputs (`type=hidden`/`type=file`) too, and takes a `selector` to scope large admin pages; avoids the "site is blocking automation" misdiagnosis caused by fields falling outside a truncated snapshot.

## Test

```bash
# Requires bridge + extension online (Chrome for Testing can load the extension via CLI for automated tests)
node scripts/smoke.js          # 3 agents in parallel + isolation + full flow (upload/submit/console/full-page)
node scripts/smoke.js --keep   # keep the tabs so you can eyeball the colored groups
```

## Screenshots & interruption

- **snapshot / click / fill / extract / evaluate / console never interrupt you** — they run through injected scripts / extension APIs, no banner, no focus change.
- **screenshot** needs a visible tab. `tabs.captureVisibleTab` only captures a window's active tab, so the extension **momentarily activates the target tab → captures → switches right back** (window focus is never changed). A global lock serializes screenshots so parallel sessions don't fight over activation.
  - Target tab in a **background window** → you see nothing.
  - Target tab in the **window you're looking at** → a ~150 ms tab flicker.
  - `fullPage:true` scrolls and stitches slices (up to 12 viewport heights), hiding fixed/sticky elements after the first slice.

## Known limits

- `chrome://` and Chrome Web Store pages can't be controlled (platform restriction).
- Strict-CSP pages block `eval`, so `browser_evaluate` can't run there — use `snapshot`/`extract`/`click`/`fill` instead.
- No `isTrusted` native input events (that required the debugger). Synthetic events cover the vast majority of sites.
- Coexists with chrome-devtools MCP, but don't drive the same tab from both.

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the WS/REST protocol (for non-MCP clients).

---

<a name="中文说明"></a>
# 中文说明

让本地任意 AI agent 工具（Claude Code、Codex CLI、Cursor…）**并行、后台、互不干扰**地控制 Chrome —— 每个 agent 一个彩色标签组，像 Codex 官方浏览器插件那样。**不使用 `chrome.debugger`，因此永远不会出现"正在调试此浏览器"横条。**

```
Claude Code ─MCP─┐
Codex CLI   ─MCP─┤                    ┌─ 组"claude"(蓝) tab tab
脚本/REST   ─────┼→ bridge :8737 ─WS→ 扩展 ─→ ├─ 组"codex"(绿)  tab
                 │  (本地守护进程)     (你的Chrome) └─ 你自己的标签(不碰)
```

- **一个 agent = 一个会话 = 一个彩色命名标签组**；命令只作用于本会话打开的标签，跨会话零干扰。
- **真并行**：跨标签 / 跨会话并发执行（不同于单连接串行的 chrome-devtools MCP）。
- **后台运行**：所有标签 `active:false` 打开，不抢你的焦点（唯一例外见下方"截图"）。
- **无调试横条**：v0.2.0 彻底移除了 `chrome.debugger`。截图、`evaluate`、console 捕获改用普通扩展 API，Chrome 不再弹出那条黄色"外部应用正在调试"提示。

## 安装（三步）

### 1. 装依赖
```bash
cd ~/project/agent-tab-bridge && npm install
```

### 2. 加载扩展到 Chrome
> ⚠️ 品牌版 Google Chrome 已禁用 `--load-extension` 命令行，**必须走界面加载**：

1. 地址栏打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择目录：`~/project/agent-tab-bridge/extension`

加载后点扩展图标，看到 **● 已连接本地桥** 即成功（首次会自动拉起 bridge）。

### 3. 接入你的 agent 工具

**Claude Code：**
```bash
claude mcp add tab-bridge -- node ~/project/agent-tab-bridge/mcp/index.js
```

**Codex / Cursor 等**（通用 MCP 配置）：
```json
{ "mcpServers": { "tab-bridge": { "command": "node",
  "args": ["/Users/shibanyu/project/agent-tab-bridge/mcp/index.js"],
  "env": { "AGENT_NAME": "codex" } } } }
```
`AGENT_NAME` 决定标签组的名字（不填则用客户端名）。

## agent 能用的工具（21 个，均限本会话）

`browser_open_tab` `browser_list_tabs` `browser_close_tab` `browser_navigate`
`browser_snapshot` `browser_screenshot` `browser_click` `browser_fill` `browser_fill_form`
`browser_select` `browser_hover` `browser_press_key` `browser_submit_form` `browser_upload_file`
`browser_scroll` `browser_evaluate` `browser_wait_for` `browser_console` `browser_extract`
`browser_activate_tab` `browser_session_end`

典型流程：`open_tab` → `snapshot`（拿 uid）→ `click`/`fill`（用 uid）→ `submit_form` → `wait_for` → `screenshot`。

**v0.2.0 新增亮点**
- `browser_upload_file` —— 经 `DataTransfer` 把文件字节直接投喂进 `<input type=file>`，**不弹系统文件对话框**。input 被 CSS 藏起来也能用，还支持拖拽上传区。
- `browser_submit_form` —— 原生 `requestSubmit`，**自动携带隐藏字段（nonce / CSRF）** 并触发 HTML 校验。后台表单（WordPress/WooCommerce）用它，别手搓 `fetch` POST。
- `browser_snapshot` —— 现在也会列出隐藏输入框（`type=hidden`/`type=file`），并支持 `selector` 限定大型后台页的抓取范围；避免字段落在截断部分之外时误判"站点在拦截自动化"。

## 测试

```bash
# 前提：bridge + 扩展在线（Chrome for Testing 可命令行加载扩展做自动化测试）
node scripts/smoke.js          # 三个 agent 并行 + 隔离验证 + 全链路(上传/提交/console/整页)
node scripts/smoke.js --keep   # 保留标签，肉眼看彩色分组
```

## 关于"截图"与打扰

- **snapshot / click / fill / extract / evaluate / console 永不打扰** —— 走注入脚本 / 扩展 API，无横条、不改焦点。
- **screenshot** 需要标签可见。`tabs.captureVisibleTab` 只能截窗口里的活动标签，所以插件的做法是**瞬时激活目标标签 → 截图 → 立刻切回**（全程不改窗口焦点）。全局锁串行化截图，避免并行会话抢激活。
  - 目标标签在**后台窗口** → 你完全看不到。
  - 目标标签在你**正看着的窗口** → 会看到约 150ms 的标签闪动。
  - `fullPage:true` 滚动分片再拼接（最多 12 屏），第一片之后隐藏固定/粘性元素。

## 已知边界

- `chrome://`、Chrome 应用商店页面无法控制（平台限制）。
- 强 CSP 页面禁止 `eval`，`browser_evaluate` 无法在其上运行 —— 改用 `snapshot`/`extract`/`click`/`fill`。
- 没有 `isTrusted` 原生输入事件（那需要调试器）。合成事件覆盖绝大多数站点。
- 与 chrome-devtools MCP 可共存，但别让两者操作同一个标签。

详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)（WS/REST 协议，给非 MCP 工具对接用）。
