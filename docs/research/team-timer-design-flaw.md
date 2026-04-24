# Team 协作的 Timer 设计缺陷

**日期：2026-04** · **当前状态：HACK 临时绕过，等待重新设计**

---

## 一、背景

Team 模式下，`TeammateManager` 的状态机依赖三处「基于沉默时长」的定时器来判断一个 agent 的 turn 是否结束：

| 位置 | 原阈值 | 当前 HACK 值 | 触发条件 | 目的 |
| --- | --- | --- | --- | --- |
| `AionrsManager.missingFinishFallbackDelayMs` | `15_000` | `9_999_000` | aionrs 流事件静默 ≥ 阈值 | 真 finish 丢了时兜底合成一条 `finish`，让本地 UI 结束 loading |
| `AcpAgentManager.missingFinishFallbackDelayMs` | `15_000` | `9_999_000` | ACP 流事件静默 ≥ 阈值 | 同上，ACP（claude / codex 等）的版本 |
| `TeammateManager.WAKE_TIMEOUT_MS` | `60_000` | `9_999_000` | 整个 team-side 60s 没有任何流事件 | 检测「卡死 teammate」，升级成 `failed` 并给 leader 发一条"可能失联"的 idle_notification |

这三处的共同隐含假设是：

> **只要 backend 的流事件在一段时间内没动静，就可以把这个 turn 当成"已经结束"或"卡住"。**

这个假设在长任务场景下就会塌。

## 二、现象

以下两个场景都是在真实跑 team 时触发的，都是同一个根因：

### 2.1 Debate-2（2026-04）：opponent 被误判为"已结束"

相关日志片段（`log.txt`）：

```
15:09:54.969 [TeammateManager] wake(opponent): status=idle, proceeding
15:09:54.970 [TeammateManager] wake(opponent): sendPrompt type=messages-only, length=304
15:09:54.971 [AionrsManager] stream_start: msg_id=413dadd9, TTFT=1ms
...
15:10:09.974 [AionrsManager] Turn became idle without finish signal; synthesizing finish for dcd34e0f
15:10:09.975 [TeammateManager] maybeWakeLeaderWhenAllIdle: moderator:idle, proponent:idle, opponent:idle → WAKE
15:10:09.976 [TeammateManager] wake(Leader): sendPrompt preview="[From opponent] Turn completed"
...
15:11:05.456 [AionrsManager] info: Tool call: team_send_message
15:11:05.459 [TeammateManager] wake(moderator): sendPrompt preview="[From opponent] 感谢主持人，以及正方 proponent 精彩的开篇陈词..."
```

观察到的事实链：

1. `opponent` 在 `15:09:54.971` 起开始做本轮推理，**静默思考了 55 秒**，期间没有任何流事件。
2. `AionrsManager` 在 15 秒静默后触发 `handleMissingFinishFallback`，向 `teamEventBus` 广播了一条假的 `finish` 事件。
3. `TeammateManager` 把 `opponent` 从 `active` 切到 `idle`，给 leader 的 mailbox 写了一条 `"[From opponent] Turn completed"` 的 `idle_notification`。
4. `Leader` 拿到这条通知后，**对一个仍在工作的 teammate 做出了"它已经完成但没给出内容"的错误判断**。
5. 直到 `15:11:05`（静默开始后的 55+ 秒），opponent 才真正吐出了开篇陈词并调用 `team_send_message`。

这里关键的一点是：`opponent` 根本没卡死，它就是在长时间静默推理。系统用"15 秒静默"做推断，推错了。

### 2.2 Test 团队（更早一次）：proposer / judge 陷入死循环

现象类似：proposer 和 judge 都在推理阶段被 15s 定时器炸成假 finish，Leader 连续几轮只看到 `"Turn completed"`，认为成员罢工，最终走到 `team_shutdown_agent`。实际成员一直在正常推理。

## 三、根因分析

### 3.1 沉默 ≠ 卡死

LLM backend 的流事件在以下几种真实场景里都会长时间沉默，而 agent 本身并没有问题：

- **长链推理 / Chain-of-thought**：Codex、Claude 的 extended thinking、gemini 的 thinking mode 都可能在首 token 前沉默几十秒甚至几分钟。
- **长工具执行**：`team_task_create` 分出去的任务里包含大文件读取、grep 大仓库、跑测试、长写入，agent 会在 tool call 挂起时一直沉默。
- **复杂 agentic workflow**：多轮嵌套工具调用，单轮本身就需要跑几分钟。
- **服务端限流/排队**：provider 侧排队几十秒也是常见的。

「N 秒没事件」无法把这些合法场景和「真的卡死」区分开。任何阈值的选择都是错的：

- 阈值太小 → 误判长任务（我们现在遇到的情况）
- 阈值太大 → 真卡死的 agent 无法被发现，用户体验是"一直转圈不响应"

没有一个阈值是正确的。

### 3.2 唯一可靠的「done」信号

能可靠区分「结束」和「还在进行」的信号其实只有这四个：

1. **Backend 主动下发的真 `finish` / `error` stream event**  
   协议层明确告知本轮结束。
2. **RPC 返回**  
   `AcpAgent.sendMessage()` / `AionrsAgent.send()` 是 awaited 的 promise。它 resolve 时，整个 prompt 的生命周期在协议层就结束了，**没有任何歧义**。
3. **进程死了**  
   process exit / ACP disconnect — 这就是 `failed`。
4. **用户 / Leader 的显式动作**  
   `team_shutdown_agent`、cancel prompt。

静默**不**在上面四个里。任何「多久没 event 就推断 done」的机制本质上都是 heuristic。

### 3.3 现有 timer 逻辑的耦合

三处 timer 之间其实**不是独立**的，互相耦合：

- `missingFinishFallback` 会 emit 合成 `finish` 到 `teamEventBus`
- `teamEventBus` 被 `TeammateManager.handleResponseStream` 监听
- `finalizeTurn` 在真 finish 和合成 finish 上行为一致：切 idle、写 `"Turn completed"` 到 leader、`maybeWakeLeaderWhenAllIdle`
- `WAKE_TIMEOUT_MS` 的 watchdog 也会被假 finish 提前清掉（`finalizeTurn` 里清 `wakeTimeouts`）

结果就是：**一个 15s 的本地 UX 兜底，会一路被放大成 team 协作层的错误状态转换。**

## 四、已经试过的补丁，以及为什么都不治本

以下这些在此次 HACK 之前的分支上尝试过（都在 git history 里），每个都只是推迟/缓解了问题，没解决根因：

| 补丁 | 想解决什么 | 为什么不治本 |
| --- | --- | --- |
| `TeammateManager.wake()` 在 agent `active` 时把请求放进 `queuedWakes`，真 finish 时再重放 | 避免消息在 ACP / aionrs busy 时被底层协议 `"Ignoring command during active message processing"` 丢掉 | 合成 finish 依然提前触发「真 finish」路径，queued wake 被过早重放 |
| 在合成 finish 的 `data` 里打 `synthetic: true`，重放 queued wake 时延迟 1500ms | 给底层 backend 腾出排空时间 | 只拖慢了一次重放，没有避免 team 状态机被污染 |
| 把合成 finish 的 `data` 再加一层 `suspectBusy: true`，让 `TeammateManager.handleResponseStream` 对带这个标记的 finish 完全短路 | 不让合成 finish 推动 team 状态转换 | 方向对了，但没做完：`WAKE_TIMEOUT_MS = 60s` 的 watchdog 仍然会在长任务里误判成 `failed` |

**共同问题：这些都是在错误假设（"用 timer 判死活"）之上打补丁，阈值改到多少都不对。**

## 五、当前的临时 HACK

在还没有重新设计之前，为了不让长任务被误判，已经把三处阈值统一 hack 成 `9_999_000` ms（约 2.78 小时）：

- `src/process/task/AionrsManager.ts:100` → `missingFinishFallbackDelayMs = 9_999_000`
- `src/process/task/AcpAgentManager.ts:122` → `missingFinishFallbackDelayMs = 9_999_000`
- `src/process/team/TeammateManager.ts:66` → `WAKE_TIMEOUT_MS = 9_999_000`

三个 HACK 点的注释都指向本文档。

**这只是把定时器的窗口拉得足够大，让它"实际上不会触发"。**

明确的代价：

- ✅ 长任务（几分钟到一两个小时）不再会被误判成"done"或"failed"。
- ❌ 如果 backend 真的丢了 finish 事件或进程卡住，UI 会一直转圈直到超过 2.78 小时或用户手动取消。
- ❌ 如果 teammate 真的挂了，Leader 不会被自动通知，需要用户走 `team_shutdown_agent` 手动处理。

这些代价在短期内是可接受的，因为误判长任务的破坏力明显大于"真卡死时不能自动恢复"（真卡死的概率远低于长任务）。

## 六、重新设计方向

三个候选方向，从激进到保守：

### 方案 A：彻底去掉「用静默推完成」

- 完全删掉两处 `missingFinishFallbackDelayMs` 机制
- 完全删掉 `WAKE_TIMEOUT_MS` 机制
- Turn done **只**依赖 real finish / error / crash / RPC resolve / 用户显式 cancel
- UI 的 loading 状态只在 `agent.send()` / `agent.sendMessage()` 的 promise resolve 后清掉

**优点**：根治。语义清晰、没有任何 heuristic。  
**代价**：
- 需要先验证 `AcpAgent.sendMessage()` 和 `AionrsAgent.send()` 的 resolve 语义是否足够可靠（特别是异常路径）。
- 需要确认现在 `AionrsManager.handleTurnEnd()`、`AcpAgentManager.handleFinishSignal()` 等是否能够完全靠 RPC resolve 驱动，而不是靠 stream event 兜底。
- 真卡死场景只能靠用户或 leader 主动介入（UI "cancel" 按钮、`team_shutdown_agent`）。

### 方案 B：合成 finish 降级为"仅本地 UI 用"

- 保留 `missingFinishFallback`，但阈值大幅提高（或保持现在的 9999s）
- 合成 finish **不** 进 `teamEventBus`，只发 `ipcBridge.conversation.responseStream` 给本地 UI
- 删除 `TeammateManager.WAKE_TIMEOUT_MS` 的"升级为 failed"逻辑，或者把它降级成**纯信息通知**（写一条 `"teammate 已静默 N 分钟"`到 leader mailbox，不改状态）

**优点**：改动范围小，不需要验证 RPC resolve 语义。  
**代价**：仍然保留"合成 finish"这个概念，代码上有两套完成语义，长期看不干净。

### 方案 C：保留监控，但交给用户/Leader 决策

- 三处 timer 都保留，但都改成**只发信息不改状态**：
  - 静默超过 X 秒 → UI 显示"已静默 N 秒"
  - 静默超过 Y 秒 → 给 leader mailbox 写一条 FYI，不切 idle、不标 failed
- 真正的取消 / 重启决策完全交给 leader prompt（提示它调 `team_shutdown_agent`）和 UI 按钮

**优点**：保留了监控可见性，不会自动误判。  
**代价**：对 leader 的 prompt 依从性要求更高；如果 leader 没有主动判断，长任务会无限等下去（本质上和方案 A 一样）。

### 倾向

实作上最可能走 **方案 A + C 的组合**：

1. Teammate 一侧（`AionrsManager` / `AcpAgentManager`）：以 `agent.send(...)` 的 RPC resolve 为权威信号。Stream finish event 只是加速器；没收到也会在 RPC resolve 后 grace 数百 ms 自动合成并结束。**不**基于"静默 N 秒"主动合成。
2. Team 一侧（`TeammateManager`）：
   - 删掉自动标 `failed` 的 60s watchdog。
   - 保留一个很长（如 5 分钟）的 soft-notice：给 leader mailbox 写一条信息性通知，**不改状态**。
   - 真正的升级路径交给 leader prompt 和用户 UI 控制。

## 七、Follow-up TODO

- [ ] 调研 `AcpAgent.sendMessage()` 和 `AionrsAgent.send()` 的 resolve 行为（异常、取消、连接断开时分别如何？）
- [ ] 调研现有 `handleTurnEnd()` / `handleFinishSignal()` 是否存在"只能靠 stream finish 触发"的隐性依赖
- [ ] 确定 UI loading 状态的权威驱动源（目前可能混用了 stream finish、synthetic finish、RPC resolve）
- [ ] 设计「teammate 长时间静默」的用户可见提示（avatar 提示 / 徽章 / cancel 按钮）
- [ ] 给 leader prompt 加一段「判断 teammate 是否真的卡死」的指导，把主动权让给模型
- [ ] 等上述调研结束后，替换掉当前 HACK 阈值，把本文档从"临时说明"改成"变更记录"

## 八、相关代码索引

- `src/process/task/AionrsManager.ts` — `handleMissingFinishFallback` / `scheduleMissingFinishFallback`
- `src/process/task/AcpAgentManager.ts` — `handleMissingFinishFallback` / `sendAgentMessageWithFinishFallback`
- `src/process/team/TeammateManager.ts` — `resetWakeTimeout` / `handleInactivityTimeout` / `finalizeTurn` / `handleResponseStream`
- `src/process/team/teamEventBus.ts` — 合成 finish 跨进程广播的通道

## 九、相关现场记录

- `log.txt` — Debate-2 的完整运行日志
- 早期对话记录（相关 PR 暂未合入）里有 Test 团队的类似故障现场
- `docs/research/claude-team-mode-analysis.md` — Claude Code 的 team 模式参考设计
