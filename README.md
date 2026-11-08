# dsh-prompt-enhancer

输入框右侧的 ✨「增强提示词」按钮：把当前草稿交给**当前默认模型**，改写成更完整、可执行的提示词，再写回输入框——**不自动发送**，失败可见，且随时可以还原原稿。

## 用途

- 草稿很短、信息不全（例如「把事项中心的材料接口加个导出」）时，一键补齐 目标 / 范围 / 约束 / 验收标准 / 交付形态。
- 硬约束原样保留：代码、文件路径、报错文本、命令行、变量名、接口名、URL、数字与单位逐字不动。
- 不新增需求、不臆造信息：草稿没有且推断不出的要素写成「待确认：……」留白。
- 只重写提示词，不执行任务、不加前言、不用代码块包裹；输出语言跟随草稿。
- 长度受控：元提示词要求不超过原文 3 倍（极短草稿放宽到约 500 字），Host 侧再用 `maxTokens` 与 20000 字符硬上限兜底。

## 组成（两半）

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：注册同源路由 `POST /prompt-enhancer/enhance`，校验、限流、超时、调用 `ctx.llm.stream`，把结果转成 JSON。 |
| `client.js` | Web Client 半：在 `conversation.input.right` 注册 `id: prompt-enhancer`（`order: 30`）的按钮组件，用 `inputActions.setDraft()` 写回草稿。 |
| `cordis.patch.yml` | bundle patch：插入 `id: prompt-enhancer` 的 Host 行。 |
| `locale/zh.json`、`locale/en.json` | Plugin Manager 显示用的 `meta.title` / `meta.description`。 |
| `icon.svg` | 插件列表图标（自制，可被标准 SVG 解析器解析）。 |
| `package.json` | 包清单：`exports`、`files`、`dsh.bundle.patch`、`dsh.client`。 |

## 安装

在 DSH 里安装本目录即可（会自动写入 profile 依赖并启用 bundle）：

```text
plugin_manager(action: "install_bundle", target: "github:991206772-debug/dsh-prompt-enhancer")
```

装完后 Web GUI 需要刷新页面（客户端半只在页面加载时进入模块表）。宿主侧路由随 plugin 行激活即时可用。

## 配置

所有字段都有默认值，`config: {}` 即可工作；如需覆盖，写进 `cordis.patch.yml` 的 `config:`（或在 profile 的 patch 层按 `id: prompt-enhancer` 覆盖）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `""` | 覆盖模型路由；留空则用 `ctx.agentDefaultModel.currentSelection()` 的默认模型。 |
| `model` | `""` | 覆盖模型 id；与 `provider` 同时给出才生效，否则回落默认模型。 |
| `temperature` | `0.3` | 0–2。 |
| `maxTokens` | `1200` | 64–8192，输出长度的硬上限。 |
| `timeoutMs` | `60000` | 1000–300000，Host 侧 AbortController 超时。 |
| `maxDraftChars` | `8000` | 超过直接 413，不发模型。 |
| `metaPrompt` | 内置中文元提示词 | 整体替换改写规则。 |

`Config` 由真实的 `@deepseek-ai/schemastery` 静态导入构造（`import Schema from '@deepseek-ai/schemastery'`），因此宿主能把 schema 投影到插件面板（`cordis_inspect_query(host, Config, listConfigs, {"name":"dsh-prompt-enhancer"})` 返回 `status: "schema"`），字段默认值与上表一致。

> 仓库不包含 node_modules。从 GitHub 安装时，由插件管理器安装声明的依赖；本地 link 安装时，在源码目录执行 npm install --omit=dev。

`peerDependencies` 里的 `@deepseek-ai/cordis` 只用于类型/版本对齐，运行时由宿主提供；pnpm 会在 `install_bundle` 输出一条 link 包不解析 peer 的 `[WARN]`，不影响加载。

## HTTP 契约（Host 半）

`POST /prompt-enhancer/enhance`，同源，必须带：

```text
content-type: application/json
x-dsh-prompt-enhancer: 1
```

请求体：`{"draft": "..."}`；成功返回：

```json
{ "ok": true, "prompt": "...", "provider": "...", "model": "...", "routeSource": "default-model", "stats": { "draftChars": 49, "promptChars": 489, "budgetChars": 500, "clipped": false, "clippedByBudget": false, "truncatedByTokens": false } }
```

长度是硬约束（两道防线）：调模型前按 `budgetChars = min(max(3 * draftChars, 500), 20000)` 把预算写进 system 并收紧 `maxTokens`；返回后再按**句/行边界**截断到预算内（绝不硬切半句），截断时 `stats.clippedByBudget` 为 `true`。草稿 < 60 字符时额外要求五个小节各有实质内容，保证短稿补全后 ≥ 200 字符而不注水。

失败一律 JSON `{ "ok": false, "error": { "code": "...", "message": "..." } }`：

| 状态码 | code | 触发条件 |
| --- | --- | --- |
| 405 | `method-not-allowed` | 非 POST |
| 415 | `unsupported-media-type` | content-type 不是 `application/json` |
| 403 | `missing-client-header` | 缺 `x-dsh-prompt-enhancer: 1` |
| 400 | `invalid-json` / `empty-draft` | 请求体不是 JSON 对象 / 草稿为空 |
| 413 | `payload-too-large` / `draft-too-long` | 请求体 > 64KB / 草稿 > 8000 字符 |
| 503 | `no-model-configured` / `llm-unavailable` | 既无默认模型也无 Config 兜底 / llm 服务缺失 |
| 502 | 模型错误码 | 模型侧失败、返回工具调用或空文本 |
| 504 | `timeout` | 超过 `timeoutMs` |
| 500 | `internal-error` | 其它未捕获异常（不会冒泡成 unhandledRejection） |

隐私：不落盘、不打印草稿内容与密钥；错误信息里形如 `sk-...` / `Bearer ...` 的片段会被替换成 `[redacted]`。

## 卸载

```text
plugin_manager(action: "remove_bundle", target: "dsh-prompt-enhancer")
```

插件所有注册（HTTP 路由、slot 条目）都在 `ctx.effect` 里，卸载后路由与按钮一起消失；客户端半刷新页面后不再加载。

## 已知限制

- 按钮位于 `conversation.input.right`，与 `mcp-manager-quick`（`order: 40`）同列，本插件 `order: 30` 排在它左侧。
- 客户端不点击任何宿主的发送控件，也不读宿主的 DOM：只调用 `inputActions.setDraft()`。
- 页面上的真实点击（宿主是否会重渲染 slot 子组件）无法在无浏览器自动化的情况下自证，需要人工确认一次。


## GitHub 安装与验证

仓库：https://github.com/991206772-debug/dsh-prompt-enhancer

桌面版可在插件管理中使用仓库地址安装；命令行版在自己的 Profile 中安装：

~~~powershell
dsh plugin --profile web add github:991206772-debug/dsh-prompt-enhancer
~~~

公开源码不包含用户配置、笔记、真实会话、凭据或 node_modules。验证使用隔离目录，不主动重载正在运行的 DSH。

## 许可证

自有源码采用 [MIT](LICENSE)，署名 991206772-debug。
