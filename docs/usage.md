## 使用指南

### 1. 业务实现 `TccComponent`

```ts
class PayComponent implements TccComponent {
  id = 'pay';
  async try() { /* 预扣款 */ }
  async confirm() { /* 提交扣款 */ }
  async cancel() { /* 回滚扣款 */ }
}
```

### 2. 实现 `TxStore`

需要对以下接口给出持久化实现：

- `CreateTx`
- `TXUpdateComponentStatus`
- `TXSubmit`
- `GetHangingTXs`
- `GetTX`
- `Lock/Unlock`（可选，生产建议实现）

### 3. 初始化与启动

```ts
const manager = new TxManager(myStore, new TxConfig(5000, 1000, true));
manager.register(new PayComponent());
manager.register(new ShipComponent());
await manager.startTransaction();
```

### 4. 配置项

- `timeout`：try 阶段最大等待时长（ms）
- `monitorInterval`：后台监控扫描间隔（ms）
- `enableMonitor`：是否启用后台监控

### 5. 运行示例

1) 初始化数据库，执行 `example/database.sql`
2) 构建并运行：

```
npm run build
npm run start:example
```


