## 架构与时序

### 关键参与者

- `TxManager`：聚合组件执行结果，负责二阶段推进与监控兜底。
- `TccComponent`：业务侧实现的三阶段接口。
- `TxStore`：事务日志持久化与查询、提交。

### 状态机

- 组件 Try 状态：`hanging` | `successful` | `failure`
- 事务状态聚合：
  - 任一组件 `failure` => 事务 `failure`
  - 仍存在 `hanging` => 事务 `hanging`
  - 全部 `successful` => 事务 `successful`

### 时序（单事务）

1. 注册组件 `TxManager.register(component)`
2. `startTransaction()`：
   - `CreateTx` 新增事务记录，初始化各组件 try 状态为 `hanging`
   - 并发执行各组件 `try`
   - 任一失败或超时立即走失败分支
3. `advanceTransactionProgress()`：
   - `successful` => 并发 `confirm`，`TXSubmit(success)`
   - `failure` => 并发 `cancel`，`TXSubmit(failure)`
   - `hanging` => 等待监控或业务重试

### 监控任务

- 可通过 `TxConfig.enableMonitor` 控制开启后台轮询；
- 周期性调用 `GetHangingTXs` 并推进其状态；
- 生产需要加锁避免多进程重复处理。

### 幂等策略（建议）

- `try`：仅预留资源或写中间态；
- `confirm` / `cancel`：业务自行保证幂等，可利用：
  - 去重键（幂等表/Redis set）
  - 幂等 token 随事务 ID 传递
  - 软锁与版本号


