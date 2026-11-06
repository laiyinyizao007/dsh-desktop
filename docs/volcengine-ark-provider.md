# 火山引擎（火山方舟 Ark）接入记录

本文记录本机 DSH Desktop 接入火山引擎的完整状态：LLM 路由的配置、两个导致整轮 400 的
根因与各自的修法、可用模型清单的实测结论，以及图片生成（Seedream）链路的独立配置。
涉及的凭据只落在本机凭据库，不写入本文。

- 部署主机：树莓派 `100.86.255.34`，DSH Web `http://100.86.255.34:43129`
- 宿主 checkout：`/home/averypi/dsh-desktop`
- Profile：`~/.dsh/profiles/web`（用户可改层 `cordis.patch.yml`）
- 凭据库：`~/.dsh/.credentials.yaml`

---

## 1. 配置位置

| 内容 | 位置 |
| --- | --- |
| LLM 路由 | `~/.dsh/profiles/web/cordis.patch.yml` → `llm-pi-ai` → `providers.volcengine` |
| 凭据 | `~/.dsh/.credentials.yaml` → `refs.VOLCENGINE_API_KEY`（Ark API Key） |
| 生图 | 同上凭据库 → `records.dsh-image-generation/configuration` |
| 无头验证 | `~/.dsh/profiles/headless/cordis.patch.yml`（与 web 同路由，便于单独跑模型） |

当前路由要点（**唯一**的一条火山引擎路由）：

```yaml
volcengine:
  displayName: volcengine
  apiKeyEnv: VOLCENGINE_API_KEY
  api: openai-completions
  baseURL: https://ark.cn-beijing.volces.com/api/v3
  models: [ … 16 个，见 §4 ]
```

`api` 选择 `openai-completions` 而不是 `openai-responses` 是**有意的**，原因见 §3.2。

### 1.1 2026-11-06：合并成一条（删掉了另外三条）

之前 `~/.dsh/profiles/web/cordis.patch.yml` 里同时存在**四条**指向火山方舟的路由，
模型选择器里因此出现三个名字相近、模型重叠的分组。现已合并成上面这一条：

| 已删除 | baseURL | key | 当时的状态 |
| --- | --- | --- | --- |
| `providers.deepseek` | `…/api/plan/v3` | `DEEPSEEK_API_KEY` | 能通（HTTP 200），但只有 2 个模型 |
| `providers.volcengine-ark` | `…/api/plan` | `VOLCENGINE_ARK_API_KEY` | 能通（HTTP 200），5 个模型，`anthropic-messages` |
| 插件 `llm-deepseek`（`deepseek-official`） | `…/api/coding/v3` | `DEEPSEEK_API_KEY` | **401**（路径就选错了） |

三条都实测过（原始 HTTP + DSH 端到端无头跑），**能用的不止一条**，所以「留能用的
那一条」的判据不是可用性，而是**覆盖面**：`volcengine` 那条 16 个模型全部逐个跑通
DSH 端到端，另两条加起来才 7 个，且 pi-ai 的两个补丁（§2.1 §2.2）都是围绕
`openai-completions` 这条路线做的。

`deepseek-official` 那条是另一回事：它的 key 名叫 `DEEPSEEK_API_KEY`，值却是
**`ark-` 开头的方舟 key**。所以无论 baseURL 指向 `…/api/coding/v3`（401）还是
指向官方 `api.deepseek.com`（也是 401），它都不可能工作——它只是让模型选择器里
多出一个永远用不了的「DeepSeek」分组。**已把 `DEEPSEEK_API_KEY` 从凭据库删除**，
该分组随之从 `routableProviders` 消失。

> `VOLCENGINE_ARK_API_KEY` **仍然保留**在凭据库里（Agent Plan 订阅的 key），
> 只是没有任何配置引用它。它不产生任何 provider 分组，删不删都不影响使用。

改动后模型选择器只剩两组：

```
routableProviders: ['minimax-cn', 'volcengine']
  minimax-cn   2 个模型
  volcengine  16 个模型
```

**备份**：`~/.dsh/backups/ark-dedup-20261106/`
（`cordis.patch.yml.web.bak` = web profile 改动前，`credentials.yaml.bak` = 凭据库改动前）。

> 用户补丁层是**热重载**的（`cordis.patch.yml` 在长驻进程上会被重新读取），
> 凭据库也是**被监视**的（`dsh-credentials-local` 的 `watch: true`）。
> 两处改动都**不需要重启 `dsh-web.service`**，也就不会打断在跑的会话。

---

## 2. 症状与根因

### 2.1 根因 A：工具 schema 里的非法 `type` 关键字

报错：

```
InvalidParameter: tools.33.function.parameters/properties/actions/items:
invalid JSON Schema; check the schema keywords and references
```

Ark 对 `tools[].function.parameters` 做严格 JSON Schema 校验，只要**任何一个**工具的
schema 含有非法 `type`，**整轮请求**都会 400 —— 与该工具是否被调用无关。

唯一的来源是 win-pilot 的 MCP 工具 `mcp__dell-computer__computer`：

```js
actions: { type: 'array', items: { type: 'json' } }   // "json" 不是 JSON Schema 类型
```

合法类型只有 `object / array / string / number / integer / boolean / null`。

**修法（Pi 侧，根治）**：`dsh-mcp-client` 注册工具前递归清洗 schema，删掉非法 `type`
关键字（等价于"任意值"，仍是合法 JSON Schema），其余字段与原对象都不动。

- 实现：`node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js` → `sanitizeInputSchema()`
- 补丁：`patches/@deepseek-ai+dsh-mcp-client+0.2.1-rc.3.patch`
- 回归测试：`test/mcp-input-schema-sanitize.test.ts`（3 项，全绿）

**修法（Dell 侧，改源头）**：`C:\Users\laiyi\AppData\Local\npm-global\node_modules\win-pilot\lib\index.js:888`
`items: { type: 'json' }` → `items: { type: 'object' }`，备份在同目录 `index.js.bak-json-type`。
⚠️ `npm update` 升级 win-pilot 会覆盖这一处，届时由 Pi 侧清洗兜底，不会再 400。

> 教训：MCP 服务器重启 **不会** 让已运行的 DSH 重新 `tools/list`。DSH 内存里的工具目录
> 必须靠 DSH 自身重启（或插件重载）才会更新。改动 MCP 端后要重启 `dsh-web.service`。

### 2.2 根因 B：空的 assistant 文本块

报错：

```
MissingParameter: The request failed because it is missing `input.content.text` parameter.
```

这是 **Ark `/responses` 接口**的校验：任何一条 `output_text` 内容块的 `text` 为空，
整轮请求就被拒。触发条件很常见 —— **模型只发了工具调用、没有可见文本**的那一轮，
在历史里就留下一条空文本 assistant 消息，之后每轮都 400。

实测复现（`type: "message"` + 空 `output_text`）：

```json
{"type":"message","role":"assistant","content":[{"type":"output_text","text":"","annotations":[]}]}
→ MissingParameter: input.content.text
```

**修法（Pi 侧）**：`@earendil-works/pi-ai` 的 `convertResponsesMessages()` 在把历史
assistant 文本块转成 input item 时，**跳过空文本块**，不再把空 `output_text` 送上游。

- 实现：`node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`
- 补丁：`patches/@earendil-works+pi-ai+1.3.0.patch`

**修法（路由侧，本机采用）**：volcengine 路由改走 `api: openai-completions`。
Ark 的 chat/completions 接受空 assistant content，且**所有可用模型都实现了它**；
`/responses` 只有部分模型实现，且校验更严。

---

## 3. 为什么选 `openai-completions`

| | `/responses` | `/chat/completions` |
| --- | --- | --- |
| Ark 可用模型覆盖 | 部分模型实现 | **全部 16 个已配置模型都实现** |
| 空 assistant 文本 | 400 `input.content.text` | 接受 |
| 工具调用 | 支持 | 支持（17/17 带全量工具目录实测通过） |
| 推理参数 | `thinking` / `effort` | `reasoning_effort`（none/minimal/low/medium/high/max 均实测可用） |

本机路由因此固定为 `openai-completions`。若将来某天需要 `/responses` 的独有能力
（例如 `web_search` 工具），需先确认该模型在 Ark 上已实现 `/responses`，并保留 §2.2
的 pi-ai 空文本块补丁作为前置条件。

---

## 4. 模型清单（实测）

Ark 账号 2115100984，`GET /api/v3/models` 返回 55 个条目，其中 29 个声明支持
`chat/completions`。逐个实测（`POST /api/v3/chat/completions`，最小请求）后：

**16 个已配置**（全部逐个跑通 DSH 端到端，无头 profile 实测 4–14 秒返回）：

| 模型 | 上下文 | 最大输出 | 模态 | 推理档位 |
| --- | --- | --- | --- | --- |
| deepseek-v4-1-flash-260910 | 1048576 | 393216 | text+image | none/low/high/max |
| deepseek-v4-1-flash-261017 | 1048576 | 393216 | text+image | none/low/high/max |
| deepseek-v4-1-flash-economy-261017 | 1048576 | 393216 | text+image | none/low/high/max |
| deepseek-v4-flash-ga-260731 | 1048576 | 393216 | text | none/minimal/low/high/max |
| deepseek-v4-pro-ga-260813 | 1048576 | 393216 | text | none/minimal/low/high/max |
| doubao-seed-2-0-code-preview-260215 | 229376 | 131072 | text+image | minimal/low/medium/high |
| doubao-seed-2-0-lite-260428 | 229376 | 131072 | text+image | minimal/low/medium/high |
| doubao-seed-2-0-mini-260428 | 229376 | 131072 | text+image | minimal/low/medium/high |
| doubao-seed-2-1-lite-260915 | 1048576 | 262144 | text+image | minimal/low/medium/high |
| doubao-seed-2-1-pro-260628 | 262144 | 262144 | text+image | minimal/low/medium/high |
| doubao-seed-2-1-pro-260915 | 1048576 | 262144 | text+image | minimal/low/medium/high |
| doubao-seed-2-1-turbo-260628 | 262144 | 262144 | text+image | minimal/low/medium/high |
| doubao-seed-character-260628 | 131072 | 32768 | text+image | minimal/low/medium/high |
| glm-5-2-260617 | 1048576 | 131072 | text | none/minimal/high/max |
| glm-5-3-flash-260828 | 1048576 | 131072 | text+image | low/high/max |
| kimi-k3-1-pro-261024 | 1048576 | 1048576 | text+image | low/high/max |

**1 个可用但不适合 agent，已排除**：`doubao-seed-character-251128`（角色扮演向模型）。
它能正常聊天，但一拿到工具就会**无限循环调用 `bash`** —— 实测在一次无头会话里连发
53 次工具调用，把上下文撑满后以 `InvalidParameter` 报错收场，不是配置问题而是模型
行为问题，因此没有放进 provider 列表。

**12 个不可用**（未配置；需要方舟控制台开通后才可用）：

- `ModelNotOpen`（账号未开通）：`doubao-seed-evolving`
- `InvalidEndpointOrModel.NotFound`（该账号下不存在）：`deepseek-v4-pro-260425`、
  `doubao-seed-2-0-pro-260215`、`doubao-seed-2-0-mini-260215`、`doubao-seed-2-0-lite-260215`、
  `qwen3-14b-20250429`、`qwen3-0-6b-20250429`、`qwen3-32b-20250429`、`qwen3-8b-20250429`、
  `qwen2-5-72b-20240919`、`glm-4-5-air-20250728`、`doubao-smart-router-250928`

其余 26 个条目属于图片 / 视频 / 3D / Embedding 域，不是对话模型，不进 provider 列表。

> 开通新模型后，把它追加到 provider 的 `models` 并重启 `dsh-web.service` 即可；
> 上下文与输出上限、模态、推理档位以方舟 `GET /api/v3/models` 的返回为准。

---

## 5. 图片生成（Seedream）链路

与 LLM 路由无关，独立配置：

- 插件：`dsh-image-generation`，provider `bytedance`
- 模型：`doubao-seedream-5-0-pro-260628`（已开通并实测出图成功）
- baseURL：`https://ark.cn-beijing.volces.com/api/v3`
- 凭据存于 `records.dsh-image-generation/configuration`
- 图形界面入口：设置 → 插件 → Image generation

`doubao-seedream-5-0-flash-260915` 目前在方舟侧仍未开通（`ModelNotOpen`）。

---

## 6. 验证方法

```bash
# 单个模型（无头 profile，路由与 web 一致）
cd /home/averypi/dsh-desktop
VOLCENGINE_API_KEY=<ark-key> node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch /dev/stdin "reply with the single word: pong" <<'EOF'
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: volcengine
    model: deepseek-v4-1-flash-economy-261017
EOF

# 抓取 DSH 真实发出的请求体（把 baseURL 临时指向本地代理转发到方舟）
#   node /tmp/ark-proxy.mjs   # 监听 127.0.0.1:43200，记录请求体后转发到 ark.cn-beijing.volces.com
#   baseURL: http://127.0.0.1:43200/api/v3

# 工具目录整体过一遍 Ark（132 个工具的真实 schema）
# 取会话 transcript 里最新的 request/header.tools，原样 POST 给方舟校验
```

回归测试：

```bash
cd /home/averypi/dsh-desktop && npx vitest run test/mcp-input-schema-sanitize.test.ts
```

---

## 7. 遗留与注意事项

1. **改 MCP 服务器端后必须重启 `dsh-web.service`** —— MCP 端重启不会让 DSH 重新
   `tools/list`，改了对 DSH 也无效。
2. **升级 win-pilot 会覆盖 Dell 侧的 schema 修改**，Pi 侧清洗兜底，不会再 400。
3. **方舟模型开通有延迟**：控制台开通后，个别模型的 `ModelNotOpen` 会持续一段时间。
4. **切换 provider 会话历史要留意**：Ark `/responses` 对历史里的空 assistant 文本块敏感；
   本机已通过 pi-ai 补丁根治，但若换回 `/responses`，务必保留该补丁。
5. **抓包排错手法**：把 provider 的 `baseURL` 临时指向本地转发代理
   （`http://127.0.0.1:43200/api/v3` → 方舟），即可在 `/tmp/ark-proxy.log` 里看到 DSH
   真实发出的请求体和方舟的原始响应，比猜 schema 快得多。排查完记得改回官方 baseURL。
