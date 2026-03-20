# E2B 上下文管理实施状态（Phase1 + Phase2）

更新时间：2026-03-20

## 1. 已实现内容

## 1.1 Phase1：Token 分项埋点

已在路由与 Agent 两层接入 token 可观测性。

- 路由层：记录历史构建前后的消息数、token 数、是否触发压缩/摘要。
  - 文件：[api/server/routes/e2bAssistants/controller.js](api/server/routes/e2bAssistants/controller.js)
  - 日志标签：`[E2B Assistant][ContextMetrics]`

- Agent 层：记录 system/history/user 的 token 估算值，以及预算配置。
  - 文件：[api/server/services/Agents/e2bAgent/index.js](api/server/services/Agents/e2bAgent/index.js)
  - 日志标签：`[E2BAgent][TokenMetrics]`

## 1.2 Phase2：History 窗口化 + 摘要化

已新增历史构建器并替换原全量 history 直传逻辑。

- 新增模块：
  - [api/server/services/Agents/e2bAgent/historyBuilder.js](api/server/services/Agents/e2bAgent/historyBuilder.js)

- 路由接入：
  - [api/server/routes/e2bAssistants/controller.js](api/server/routes/e2bAssistants/controller.js)

- 当前策略行为：
  1. 历史消息先做文本清洗（去 UUID 噪声）。
  2. 近期窗口优先：始终保留最近窗口原文（短期连贯性优先）。
  3. 压缩触发改为简化策略：
      - 每 `summaryRefreshTurns` 轮重做摘要（默认 20 轮）。
  4. 触发压缩时，`older history` 通过一次模型 compaction prompt 生成结构化摘要（5 段模板）：
    - User Goal
    - Completed Steps
    - Key Conclusions
    - Current File/Data State
    - Pending Items
  5. `recent window`（默认 24 条）保留原文，不参与摘要改写。
  6. 压缩结果直接使用“摘要 + recent window”结构，不再做额外二次裁剪。

## 1.3 2026-03-20 收口：前后端压缩链路完成

本轮已完成压缩能力在后端与前端的闭环收口，并完成真实会话验证。

- 后端压缩判定加固（historyBuilder）：
  1. 去除 fallback Unknown 摘要注入路径。
  2. 新增回退条件：`no-older-history`、`summary-unavailable`、`no-token-savings`。
  3. 仅在 `outputTokens < rawTokens` 时标记 `compressed=true`，避免“伪压缩”。

- 后端可观测性增强（controller）：
  1. 保留 `[E2B Assistant][ContextMetrics]` 指标日志。
  2. 新增 `[E2B Assistant][ContextSummary]`，在 `summaryInserted=true` 时输出摘要正文，便于线上核对实际摘要内容。

- 前端流式可视化与稳定性修复：
  1. 修复 SSE 流式过程中 `e2bContextMetrics` 丢失导致卡片消失的问题（message/content/step handler 全链路保留）。
  2. 修复思考点定位错位（相对定位容器调整）。
  3. 压缩卡片改为“仅 `compressed=true` 显示”，并使用 `messageId` 级缓存减轻流式帧抖动。

- 真实会话验证结论：
  1. 已验证触发 cadence 后，history 首条为 `Prior Conversation Summary (compressed)` system message。
  2. 已验证最近一次压缩出现真实 token 降幅（示例：`11479 -> 9332`，节省 `2147`，`18.7%`）。
  3. 已验证数据库不落库 summary 正文，summary 为运行时注入到 LLM history。

---

## 2. 默认策略（当前生效）

当前通过 `contextManagement` 配置读取，未配置时使用默认值：

- `messageWindowSize`: 24
- `summaryRefreshTurns`: 20
- `estimatedSystemTokens`: 3000
- `compactionSummaryMaxTokens`: 1200
- `reserveOutputTokens`: 3000
- `toolObservationMaxChars`: 6000

说明：

- `reserveOutputTokens` 与 `toolObservationMaxChars` 目前已纳入 Agent 层埋点与配置读取。
- 真正用于工具 observation 压缩将在 Phase3 实施。

### 2.0 最近原文保留规则（补充）

- `messageWindowSize` 的单位是“消息条数”，不是“轮数”。
- 当前默认 `messageWindowSize = 24`，通常约等于最近 12 轮原文（按 1 轮约 2 条消息估算）。
- 触发压缩时，不是对上一次摘要结果继续叠加，而是每次都从数据库历史重建：
  - 更早段历史进入摘要。
  - 最近 24 条消息保持原文。
- 示例（按常见 1 轮≈2 条消息）：
  - 在第 41 轮请求触发压缩时，历史约有前 40 轮。
  - 其中前约 28 轮进入摘要，后约 12 轮保留原文。

---

## 2.1 前端可视化（新增）

已支持在对话消息中展示压缩过程状态卡片（基于 SSE 实时事件）。

- 事件：`on_context_metrics`
- 来源：`controller.chat` 在 history 构建后发送
- 展示内容：
  - 仅在压缩时展示 `Context Compressed`（`compressed=true`）

备注：详细指标（触发原因、节省 token、prompt 估算、轮次等）统一保留在后端日志中。

---

## 3. 验证结果（token 下降 + 一致性）

已新增验证脚本：

- [api/tests/e2b/validate_context_management.js](api/tests/e2b/validate_context_management.js)

执行结果：

- long-conversation：messages 89 -> 12，tokens 20913 -> 2905，下降 86.11%
- short-conversation：messages 7 -> 7，tokens 35 -> 35，下降 0.00%
- 所有一致性断言通过（最近窗口消息保留、初始目标锚点/摘要保留）

结论：

1. 长会话场景下，当前 Phase2 策略对 token 压降有效。
2. 短会话场景下，不会引入额外压缩副作用。
3. 近期上下文一致性（最近窗口）在测试中保持不变。

### 3.1 新增测试 1：路由集成测试（已通过）

脚本：

- [api/tests/e2b/integration_route_context.js](api/tests/e2b/integration_route_context.js)

验证目标：

1. 走 `controller.chat` 主链路（mock 外部依赖），确认路由层实际使用了压缩 history。
2. 确认压缩 summary 与文件 reminder 可同时存在。

执行结果：

- input db messages: 80
- output history messages: 13
- has summary: true
- has file reminder: true

### 3.2 新增测试 2：回放 AB 测试（已通过）

脚本：

- [api/tests/e2b/replay_ab_context_consistency.js](api/tests/e2b/replay_ab_context_consistency.js)

验证目标：

1. 对比“压缩关闭（baseline）/压缩开启（default）”的 token 变化。
2. 校验关键语义信号保留（目标、近期约束、近期结果、近期行动）。
3. 校验最近窗口消息逐条一致。

执行结果：

- A: messages 69 -> 12, tokens 10479 -> 1763, reduction 83.18%
- B: messages 69 -> 12, tokens 10479 -> 1763, reduction 83.18%
- C: messages 69 -> 12, tokens 10479 -> 1763, reduction 83.18%
- All replay AB checks passed.

---

## 4. 待实现内容

## 4.1 Phase3（未实现）

工具 observation 压缩（仅模型回灌通道压缩，前端展示仍保留完整输出）：

- 对 stdout/stderr/traceback 做结构化提炼。
- 保留关键统计信息、错误类型、核心栈信息。
- 限制超长工具输出进入后续 ReAct 迭代。

## 4.2 Phase4（未实现）

System Context 瘦身：

- 文件说明按需注入，减少固定提示词体积。
- artifact 上下文结构化并限制数量。

## 4.3 Phase5（未实现）

评测与灰度：

- 构建真实多轮 E2B 数据集（含图表、导出、错误恢复）。
- 指标：任务成功率、关键结论准确率、token 成本、P95 延迟。
- 通过开关灰度逐步放量。

---

## 5. 当前局限与下一步建议

当前验证为“离线构造消息”的快速回归验证，未覆盖真实线上全部分布。

补充说明：

1. 新增的路由集成测试已覆盖 `controller.chat` 的服务内链路。
2. 但两类测试都未触达真实外部 LLM API 的答案质量波动（这是下一阶段真实回放评测的范围）。

建议下一步：

1. 增加真实会话回放测试（从数据库抽样匿名会话）。
2. 落地 Phase3，并与 Phase2 联合评测“降本不降质”。
3. 为关键开关增加环境配置与发布灰度策略。

---

## 6. 策略复盘与优化方向（结合 OpenCode）

### 6.1 修改前风险复盘（已识别）

旧策略曾包含 `promptCompressionTokens` 触发条件。若在第 60 轮时同时满足：

- 命中 cadence（例如每 20 轮）
- 且 `estimatedPromptTokens` 持续高于阈值（例如 > 60000）

则会出现“本轮压缩后，下轮仍满足阈值，再次触发压缩”的高频压缩风险。

### 6.2 当前策略结论（已落地）

当前已切换为“仅 cadence 触发压缩”，移除了 `promptCompressionTokens` 作为触发器，避免阈值长期超标导致每轮重压缩。

### 6.3 结合 OpenCode 的下一步优化

参考 OpenCode 的 `isOverflow + prune + process(compaction)` 思路，建议采用双层治理：

1. 常规层：维持 cadence 压缩（稳定、可预测）。
2. 兜底层：仅在“接近模型极限或真实溢出错误”时触发 overflow compaction（紧急救援，不常态触发）。
3. 增量层：引入 Phase3 的 tool observation prune/compress，优先削减长工具输出。

### 6.4 是否还需要兜底

需要。建议保留“溢出兜底”，但不恢复“常规阈值每轮判断”。

- 推荐触发方式：
  - 真实 provider context overflow 错误；或
  - 预估 prompt 接近上限并超过保留缓冲（reserved buffer）时。
- 推荐行为：
  - 先执行一次紧急 compaction；
  - 记录最近一次紧急压缩轮次，设置最小冷却窗口，避免连续抖动。
