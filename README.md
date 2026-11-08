# pi-usage

Account balances, subscription quotas, and per-model session costs for the [Pi coding agent](https://pi.dev).

输入 `/usage` 开关简洁的底部余额状态栏；用 `/usage query` 在可滚动面板中查看账户详情和分模型会话用量。

- 自动复用 Pi 认证，也支持多个账户、独立环境变量凭据和声明式 HTTP JSON 查询。
- 明确区分货币余额、API key 预算、订阅配额和会话估算费用。
- 按需、事件驱动查询，不调用模型、不轮询、不把结果写入会话或模型上下文。
- 每个账户有总超时，最多 4 路并发；不展示原始响应和可能含密钥的异常。

**要求：Pi >= 1.5.0、Node.js >= 22.19。** 使用 `@earendil-works` 发行版，未验证旧版 `@mariozechner` 的兼容性。

> 已进行类型、运行时模拟与打包检查，未使用真实账户验证提供商接口。实验性、非公开接口可能随账户权限、地区或服务端更新失效；请与官方控制台核对。

## 安装

```bash
pi install npm:pi-usage-balances
```

也可从 GitHub 安装：

```bash
pi install git:github.com/pureSaviour/pi-usage
```

选择一种安装方式即可，然后重启 Pi，或执行 `/reload`。不要同时启用其他注册 `/usage` 命令的扩展。

本地开发可用 `pi -e ./src/index.ts` 临时加载，或通过 `pi install /absolute/path/to/pi-usage` 安装。TypeScript 由 Pi 加载，无需构建。

npm 包名为 **[`pi-usage-balances`](https://www.npmjs.com/package/pi-usage-balances)**。npm 上的 `pi-usage` 属于其他项目，不是本插件。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/usage` | 开关当前会话的底部状态栏，默认关闭 |
| `/usage on`、`/usage off` | 显式开启、关闭 |
| `/usage refresh` | 立即刷新已开启的状态栏 |
| `/usage query` | 详细查询当前模型对应的账户 |
| `/usage all` | 查询全部发现的账户 |
| `/usage <账户ID或提供商ID>` | 查询指定账户或提供商 |
| `/usage list` | 列出账户和内置适配器，不查询网络 |
| `/usage clear` | 取消详细查询并清除查询提示，不关闭状态栏 |
| `/usage help` | 查看帮助和实际配置路径 |

详细结果支持 `↑↓`、`PgUp/PgDn`、`Home/End`，用 `Enter/Esc` 关闭。按终端宽度自动换行，不受字符串 widget 的 10 行限制。RPC 通过 UI 通知返回详情；无 UI 模式输出到 stderr，不混入 JSON stdout。

### 状态栏

```text
DeepSeek · 余额 12.5 CNY
```

只显示一个账户名和主要余额；没有货币余额时显示首个配额的剩余比例或数量。不显示模型 ID、时间或重复的充值/赠送分项，也不替换 Pi 默认 footer。其他扩展若完全自定义 footer，需自行渲染 Pi 的 extension statuses。

开启、切换模型时立即查询；模型回复完全结束后，距上次尝试至少 60 秒才刷新。空闲时不轮询。关闭、切换模型或退出会话会取消相应请求，迟到结果不会覆盖新状态。

同一提供商有多个查询账户时，状态栏只查询第一个匹配账户。值是最近一次查询结果，不是实时余额；开关不持久化，重启、切换会话或 `/reload` 后恢复关闭。

### 会话费用

详细查询为已确认使用 API 凭据的账户显示当前会话、当前分支的用量：

- 按 provider/model 聚合 assistant 消息和独立 `usage` 记录，列出费用、调用次数以及输入、输出、缓存读写 tokens。
- 只使用 Pi 已记录的 `usage.cost.total`，以 USD 显示；不猜测缺失的费用。压缩摘要等没有 provider/model 归属的记录不纳入统计。
- 默认是 Pi 价格表估算，**不是提供商账单，不能直接从账户余额中扣减**。提供商上报和混合费用会分别标注来源。
- 余额查询失败但 API 认证类型明确时仍显示会话用量；OAuth 账户不显示金额会话用量。无法确认认证类型时不猜测。
- Pi 不记录每次调用实际用了哪一个 API key。同一 provider 下多个 API 账户会显示该 provider 的同一份会话用量，不能据此拆分账户消费。

显示文本会移除圆括号中的补充内容，必要的费用来源保留为单独一行。

## 内置适配器

这些是实现范围，不代表所有账户均已通过实测。

| ID | 查询内容 | 主要限制 |
| --- | --- | --- |
| `deepseek` | 总余额、充值、赠送 | API key；币种由服务端返回 |
| `openai` | 新 ChatGPT Plan Usage 的能力限制与官方用量页 | 暂无已核实的直接配额接口；普通 OpenAI API key 也不支持余额查询 |
| `openai-codex` | 主/次窗口、附加窗口、额外积分 | 旧 Codex OAuth；实验性非公开接口 |
| `anthropic` | Claude 5 小时、周及分组窗口 | 有查询权限的 OAuth；实验性非公开接口，普通 API key 不支持 |
| `github-copilot` | 服务端返回的订阅配额类别 | 原始 GitHub OAuth token；实验性非公开接口；自定义 Enterprise 域需自定义查询 |
| `kimi-coding` | 5 小时、周、月配额或旧版窗口 | Kimi Code key/OAuth；实验性接口 |
| `openrouter` | 账户 credits、API key 预算 | 权限决定范围；credits 失败时保留可用的 key 预算 |
| `moonshotai`、`moonshotai-cn` | 可用、现金、代金券余额 | 国际区 USD、中国区 CNY 的 API key |
| `zai`、`zai-coding-cn` | Coding Plan 窗口百分比和计数 | 国际区、中国区；实验性非公开接口，不猜测周期 |
| `minimax`、`minimax-cn` | Coding Plan 当前窗口和周窗口 | 国际区、中国区 Coding Plan key；不代表 API 充值余额 |
| `vercel-ai-gateway` | 网关可用余额 | AI Gateway key |
| `siliconflow` | 总余额、充值、赠送 | 中国区 API key |

**新旧 OpenAI 认证不混用。** 新 `openai` 登录的令牌面向 `api.openai.com/v1`，不能用来查询旧 Codex 的 `wham/usage`。插件会停止这类请求，提示前往 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage)，不会要求为此重新登录、交换令牌或回退到另一账户。已单独登录旧 Codex 时，可显式查询 `/usage openai-codex`；其窗口不代表新授权的配额，也不是 ChatGPT 网页全部模型的消息限额。

Google/Gemini、Bedrock、Vertex、Azure 及其他未内置的服务会明确显示不支持。推理凭据不等于组织级账单权限，可用自定义 HTTP 查询接入确有权限的数据源。

内置查询只使用固定的官方地址，不从模型 baseUrl 推导。第三方中转、私有部署和特殊域名应使用自定义查询，避免把中转 key 发给不相关的官方接口。

## 配置

默认读取 `~/.pi/agent/pi-usage.json`，路径通过 Pi 的 `getAgentDir()` 获取。可用 `PI_USAGE_CONFIG` 指定其他可信文件；相对路径按启动工作目录解析。不读取项目级配置。

每次查询重新读取配置，修改后无需 reload。基础示例见 [examples/pi-usage.json](examples/pi-usage.json)。

```json
{
  "version": 1,
  "timeoutMs": 15000,
  "disabledProviders": ["google"],
  "accounts": [
    { "id": "deepseek-personal", "provider": "deepseek" },
    {
      "id": "deepseek-work",
      "name": "DeepSeek 工作账户",
      "provider": "deepseek",
      "tokenEnv": "DEEPSEEK_WORK_API_KEY"
    }
  ]
}
```

- `tokenEnv`：指定时只用该环境变量，不回退到 Pi；不负责刷新环境变量中的 OAuth token。未指定时使用 Pi 认证解析。
- `name`：显示名；不读取或推测真实的账户身份。
- `adapter`：默认等于 provider。自定义 Pi 提供商可配置 `"adapter": "siliconflow"` 等。
- `enabled: false`：禁用该账户。
- `disabledProviders`：仅禁用自动发现；显式账户仍按自身 enabled 控制。
- 显式账户替代同一 provider 的自动账户，包括禁用账户，避免重复查询。
- 当前模型查询只匹配当前 provider：优先同名账户 ID，否则选择该 provider 全部启用账户。指定目标时优先精确账户 ID，再按 provider 匹配。
- ID 只能以字母或数字起头，后续允许字母、数字、下划线、点和连字符；不得重复或使用命令保留字。
- `timeoutMs` 默认 15000，允许 1000–60000 的整数，覆盖认证和账户查询。未知字段会报错。自动发现按提供商去重，最多 4 个账户并发。

## 自定义 HTTP 查询

完整示例见 [examples/custom-http.json](examples/custom-http.json)。示例默认禁用，需替换 URL、字段路径并启用；示例域名不是真实服务。

```json
{
  "version": 1,
  "accounts": [{
    "id": "my-gateway",
    "provider": "my-gateway",
    "tokenEnv": "MY_GATEWAY_TOKEN",
    "request": {
      "url": "https://gateway.example.com/api/balance",
      "headers": { "Authorization": "Bearer ${token}" }
    },
    "response": {
      "success": { "path": "code", "equals": 0 },
      "metrics": [{
        "kind": "balance",
        "label": "账户余额",
        "remaining": { "path": "data.balance" },
        "unit": { "value": "CNY" }
      }]
    }
  }]
}
```

### 请求

- `method` 为 GET 或 POST，默认 GET。POST `body` 为 JSON，GET 不允许 body。
- URL、请求头和 JSON body 的字符串支持 `${env:NAME}`；`${token}` 引用 tokenEnv 或显式授权的 Pi token。
- **向自定义地址发送 Pi token 必须设置 `request.usePiAuth: true`，并在 headers 中自行引用 `${token}`。** 不自动复制 Pi 认证头。
- 可不用 Pi/tokenEnv，改用 header 中的环境变量配置独立查询密钥或 Cookie；此时不假定模型调用使用同一认证类型。
- 仅允许 HTTPS；禁止 URL 用户名、密码、片段以及自动重定向。调试用 `allowHttp: true` 会允许任意 HTTP 地址，勿用于公网密钥传输。
- 每个响应最多 1 MiB；单个指标映射最多遍历 100 项；每个账户最多 100 个指标映射。

### 响应映射

| 字段 | 含义 |
| --- | --- |
| `kind`、`label` | 必填；kind 为 balance 或 quota |
| `itemsPath` | 可选数组路径，为每项生成指标，其余路径相对此项 |
| `remaining`、`used`、`limit` | 数量；balance 必须配置 remaining 和 unit |
| `usedPercent`、`remainingPercent` | 百分数，25 表示 25%；同时配置时 usedPercent 优先 |
| `unit` | 币种或 requests、tokens、credits 等单位 |
| `resetAt`、`resetFormat` | 时间及格式；auto、seconds、milliseconds，默认 auto |
| `unlimited` | 只有 JSON 布尔 true 表示不限量 |

每个字段是 `{ "path": "data.balance" }` 或 `{ "value": "CNY" }`，二选一。可加 `scale`，如 0.01 将分转为元、100 将比例转成百分数。路径支持 `data.windows[0].remaining` 和根路径 `$`，不是完整 JSONPath，不支持脚本、表达式或 eval。

配额有数量与 limit 时会推导另一项及百分比；只返回百分比时不虚构绝对额度。0 是有效值，缺失字段不是 0；无有效指标会报错，不冒充成功。

建议配置 `response.success` 对业务码做严格相等检查，失败不解析余额。`response.plan` 可映射套餐名。

## 凭据与隐私

- Pi 公共认证解析可能正常刷新并保存 OAuth；插件本身不维护登录文件。超时会停止等待和后续查询，但无法中断 Pi 未提供取消接口的认证刷新。
- Copilot 特例：只读 Pi 存储的原始 GitHub OAuth token，不用短期推理 token 查配额。
- 不扫描浏览器 Cookie、不执行自定义 Shell/脚本。Pi 配置的 secret-manager key 命令仍可能由 Pi 自己执行。
- 自定义配置是敏感授权边界：usePiAuth、tokenEnv、环境变量模板会把凭据交给配置的目标地址，只能使用可信地址和配置文件。
- 不显示原始响应、HTTP 错误正文或认证/网络原始异常。外部显示文本会过滤终端控制字符。
- 结果不通过 `sendMessage` 或 `appendEntry` 持久化；终端录屏、RPC 客户端和 stderr 重定向仍可能留存显示内容。
- 会话用量仅在显式详细查询时读取；不额外收集提示、回复或工具内容。关闭会话或卸载时取消查询并关闭详情面板。

## 开发与发布

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

仓库不包含真实凭据、生成产物或临时模拟测试文件。运行时没有额外 dependencies；Pi 提供的模块通过 peerDependencies 声明。

Pi 官网 [Package Catalog](https://pi.dev/packages) 从 npm 发现带 `pi-package` 关键词的包。清单已配置该关键词、仓库地址和公开发布设置；npm 发布后仍需等待官网索引，**不代表获得官网人工推荐或置顶**。

```bash
npm login
npm publish --access public
```

后续发布先更新 package.json 和 package-lock.json 中的版本号，再检查、提交并发布。npm 已发布的版本不能覆盖；安装无需等待 Pi 官网目录完成索引。

## 参考

- [Pi 扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [包分发文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [OpenAI 用量查看](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage) · [令牌受众与 scope](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance) · [Moonshot 余额接口](https://platform.moonshot.ai/docs/api/balance)
- [OpenRouter key 接口](https://openrouter.ai/docs/api-reference/api-keys/get-current-key) · [Vercel AI Gateway](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway)
- [CodexBar 的公开提供商协议资料](https://github.com/steipete/CodexBar/tree/main/Sources/CodexBarCore/Providers)：仅参考协议与字段语义，本项目独立实现，不依赖 CodexBar。

MIT License. 术语见 [GLOSSARY.md](GLOSSARY.md)。
