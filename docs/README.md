## 项目概览

本项目实现了一个**生产级**基于 TCC 模式（Try-Confirm-Cancel）的分布式事务协调器，提供以下核心能力：

### 核心组件

- **事务管理器 `TxManager`**：
  - 并发执行各组件的 `try` 阶段，支持超时控制；
  - 智能状态聚合与二阶段推进（`confirm` / `cancel`）；
  - 后台监控轮询，自动处理挂起事务；
  - 分布式锁支持，避免多节点竞争；
  - 完整的指标收集与健康检查。

- **组件接口 `TccComponent`**：业务方实现 `try` / `confirm` / `cancel` 三阶段逻辑。

- **存储层**：
  - 抽象接口 `TxStore`：支持多种持久化方案；
  - 生产级实现 `MySQLTxStore`：包含重试、锁机制、错误恢复。

### 生产级特性

- **可靠性**：指数退避重试、错误恢复、优雅关闭
- **可观测性**：结构化日志、指标收集、链路追踪
- **可配置性**：环境变量配置、多环境支持
- **幂等性**：组件幂等包装器、去重键机制
- **测试覆盖**：单元测试、集成测试、Mock 组件

## 技术栈

- TypeScript + Node.js (CommonJS)
- 依赖：`mysql2`、`dayjs`、`ioredis`（示例未用到 Redis）

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 数据库准备
确保 MySQL 服务运行，然后执行：
```bash
# 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS tcc"

# 初始化表结构（生产级示例会自动创建）
mysql -u root -p tcc < example/database.sql
```

### 3. 环境配置（可选）
```bash
# 设置数据库连接
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=your_password
export DB_NAME=tcc

# 设置日志级别
export LOG_LEVEL=INFO

# 设置事务超时
export TCC_TRANSACTION_TIMEOUT=30000
```

### 4. 运行示例

#### 基础示例
```bash
npm run build
npm run start:example
# 或直接运行 TS
npm run dev:example
```

#### 生产级示例
```bash
npm run build
node dist/example/production-example.js
# 或直接运行 TS
npx ts-node example/production-example.ts
```

### 5. 运行测试
```bash
npm test
npm run test:coverage
```

## 目录结构

```
src/                    # 核心源码
  enums.ts              # 状态枚举
  model.ts              # 事务模型定义
  tccComponent.ts       # TCC 组件接口
  tx_config.ts          # 基础配置类
  tx_manager.ts         # 事务管理器（生产级）
  tx_store.ts           # 存储抽象接口
  logger.ts             # 结构化日志系统
  metrics.ts            # 指标收集系统
  retry.ts              # 重试机制
  errors.ts             # 错误类型定义
  config.ts             # 配置管理
  stores/               # 存储实现
    mysql-store.ts      # MySQL 生产级存储
example/                # 使用示例
  example.ts            # 基础示例：A->B 转账
  production-example.ts # 生产级示例：完整特性演示
  database.sql          # 演示所需表结构
tests/                  # 测试文件
  setup.ts              # 测试配置
  tx_manager.test.ts    # 事务管理器测试
docs/                   # 文档
  README.md             # 项目说明
  architecture.md       # 架构设计
  usage.md              # 使用指南
  api.md                # API 参考
  roadmap.md            # 发展规划
```

## 设计要点

- 并发 Try：所有组件的 `try` 并发执行，任一失败或超时即标记整体失败；
- 二阶段异步推进：`try` 阶段结束后，依据聚合状态选择并发执行 `confirm` 或 `cancel`；
- 幂等性：业务应保证 `confirm` / `cancel` 幂等；
- 兜底监控：可开启后台任务定期扫描挂起事务并重试推进；
- 存储抽象：通过 `TxStore` 适配不同的持久化方案。

## 生产级特性详述

### ✅ 已实现的生产级特性

- **完整的存储层**：`MySQLTxStore` 实现了所有 TxStore 接口方法
- **分布式锁**：基于 MySQL `GET_LOCK/RELEASE_LOCK` 的分布式锁机制
- **指数退避重试**：可配置的重试策略，支持抖动和最大延迟
- **结构化日志**：带上下文的日志系统，支持不同级别输出
- **指标收集**：事务成功率、耗时、重试次数等关键指标
- **错误分类**：专门的错误类型，支持可重试错误识别
- **超时控制**：事务级别和组件级别的超时管理
- **优雅关闭**：信号处理和资源清理机制
- **幂等性支持**：组件幂等包装器和去重键机制
- **配置管理**：环境变量支持和配置验证
- **健康检查**：系统状态监控和诊断接口
- **单元测试**：核心组件的测试覆盖

### 🚀 生产部署建议

- **数据库优化**：为 `tx_record` 表的 `status` 和 `created_at` 字段建立索引
- **连接池配置**：根据并发需求调整数据库连接池大小
- **监控告警**：集成 Prometheus/Grafana 监控指标输出
- **日志聚合**：使用 ELK/Loki 等日志聚合系统
- **多节点部署**：利用分布式锁确保多实例安全运行
- **配置外部化**：使用 Kubernetes ConfigMap 或环境变量管理配置


