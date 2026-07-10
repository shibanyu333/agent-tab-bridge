# Agent Tab Bridge

让本地任意 AI agent 工具(Claude Code、Codex CLical、Cursor…)**并行、后台、互不干扰**地控制 Chrome —— 每个 agent 一个彩色标签组,像 Codex 官方浏览器插件那样。

```
Claude Code ─MCP─┐
Codex CLI   ─MCP─┤                    ┌─ 组"claude"(蓝) tab tab
脚本/REST   ─────┼→ bridge :8737 ─WS→ 扩展 ─→ ├─ 组"codex"(绿)  tab
                 │  (本地守护进程)     (你的Chrome) └─ 你自己的标签(不碰)
```

- **一个 agent = 一个会话 = 一个彩色命名标签组**;命令只作用于本会话打开的标签,跨会话零干扰。
- **真并行**:跨标签 / 跨会话并发执行(不同于单连接串行的 chrome-devtools MCP)。
- **后台运行**:所有标签 `active:false` 打开,不抢你的焦点(唯一例外见下方"截图")。
- **零打扰的日常操作**:snapshot / click / fill / extract 走注入脚本,没有"正在调试"提示条。

## 安装(三步)

### 1. 装依赖
```bash
cd ~/project/agent-tab-bridge && npm install
```

### 2. 加载扩展到 Chrome
> ⚠️ 品牌版 Google Chrome 已禁用 `--load-extension` 命令行,**必须走界面加载**:

1. 地址栏打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择目录:`~/project/agent-tab-bridge/extension`

加载后点扩展图标,看到 **● 已连接本地桥** 即成功(首次会自动拉起 bridge)。

### 3. 接入你的 agent 工具

**Claude Code:**
```bash
claude mcp add tab-bridge -- node ~/project/agent-tab-bridge/mcp/index.js
```

**Codex / Cursor 等**(通用 MCP 配置):
```json
{ "mcpServers": { "tab-bridge": { "command": "node",
  "args": ["/Users/shibanyu/project/agent-tab-bridge/mcp/index.js"],
  "env": { "AGENT_NAME": "codex" } } } }
```
`AGENT_NAME` 决定标签组的名字(不填则用客户端名)。

## agent 能用的工具(19 个,均限本会话)

`browser_open_tab` `browser_list_tabs` `browser_close_tab` `browser_navigate`
`browser_snapshot` `browser_screenshot` `browser_click` `browser_fill` `browser_fill_form`
`browser_select` `browser_hover` `browser_press_key` `browser_scroll` `browser_evaluate`
`browser_wait_for` `browser_console` `browser_extract` `browser_activate_tab` `browser_session_end`

典型流程:`open_tab` → `snapshot`(拿 uid)→ `click`/`fill`(用 uid)→ `wait_for` → `screenshot`。

## 测试

```bash
# 前提:bridge + 扩展在线(用 Chrome for Testing 可命令行加载扩展做自动化测试)
node scripts/smoke.js          # 两个 agent 并行 + 隔离验证 + 全链路
node scripts/smoke.js --keep   # 保留标签,肉眼看两个彩色分组
```

## 关于"截图"与打扰

- **snapshot/click/fill/extract 永不打扰** —— 走注入脚本,后台标签直接操作。
- **screenshot** 需要标签可见:隐藏标签没有渲染表面,Chrome 无法截。插件的做法是**瞬时激活该标签→截图→立刻切回你原来的标签**(全程不改窗口焦点)。
  - 该标签在**后台窗口** → 你完全看不到。
  - 该标签在你**正看着的窗口** → 会看到约 150ms 的标签闪动。
- 用到 screenshot / console / evaluate 会在浏览器顶部出现"正在调试此浏览器"提示条(Codex 同款)。**别点它的"取消"**,点了会断开调试,下次自动重挂。

## 已知边界

- `chrome://`、Chrome 应用商店页面无法控制(Chrome 平台限制)。
- 某标签开着 DevTools 时,该标签无法挂调试器(截图/console/evaluate 会报错)。
- 完全最小化的窗口里的标签无法截图(没有渲染表面)。
- 与 chrome-devtools MCP 可共存,但别让两者操作同一个标签。

详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)(WS/REST 协议,给非 MCP 工具对接用)。
