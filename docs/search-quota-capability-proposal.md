# 搜索配额能力：kernel 最小接口补充提案

状态（2026-09-21）：**用户以「继续实现」批准接口，已完成本地实现；真实 Workers 集成验收未通过关口**。本文保留设计决策及验收缺口，不构成部署申请或上线结论。

## 1. 当前缺口与不采用的替代方案

接口补充前的本地证据（以下为设计背景，当前实现已加入预算能力）：

- `workshop-backend/src/user.ts` 的 `connectAccount()` 在用户 DO 内创建回调，回调 props 包含可信 `userId/accountId/vendorId`；这些身份并不传给连接器。
- `workshop-shared/src/gatekeeper.ts` 的 `GatekeeperConnectOptions` 只有 `scopes` 与 `resourceUrlPatterns`。
- `gatekeeper-mcp/src/mcp.ts` 每次连接均 `McpAccount.newUniqueId()`；每个连接有独立 DO，不能据此计算跨连接用户总额。
- `GatekeeperConnectCallback` 仅有连接完成、凭据失效/恢复能力；不能读取回调内部 props，也不能从它猜测用户身份。
- 现有 `reserveDailyLlmCall()` 只针对平台出资 LLM 日配额，不能复用其计数桶为个人搜索扣次。

因此不采用：前端传 email/userId、按 Token 哈希归并、按供应商邮箱归并、每个 MCP 账户各自计数、全站共享一个计数桶。

## 2. 推荐结构

由登录用户 DO 给 MCP 连接传入一个窄配额能力。能力绑定用户、连接编号和连接器；计数仍保存在同一个用户 DO，按搜索供应商归并。

| 层 | 职责与边界 |
| --- | --- |
| 用户 DO | 原子持久化配额、租约、幂等记录；不存第三方 Token、查询词或结果 |
| 新预算 WorkerEntrypoint | 固定用户/连接身份，校验连接仍存在且属于 MCP；不返回用户身份，不支持修改限额 |
| MCP 账户 DO | 保存预算能力，按固定官方端点选择供应商；不接受调用者指定的扣费主体 |
| MCP 执行客户端 | 最终参数/schema 校验后预占；外发前再次检查连接与租约；结算执行结果 |

复用现有用户 DO，不新增全局协调 DO，不新增公网配额接口，不改变 CinaSeek 登录鉴权。

## 3. 公共契约草案

以下为获批契约；权威实现为 `workshop-shared/src/gatekeeper.ts`。请求 ID 实际格式为可信连接器生成的 `${Date.now()}:${crypto.randomUUID()}`，不能由工具参数传入。

```ts
/** Personal-search quota buckets recognized by the Workshop. */
export type GatekeeperSearchProvider = "tavily" | "firecrawl";

/** One bounded permission to start a provider request. */
export type GatekeeperSearchReservation = {
  /** Absolute UTC epoch milliseconds after which dispatch is forbidden. */
  expiresAt: number;
};

/** A connection-bound capability for the owner's personal-search usage budget. */
export interface GatekeeperSearchBudget extends WorkerEntrypoint {
  /**
   * Atomically reserves one call and concurrency slot in the provider's owner-wide bucket.
   * The trusted connector generates a timestamp plus random UUID for each invocation. Retrying a
   * lost reservation response with that same id must not consume another call. A finalized or
   * expired reservation cannot be reused to execute again. Throws when unavailable or limited.
   */
  reserve(provider: GatekeeperSearchProvider, requestId: string):
    Promise<GatekeeperSearchReservation>;

  /**
   * Idempotently ends a reservation belonging to this connection. Only "not-dispatched" refunds
   * the call count; "sent-or-unknown" retains it, irrespective of the provider's response.
   * Unknown, foreign, expired, or already finalized ids cannot decrement counters twice.
   */
  settle(requestId: string, outcome: "not-dispatched" | "sent-or-unknown"): Promise<void>;
}

// Implemented optional addition to GatekeeperConnectOptions, not a parallel interface:
// /** Owner-bound search budget. Only supplied to the supported MCP connection flow. */
// searchBudget?: Fetcher<GatekeeperSearchBudget>;
```

不向前端、Agent Session 或 Gadget 公开预算能力。Gatekeeper 不把能力存在断言当作用户身份认证；身份绑定由 Workshop 的 `ctx.props` 固定。
仅正常登录后的 MCP 连接流程注入此能力；其他连接器及 `scopes: "auth"` 流程不注入，不给未登录用户建立预算。

连接器信任边界与现有 OAuth Token 持有边界相同：受信任的 MCP Worker 负责如实报告是否外发；此方案不是防御已被攻陷的 Gatekeeper Worker。

## 4. 原子计数与失败规则

- 每用户、每供应商合计：并发 2、滚动 60 秒内 10 次、每 UTC 日 100 次。多个 MCP 连接和工作区共用同一桶，Tavily/Firecrawl 分桶。
- 限额在后端常量中定义；调用方不能提供限额或重置时间。
- 在一次同步存储事务中检查并预占日计数、分钟窗口和并发位；外部 I/O 不放进事务，不锁住整个用户 DO 等待供应商。
- OAuth/discovery/参数验证先完成；排队等待审批不占并发位、不扣次数。只有实际 `tools/call` 的最后执行路径预占，直接调用和审批后调用不能分叉绕过。
- 请求 ID 由可信服务端时间戳加 `crypto.randomUUID()` 生成，不复用 actionId，不接受工具参数里的 requestId。接受最长 120 秒的 ID，允许最多 5 秒未来时差；保留 180 秒幂等记录，使清理后的旧 ID 仍不可复用。预占 RPC 结果不明时不发送搜索；当前不自动重试预占，契约允许用原 ID 查询同一次仍有效的预占。
- 已实现 60 秒租约；实际出站操作仍有不超过 30 秒的总 deadline，且不能超过租约有效期。失效租约不能启动调用。计费请求不跟随 HTTP 重定向，避免重发请求体。
- 完成、失败或取消都释放本地并发位；已发送或发送状态不明保留次数。超时租约释放并发位，但保留次数，避免崩溃后免费重试。
- **不能仅用 `McpCallNotDispatchedError` 决定退款。** 现有分类也包含已收到 HTTP 401 的请求。需独立记录最终出站是否已开始；401/403/402/429/5xx、异常正文、结果超限、网络超时均保留次数。一旦调用过 fetch 且不能证明未发出，按已发送处理。
- 本地参数不合法、目录不兼容、预占失败、外发前连接已撤销、明确的 `FetchNotStartedError` 才可退还预占次数。
- 午夜跨天仍保留未结束租约的并发占用；迟到结算只结算原预占所属日期/窗口，不减新一天的计数。
- 重复结算、外来 requestId、旧租约重放不得减少其他请求的计数。每供应商最多保留 128 条租约/幂等记录；达到记录上限时拒绝新预占，不无界增长，也不删除活跃租约。
- 预算服务异常时 fail closed；不能发请求后再补记账，也不自动重复搜索来补偿失败的结算。

这里限制的是 CinaSeek 发起的请求数与本地在途数，不是供应商美元预算，也不能保证供应商在客户端取消后立即停止后台处理。

## 5. 断开、重连与迁移

- 用户 DO 的预算记录独立于 connected-account 记录；删除账户、重新添加、刷新 Token 不重置计数。
- 预算能力绑定原 accountId；断开后拒绝新预占，允许幂等结算此前的请求。重新添加得到新 accountId，但仍落入同一用户/供应商桶。
- 普通重连保留已有预算能力，端点不可替换；供应商 Token 留在 MCP 账户，不传回用户 DO。
- 历史 MCP 连接没有 `searchBudget` 时：官方搜索端点拒绝工具执行并提示重新添加账户。**只重新 OAuth 不会补齐 connect options**，首版不假装重连即可迁移。
- 未知供应商自定义 MCP 行为不变；不存在预算能力不能作为绕过已知搜索端点策略的理由。
- 不自动断开或迁移生产账户。分开发布后端契约和 MCP 消费端，部署顺序及回滚需另行授权。

## 6. 拟实施与必须补齐的测试

1. 小范围 kernel/shared 变更：契约、预算 Entrypoint、用户 DO 持久化辅助模块、仅 MCP 的 connect options 注入；所有导出成员写 JSDoc。
2. MCP 变更：保存能力、执行前预占、精确外发状态追踪、幂等结算、缺失能力错误提示；维持原审批与 owner-only 边界。
3. Node 单测：滚动分钟边界、UTC 跨日、并发竞争、失败扣次、RPC 响应丢失、租约过期、重复结算、容量限制。
4. Linux workerd 集成：两个真实用户 DO、同用户两个连接/工作区、不同用户、不同供应商、重连/删后重加、进程重启与迟到结算；不能用模拟 Map 测试替代。
5. 真实供应商 OAuth/额度归属仍按原方案 D 单独验收；本接口审阅不授权消费额度或部署。

## 7. 已完成的独立 Phase 2 工作

- 检查搜索仍复用原 `authorizeObservation`、非只读 `submitAction` / `awaitDecision` / 非自动批准、owner-only 策略；不引入跨用户结果缓存或模拟搜索结果。
- 补充搜索专项测试：HTTP 402/429/500 不重试、不兜底，两个模拟账户并发不混凭据，发现目录后撤销连接不执行，401 更新失效状态，观察拒绝不返回结果，高成本参数不能进入审批队列。
- 修复共享 MCP 断开流程：先废止本地连接并清理持久化凭据，再尝试供应商撤销。失败日志经过已有 OAuth 脱敏。新增远端响应成功/失败/无撤销端点的测试。
- 本节历史证据是本地 Node 模拟测试，不证明 Linux DO 并发行为或生产资源状态。后续配额实现与验收状态见第 8 节。

本轮验证：共享 MCP 24 文件/370 测试，MCP 连接器 7 文件/42 测试，Portal 3 文件/43 测试，合计 455 测试通过；`pnpm lint`（含全仓库类型构建，77 任务）及 `git diff --check` 通过。未执行生产 OAuth、真实额度调用或部署。

平台语义参考：[Durable Objects SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)及[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。本轮使用项目已生成的 workerd 1.20260831.1 类型验证既有 API，没有变更兼容日期或绑定。

## 8. 获批后的本地实现与剩余验收

- 最新本地验证：共享 MCP 25 文件 / 387 测试，MCP 连接器 7 / 42，Portal 3 / 43，独立预算计数 1 / 8，合计 480 项通过；`pnpm lint`（包含脚本类型检查及全仓 77 个构建任务）和 `git diff --check` 通过。这不包含任何成功的 workerd 用例。
- kernel/shared：新增窄预算契约、固定 owner/account/vendor 的 Entrypoint；仅已登录 MCP 连接收到能力。复用用户 DO 的同步 KV，一个状态值同步读取、校验并写入，中间无 await 或外部请求，不新增 DO 或公网接口。
- 计数独立于账户记录，按用户/供应商汇总；有效账户才能预占，断开后可结算旧租约。时钟倒退不能将已写入日期/窗口倒退。只记录内部请求 ID、账户编号、供应商、时间和状态，不记录 Token、查询词或结果。
- MCP：保存能力并在重连时保留；最终执行前预占，独立记录 fetch 是否开始，结算失败不自动重发搜索。无能力的历史连接拒绝搜索，必须删除后重新添加，不声称 OAuth 重连能迁移。
- 独立纯逻辑测试与真实 DO 存储测试共用计数案例。前者命令为 `pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.search-budget.config.ts`；不会代替正常 backend 测试或移除 `assert-workerd`。
- 真实 DO 命令 `pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/search-budget.test.ts`：本机 Windows workerd 在执行测试前以 `0xc0000005 / ERR_RUNTIME_FAILURE` 崩溃，**没有任何运行时用例通过**。只读检查未发现可用的 WSL 发行版或 Docker 命令。
- 已补入 `search-budget-rpc.test.ts` 的 6 项真实 RPC 用例：跨连接竞争只放行 2 个、用户/供应商隔离、预算 Fetcher 与用户记录跨 DO 驱逐恢复、断开后的旧能力结算与删除重加、凭据失效/恢复后次数不变、外来结算与错配供应商拒绝、每日预算持久化。用例合并覆盖上述情形，尚无 Linux 通过证据。
- 测试专用 `__tests__/worker.ts` 包装并重导出生产入口；账户是无凭据夹具，连接回调、预算 Entrypoint、User DO 和同步 KV 都是真实实现。它不证明官方 OAuth、实际 MCP 跨 Worker 注入或协作工作区端到端行为；驱逐重建也不能冒充整个 workerd 进程重启。
- 正常 backend `pnpm test` / `test:run` 已加入专项 TypeScript 检查，再由正常 workerd suite 执行 8 个存储案例和 6 个 RPC 案例。保留 `assert-workerd`；测试配置明确启用生产已使用的 `allow_irrevocable_stub_storage`，未修改生产配置。
- 本轮重试两个真实运行时文件仍在测试开始前出现 `0xc0000005 / ERR_RUNTIME_FAILURE`，14 个预期用例均未执行。`tsc -p tsconfig.search-budget-tests.json` 通过只证明静态类型，不能替代 Linux 执行证据。
- 现有 `.github/workflows/ci.yml` 在 Ubuntu 上执行全仓 build/test。用户已明确授权将此次变更分组提交到独立 `codex/personal-search-budget` 分支、推送并创建 PR 以触发 CI；不包括合并或部署。新分支从 `origin/main` 建立，原成本监控分支的两个无关提交不纳入搜索 PR。
- 真实 Tavily/Firecrawl OAuth、个人/团队额度归属、供应商用量对账及部署仍未进行，需要分别完成用户参与和当前授权。

### 首次 Linux CI（PR #9，675f633c）

- [CI 35589727853](https://github.com/cinagroup/cinaseek/actions/runs/35589727853)：Lint、构建成功，backend 845 个测试通过、6 个失败；其中 `search-budget.test.ts` 的 8 个真实存储案例全部通过。
- 新增 6 个 RPC 案例全部在测试包装入口失败：`this.ctx.exports.GatekeeperConnectCallbackImpl is not a function`。补充显式命名导出以便测试池发现回调/预算 RPC loopback；必须重新运行验证，不能把此轮作为 RPC 验收通过。
- 独立治理检查：CLA 失败日志指出缺少 `cla-signatures` 分支；Bonk preflight 三次请求均超时。这些不是功能测试通过证据，未自行豁免、代签或修改规则。
