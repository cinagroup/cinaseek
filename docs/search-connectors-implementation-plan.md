# Tavily / Firecrawl 个人账户搜索连接器实施方案

状态（2026-09-21）：用户已批准 Phase 2 和 [最小配额能力提案](search-quota-capability-proposal.md)。跨连接配额已完成本地实现和逻辑回归；Windows workerd 启动崩溃，Linux 真实能力/DO 集成仍为验收缺口。已授权独立分支提交、推送及 PR/CI；未连接真实账户、未执行付费请求，未授权合并或部署。

## 1. 目标与首期范围

- 用户通过官方 OAuth 连接自己的 Tavily / Firecrawl 账户，调用使用该授权账户或团队的额度。
- 复用 `gatekeeper-mcp` 和 `mcp-shared`，不新增两套 Worker、OAuth 实现或平台共用 Key。
- 首期入口位于现有「MCP Server」连接页：Tavily、Firecrawl、自定义 MCP。
- 当前实现只开放 Tavily 搜索、Firecrawl 搜索；不开放 Crawl、Research、浏览器操作、批量任务。原拟单页正文读取因下述成本控制阻塞暂缓。
- 个人 Key 备用接入属于后续独立里程碑；现有通用 MCP 表单没有安全的个人 Key 输入/存储流程，不通过 URL 查询参数变相实现。
- 不自动安装连接，不自动注入工作区，不把两个服务用作 CinaSeek 登录身份提供方。

## 2. 已核实的本地基础

| 位置 | 可复用机制 / 必须补齐的行为 |
| --- | --- |
| `packages/gatekeeper-mcp/src/connect-form.ts` | 当前只有端点输入表单，可增加预设选择及付费提示 |
| `packages/gatekeeper-mcp/src/mcp.ts` | 连接 nonce、账户 DO、端点固定、工具级资源绑定与配置器 |
| `packages/mcp-shared/src/account.ts` | OAuth discovery、PKCE、Token 刷新、断开与撤销；当前允许握手成功后降为匿名，个人 OAuth 预设必须禁止此降级 |
| `packages/mcp-shared/src/scope.ts` | `<endpoint>#tool=...` 精确授权；不带工具限制表示全部工具，不能用于搜索预设 |
| `packages/mcp-shared/src/session.ts` | 工具调用统一入口、观察记录、非只读工具审批 |
| `packages/mcp-shared/src/schema-to-ts.ts` | 根据已授权工具生成类型及命名方法，不必新增静态搜索 RPC |
| `packages/mcp-shared/src/sharing-policy.ts` | MCP Gadget 为所有者使用；不能让协作者隐式消耗所有者余额 |

## 3. 接口审阅提案

### 3.1 保持现有公共 RPC，不新增搜索 Session 接口

沿用 `GatekeeperVendor.connectAccount(callback, options)`、`GatekeeperUser` 以及现有 MCP Session。
不新增与真实接口平行的手写 RPC 类型。以下只是现有调用契约摘要，不是待提交的新 `types.d.ts`：

```ts
// 调用方从绑定生成的类型中取得实际签名及可用工具参数。
listTools(options?)
callTool(name, args?)
getActionResult(actionId)
```

结果沿用 `McpCallResult`，保留工具错误与正常响应的区别；不伪装成统一且已验证的搜索结果结构。
命名工具方法继续从供应商工具 schema 生成。新增说明仅描述能力、参数、返回值和错误；
不在新方法说明中泄漏审批队列或凭据存储实现。

### 3.2 连接入口契约

- 预设 POST 只接收供应商标识 `tavily` / `firecrawl`，服务端映射固定 HTTPS 端点。
- Tavily：`https://mcp.tavily.com/mcp`。
- Firecrawl：`https://mcp.firecrawl.dev/v2/mcp-oauth`，不是匿名/Key 入口 `/v2/mcp`。
- 不接受客户端覆盖预设端点、付费主体、凭据、工具白名单或限额。
- 复用账户 DO 已持久化的固定端点作为预设身份，服务端按端点派生当前策略，不添加可与端点失配的第二份身份字段；重连不能切换供应商或降为匿名连接。
- 只有 OAuth 完成且取得该账户凭据后，才能报告预设连接成功。
- 未知供应商的自定义 MCP 保留现有行为。手动输入上述官方主机同样执行预设策略；历史匿名/平台 Token 连接必须重新 OAuth，非规范路径、查询参数等变体明确拒绝。

### 3.3 资源权限契约

- 当前白名单：Tavily `tavily_search`；Firecrawl `firecrawl_search`。`firecrawl_scrape` 暂不授予。
- 实施时以官方工具文档和实际授权后的目录核实精确名称、schema；名称或 schema 不兼容时禁用并报错，不猜测别名、不回退全工具。
- 策略在服务端执行：授予范围为用户选择与预设白名单的交集。
- 枚举、工具搜索、生成类型、命名方法、`callTool`、排队后实际执行均使用同一限制。
- 直接传无 fragment 的资源 URL、使用自定义入口连接同一已知端点、篡改参数，都不能绕过该供应商的服务端策略。
- 未知查询参数/端点变体不得静默继承预设身份；制定并测试精确匹配及拒绝规则。
- 不把品牌预设升级为 `vetted`，不覆盖供应商工具的只读分类；未声明只读的工具保留审批行为。
- 上游 OAuth 可能授权较宽范围；界面必须区分上游授权与 CinaSeek 工作区工具限制，不声称供应商颁发的是搜索专用 Token。

## 4. 个人额度与调用保护

扣费主体是第三方授权实际关联的个人/团队，不根据 CinaSeek 邮箱猜测。若供应商未提供可信账户、团队或余额字段，显示「请到供应商控制台确认」，不编造额度。

限制与实现状态（次数/并发保护已编码，真实 Workers 集成待验收；不是美元级硬预算）：

| 项目 | 建议值 / 行为 |
| --- | --- |
| 每个 CinaSeek 用户、每供应商总并发 | 已编码：2；60 秒在途租约；真实 DO 并发测试待 Linux |
| 每分钟 / 每 UTC 日工具执行次数 | 已编码：滚动 60 秒 10 / UTC 日 100；跨该用户同供应商连接汇总，删除重加不清零 |
| 搜索 | 已限制请求参数：默认 5、最多 10；Firecrawl 不开放额外来源选项。供应商是否遵守返回条数仍需真实账户验收 |
| Tavily | 固定 Basic、禁用自动提档；不开放额外研究功能 |
| Firecrawl 搜索 | 已禁止 scrapeOptions、额外 sources、enterprise 等附加选项，不自动抓全部结果正文 |
| Firecrawl 单页读取 | 暂不开放；禁用 PDF 解析的参数传递尚不能确认 |
| 单次执行超时 | 30 秒；不因结果未知自动重试计费调用 |
| 单次结果大小 | 已限制工具调用 JSON/SSE 响应最大 256 KiB；超过上限失败，不返回伪装完整的部分结果 |
| 额度耗尽 / 限流 | 显示供应商错误并停止；不切平台 Key、不切其他用户连接 |

限额在可信执行入口原子检查并记账，不是前端提示。排队中的操作在真正执行前再次检查。
仅在确实未发出请求时释放执行预占；上游超时且扣费不明不能当作免费失败。
结果截断及请求取消不保证供应商免收费；这些是资源保护，不是美元级硬预算。
按用户跨连接的计数身份必须由现有已认证能力派生，不接受浏览器提供的 email/userId。
若实现需要新增 kernel 公共契约，单独提交最小接口补充审阅，不能退化成可通过重新连接绕过的限额。

## 5. 隐私、凭据和共享

- Token 留在账户服务端边界；日志、错误、URL、前端持久化、Agent 上下文均不包含凭据。
- 审核现有存储保护及日志脱敏；不把「仅服务端存储」描述为新增的应用层加密。
- 继续使用 `sdkFetch` 和现有 SSRF/重定向检查，不放开私网以修复 OAuth。
- 用户知道搜索词/目标 URL 会发往第三方；对查询和结果内容采用最小化日志。
- 不新增跨用户结果缓存；网页正文是外部不可信数据，不赋予其指令权限。
- 断开后停止后续调用并清理本地凭据，远端撤销按供应商支持执行；不能声称可以撤回已发出的请求。
- 首期保留 owner-only 共享策略。将来要「共享 Gadget、每位访问者自行付费」需另设计每访问者绑定，不能直接复用所有者 Token。
- 禁止平台共用 Key 兜底、Firecrawl Gateway 代付或自动购买额度。

## 6. 实施清单及验收

### A. 设计关口

- [x] 核实现有 MCP 连接、工具作用域、Session 与 OAuth 生命周期。
- [x] 形成复用接口、首期范围及个人额度策略。
- [x] 用户以「开始推进」批准实施本文路线；API Key 备用后置。

### B. 核心连接实现

- [x] 增加供应商预设表、固定端点与连接页选择；保留自定义 MCP。
- [x] 复用账户固定端点、OAuth 必需校验及已有取消/过期/重连机制；模拟 OAuth 测试覆盖公开握手、跨实例回调和回调重放拒绝，真实账户流程待 D。
- [x] 限定工具配置器、资源授权、动态类型和实际执行入口；隔离旧的宽权限目录缓存。
- [x] 添加参数白名单与高成本选项拒绝，默认值不能被嵌套参数绕过。
- [x] 新增单元测试并跑相关包测试及构建（证据见第 8 节）。
- [x] 按 `write-gatekeeper` 规范报告阶段结果，用户以「开始推进」确认进入 Phase 2；不部署、不对外开放。

### C. Phase 2：安全、调用保护与回归（另经确认后）

- [x] 核实跨连接身份缺口，形成独立 kernel 配额能力提案；用户以「继续实现」批准，不退化为每连接限额。
- [x] 补充搜索专项审批/观察、模拟账户凭据隔离、402/429/500/401、外发前撤销回归；修复本地断开在远端撤销等待期间仍可取凭据的问题。
- [ ] 审核观察/审批、owner-only、凭据生命周期和日志脱敏，维持已有安全边界。
- [x] 实现跨连接配额能力、用户 DO 内无 await 的同步预占/写入、失败扣次和无自动兜底；运行时原子性仍按后续 Linux 集成项验收。
- [ ] 测试直接 RPC、匿名降级、端点替换、旧回调重放、未知工具、工具目录变更。
- [ ] 测试取消登录、OAuth 刷新/撤销、额度耗尽、429、超时和异常响应。
- [ ] 使用两位独立测试用户证明凭据/计数隔离、重新连接不重置限额、协作者不能消耗所有者额度。
- [ ] 验证相关单测、类型检查、`pnpm lint`；真实 Workers 行为须有 Linux workerd/CI 证据。

### D. 真实账户验收与上线（需用户参与）

- [ ] 用户分别完成两家官方登录；不在聊天中发送 Token 或 Key。
- [ ] 授权最小搜索/抓取测试的实际额度消耗；对比供应商控制台前后用量，记录账户/团队归属。
- [ ] 如无可信余额查询，不显示实时余额；不能用一次请求成功替代扣费归属验证。
- [ ] 验证断开和重连，测试数据清理限于明确的测试资源。
- [ ] 汇总证据与未通过项；部署前取得当前变更的明确部署授权，不沿用历史部署授权。

## 7. 官方依据（2026-09-21 对话已核实）

- Tavily OAuth 与个人/团队默认 Key：https://github.com/tavily-ai/tavily-mcp#remote-mcp-server-oauth-flow
- Firecrawl OAuth：https://docs.firecrawl.dev/mcp-server/oauth
- Firecrawl MCP 登录与 Key 关联套餐：https://docs.firecrawl.dev/mcp-server
- Firecrawl Partner / Gateway 扣费差异：https://docs.firecrawl.dev/partner-integration
- Tavily 工具定义：https://github.com/tavily-ai/tavily-mcp/blob/main/src/index.ts
- Firecrawl 工具定义和参数清理：https://github.com/firecrawl/firecrawl-mcp-server/blob/main/src/index.ts

以上证明供应商声明的能力，不证明 CinaSeek 已完成端到端兼容性或费用验收。

## 8. Phase 1 验证与明确未完成项

### 本地证据（2026-09-21，Windows）

- `pnpm --filter @gadgets/mcp-shared test:run`：23 文件、352 测试通过。
- `pnpm --filter @gadgets/mcp-gatekeeper test:run`：7 文件、42 测试通过。
- `pnpm --filter @gadgets/mcp-portal-gatekeeper test:run`：3 文件、43 测试通过。
- `pnpm --filter @gadgets/mcp-shared build`：通过，包含测试代码类型检查。
- `pnpm exec vp run -F @gadgets/mcp-gatekeeper -F @gadgets/mcp-portal-gatekeeper build`：通过，含配置器生成。
- `pnpm lint`：通过，包含全仓库 lint、脚本类型检查及 77 个构建任务；现存非阻断警告保留。
- 验证覆盖固定端点、防覆盖、OAuth 必需、匿名/平台 Token 拒绝、搜索工具与参数白名单、缓存迁移、执行前目录复核、计费调用不自动重试、过期会话清理及 JSON/SSE 大小上限。
- 这些测试使用模拟 MCP/OAuth，不证明真实供应商兼容性、归属额度、Linux workerd 或浏览器端到端验收完成。

### Firecrawl 单页读取阻塞

2026-09-21 检查官方 MCP 源码时，`removeEmptyTopLevel()` 会删除空数组；
`firecrawl_scrape` 参数经此函数清理后传给上游。因此不能依赖 `parsers: []` 稳定禁用 PDF 解析。
当前直接拒绝 `firecrawl_scrape`，不悄悄允许潜在高成本解析。
恢复此工具前必须确认托管 MCP 传递策略或另行设计可强制控制解析的单页接口，并补上实际额度验收。

### 当前阶段关口

- Phase 2 当前验证：共享 MCP 387、MCP 42、Portal 43、预算计数纯单元 8 项本地测试通过（合计 480）；全仓库 `pnpm lint`（含 77 个构建任务）及 `git diff --check` 通过。上方 Phase 1 计数为历史证据。
- 已实现每用户/每供应商并发、分钟/日次数限制，使用同步用户 DO 存储；同样的计数案例已接入正常 backend workerd 测试。该运行时在 Windows 执行用例前崩溃，不能宣称 DO/RPC/重启集成通过。
- 经批准最小修改 Workshop kernel/公共 Gatekeeper 契约；未修改 Worker 绑定、生产 Secrets、部署配置，没有自动安装连接或赋予 ambient 权限。预算能力不向前端、Agent 或 Gadget 暴露。
- 已覆盖旧连接缺少预算时拒绝搜索、重连保留能力、撤销清理能力、预占失败不外发、发送后错误保留计数、重复结算、午夜和租约过期、拒绝计费重定向重发。真实 Linux 能力传递、用户 DO RPC 并发、删除重加、重启及协作工作区验收仍未完成。
- 下一关口为 Linux workerd/CI 和 D 的真实账户验收；真实登录、消耗额度和部署仍分别取得当前授权。

### Linux CI 前的集成测试补充（2026-09-21）

- 新增 6 项真实 RPC 测试，覆盖跨连接并发、用户/供应商隔离、断开/重连、外来结算、能力持久化与 DO 驱逐恢复；复用已有 8 项真实存储计数案例。
- 专项测试类型检查已加入 backend 的正常 test 任务和 `test:run`；测试包装入口不进入生产构建，生产绑定、兼容日期和 Secrets 均未改变。
- 本地尝试这 2 个 workerd 文件仍在启动阶段崩溃，**14 个预期用例未执行，不计入 480 项已通过测试**。
- 仍需补齐实际 MCP 跨 Worker 连接注入、协作工作区和完整进程重启验收；无凭据账户夹具和 DO 驱逐不能代替它们。
- Ubuntu CI 已有全仓 build/test 路径；用户已明确授权本次变更分组提交至 `codex/personal-search-budget`、推送并创建 PR。此授权不包括合并 main、部署或真实供应商额度调用。
