## Roadmap（规划）

- 存储层
  - 实现 `GetHangingTXs/Lock/Unlock`
  - 多节点下表级/行级锁与租约模型
  - 指数退避 + 死信重试机制
- 可观测性
  - 统一结构化日志（traceId/txId）
  - 指标：成功率、平均耗时、重试次数、超时率
  - 追踪：try/confirm/cancel 链路跟踪
- 稳健性
  - confirm/cancel 幂等守护（例如去重键表）
  - 防止雪崩：限流/熔断/降级
- 开发体验
  - 增加单元测试与集成测试
  - 完善示例（Redis 幂等记录、锁实现）
  - 提供 TypeORM/Prisma 适配器


