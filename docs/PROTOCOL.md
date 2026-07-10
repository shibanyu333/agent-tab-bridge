# Agent Tab Bridge — 协议(给非 MCP 工具对接)

bridge 默认监听 `127.0.0.1:8737`。鉴权 token 在 `~/.agent-tab-bridge/token`(0600)。

两种接入方式,命令集完全一致。

## 方式 A:WebSocket(推荐,支持长连接会话)

连接 `ws://127.0.0.1:8737/agent?token=<TOKEN>&name=<AGENT_NAME>`

- 连上后收到 `{ "type":"registered", "sessionId", "name", "color" }`。
- 发命令:`{ "type":"command", "id":"<任意>", "action":"open_tab", "params":{...} }`
- 收结果:`{ "type":"result", "id":"<对应>", "ok":true, "data":{...} }`(失败 `ok:false, error`)
- 断开连接 = 会话结束(标签默认保留,除非先调 `session_end`)。
- 心跳:发 `{"type":"ping"}` 收 `{"type":"pong"}`。

## 方式 B:REST(一次性/无状态脚本)

所有请求带 `Authorization: Bearer <TOKEN>`。

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| GET  | `/healthz` | — | 无需鉴权;返回扩展是否在线、会话数 |
| POST | `/v1/session` | `{name}` | 建会话,返回 `{sessionId,name,color}` |
| GET  | `/v1/sessions` | — | 列出所有会话 |
| POST | `/v1/session/:sid/command` | `{action,params}` | 执行命令,返回 `{ok,data}` |
| DELETE | `/v1/session/:sid` | — | 结束会话 |

```bash
TOKEN=$(cat ~/.agent-tab-bridge/token)
SID=$(curl -s -X POST localhost:8737/v1/session -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"my-bot"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["sessionId"])')
curl -s -X POST localhost:8737/v1/session/$SID/command -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"action":"open_tab","params":{"url":"https://example.com"}}'
```

## action 一览

| action | params | 返回 |
|---|---|---|
| `open_tab` | `{url, waitMs?}` | `{tabId,url,title,status}` |
| `list_tabs` | — | `{session,color,tabs:[{tabId,url,title,status}]}` |
| `close_tab` | `{tabId}` | `{closed}` |
| `navigate` | `{tabId, url}`(url=网址\|back\|forward\|reload) | `{tabId,url,title,status}` |
| `snapshot` | `{tabId, maxChars?}` | `{text,elements,truncated}` — text 里每个可交互元素带 `[e<N>]` uid |
| `screenshot` | `{tabId, fullPage?, format?, quality?}` | `{base64, mimeType}` |
| `click` | `{tabId, uid, dblClick?, realEvents?}` | `{clicked}` |
| `fill` | `{tabId, uid, text, realEvents?}` | `{filled,value}` |
| `fill_form` | `{tabId, fields:[{uid,value}]}` | 每字段结果数组 |
| `select` | `{tabId, uid, values:[...]}` | `{selected}` |
| `hover` | `{tabId, uid}` | `{hovered}` |
| `press_key` | `{tabId, key, uid?, realEvents?}` | `{pressed}` |
| `scroll` | `{tabId, uid?|to?|by?}` | `{scrollY,maxY}` |
| `evaluate` | `{tabId, fn}`(fn 为函数声明字符串) | `{value}` |
| `wait_for` | `{tabId, text?|selector?, gone?, timeoutMs?}` | `{found,elapsedMs}` |
| `console` | `{tabId, limit?}` | `{messages:[{level,text}]}` |
| `extract` | `{tabId, selector?, format?, maxChars?}` | `{content,truncated,totalChars}` |
| `activate_tab` | `{tabId}` | `{activated}` — 唯一会抢焦点的命令 |
| `session_end` | `{closeTabs?}` | `{closedTabs}` |

## uid 机制

`snapshot` 每次重新编号页面上的可交互元素为 `e1 e2 …`,后续 `click/fill/...` 用这些 uid 定位。**页面变化后 uid 失效**,需重新 `snapshot`(操作失效元素会返回"元素已失效"错误)。

## 并发语义

- 同一标签的命令在扩展侧**串行**排队;不同标签 / 不同会话**并行**。
- `realEvents:true` 走 CDP 真实输入事件(需挂调试器);默认走合成事件(零提示条)。
- 合成 `press_key` 的 Enter 不触发浏览器默认提交,要提交表单用 `realEvents:true`。

## 安全

- bridge 只绑 `127.0.0.1`。
- `/agent` 与 REST 用 token 鉴权;`/extension`(给扩展)拒绝任何 http/https Origin(挡网页 JS 越权连接)。
