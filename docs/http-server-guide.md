# HTTP 服务器模式使用指南

## 概述

HTTP 服务器模式是 TCC 分布式事务协调器的**推荐使用方式**，提供：

- 🌐 **RESTful API**：标准的 HTTP 接口用于组件注册和事务管理
- 📊 **Web 仪表板**：实时监控面板，显示系统状态、指标和日志
- 🔄 **WebSocket 推送**：实时日志和状态更新
- 🔗 **网络组件支持**：远程 HTTP 服务可以注册为 TCC 组件

## 快速开始

### 1. 启动 TCC 服务器

```bash
# 开发模式
npm run dev:server

# 生产模式
npm run build
npm run start:server
```

默认启动在 `http://localhost:3000`

### 2. 访问 Web 仪表板

浏览器打开：http://localhost:3000/dashboard

仪表板功能：
- 实时系统健康状态
- 事务执行指标统计
- 已注册组件管理
- 实时日志查看
- 一键启动事务

### 3. 环境配置

```bash
# 服务器配置
export TCC_SERVER_PORT=3000
export TCC_SERVER_HOST=0.0.0.0
export TCC_ENABLE_CORS=true

# 数据库配置
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=your_password
export DB_NAME=tcc

# 事务配置
export TCC_TRANSACTION_TIMEOUT=30000
export TCC_MONITOR_INTERVAL=5000
export TCC_ENABLE_MONITOR=true

# 日志配置
export LOG_LEVEL=INFO
```

## REST API 接口

### 基础信息

- **Base URL**: `http://localhost:3000/api/v1`
- **Content-Type**: `application/json`
- **认证**: 当前版本无需认证

### 健康检查

```http
GET /api/v1/health
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "healthy": true,
    "instanceId": "txmgr_1703123456789_abc123",
    "componentsCount": 3,
    "monitorEnabled": true,
    "metrics": { ... },
    "components": [ ... ],
    "server": {
      "uptime": 3600,
      "memory": { ... },
      "version": "v18.17.0"
    }
  }
}
```

### 组件管理

#### 注册组件

```http
POST /api/v1/components/register
```

**请求体**：
```json
{
  "componentId": "payment-service",
  "endpoint": {
    "tryUrl": "http://localhost:3001/try",
    "confirmUrl": "http://localhost:3001/confirm",
    "cancelUrl": "http://localhost:3001/cancel",
    "timeout": 30000,
    "headers": {
      "Authorization": "Bearer token123"
    }
  },
  "metadata": {
    "service": "PaymentService",
    "version": "1.0.0",
    "description": "支付服务组件"
  }
}
```

**响应示例**：
```json
{
  "success": true,
  "message": "组件 payment-service 注册成功",
  "registrationId": "payment-service"
}
```

#### 取消注册组件

```http
DELETE /api/v1/components/{componentId}
```

#### 获取组件列表

```http
GET /api/v1/components
```

**响应示例**：
```json
{
  "success": true,
  "data": [
    {
      "id": "payment-service",
      "endpoint": { ... },
      "metadata": { ... },
      "type": "network"
    }
  ]
}
```

### 事务管理

#### 启动事务

```http
POST /api/v1/transactions/start
```

**请求体**：
```json
{
  "timeout": 30000,
  "metadata": {
    "orderId": "ORDER_123456",
    "amount": 1000,
    "description": "用户购买商品"
  }
}
```

**响应示例**：
```json
{
  "success": true,
  "txId": 12345,
  "message": "事务执行成功",
  "duration": 2500
}
```

#### 获取事务状态

```http
GET /api/v1/transactions/{txId}
```

### 监控接口

#### 获取指标

```http
GET /api/v1/metrics
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "transactionStarted": 100,
    "transactionSuccess": 95,
    "transactionFailure": 5,
    "transactionTimeout": 0,
    "averageTransactionDuration": 1500,
    "hangingTransactionCount": 0,
    "retryCount": 12
  }
}
```

#### 获取日志

```http
GET /api/v1/logs?limit=100
```

## 网络组件开发

### 组件接口规范

网络组件需要实现以下 HTTP 接口：

#### 健康检查（可选）
```http
GET /health
```

#### Try 阶段
```http
POST /try
```

**请求体**：
```json
{
  "componentId": "payment-service",
  "phase": "try",
  "metadata": { ... },
  "timestamp": "2023-12-21T10:30:00Z"
}
```

**响应**：
```json
{
  "success": true,
  "message": "Try 阶段执行成功"
}
```

#### Confirm 阶段
```http
POST /confirm
```

#### Cancel 阶段
```http
POST /cancel
```

### 示例：Node.js 组件实现

```javascript
const express = require('express');
const app = express();

app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.json({ success: true, healthy: true });
});

// Try 阶段
app.post('/try', async (req, res) => {
  const { componentId, metadata } = req.body;
  
  try {
    // 执行业务逻辑：预留资源
    await reserveResource(metadata);
    
    res.json({
      success: true,
      message: "资源预留成功"
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Confirm 阶段
app.post('/confirm', async (req, res) => {
  const { componentId, metadata } = req.body;
  
  try {
    // 执行业务逻辑：确认操作
    await confirmOperation(metadata);
    
    res.json({
      success: true,
      message: "操作确认成功"
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Cancel 阶段
app.post('/cancel', async (req, res) => {
  const { componentId, metadata } = req.body;
  
  try {
    // 执行业务逻辑：回滚操作
    await rollbackOperation(metadata);
    
    res.json({
      success: true,
      message: "操作回滚成功"
    });
  } catch (error) {
    // Cancel 阶段即使失败也要返回成功，确保幂等性
    console.warn('Cancel 操作失败:', error);
    res.json({
      success: true,
      message: "操作回滚完成"
    });
  }
});

app.listen(3001, () => {
  console.log('组件服务启动在端口 3001');
});
```

## 完整演示

### 1. 启动所有服务

```bash
# 终端 1：启动 TCC 服务器
npm run dev:server

# 终端 2：启动模拟业务服务
npm run dev:mock-services

# 终端 3：运行客户端示例
npm run dev:client
```

### 2. 或使用一键演示

```bash
npm install concurrently -D
npm run demo
```

### 3. 手动测试

1. 访问仪表板：http://localhost:3000/dashboard
2. 点击"注册组件"按钮
3. 填入组件信息：
   - 组件ID: `test-service`
   - Try URL: `http://localhost:3001/try`
   - Confirm URL: `http://localhost:3001/confirm`
   - Cancel URL: `http://localhost:3001/cancel`
4. 点击"启动事务"按钮
5. 观察实时日志和指标变化

## 生产部署

### Docker 化部署

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/
COPY dashboard/ ./dashboard/

EXPOSE 3000
CMD ["node", "dist/example/server-example.js"]
```

### Kubernetes 部署

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tcc-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: tcc-server
  template:
    metadata:
      labels:
        app: tcc-server
    spec:
      containers:
      - name: tcc-server
        image: your-registry/tcc-server:latest
        ports:
        - containerPort: 3000
        env:
        - name: DB_HOST
          value: "mysql-service"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mysql-secret
              key: password
---
apiVersion: v1
kind: Service
metadata:
  name: tcc-server-service
spec:
  selector:
    app: tcc-server
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

## 最佳实践

1. **组件幂等性**：确保 Confirm/Cancel 操作幂等
2. **超时设置**：合理设置组件和事务超时时间
3. **错误处理**：Try 阶段可以失败，Confirm/Cancel 应该最终成功
4. **监控告警**：监控事务成功率和平均耗时
5. **日志记录**：记录详细的业务操作日志
6. **健康检查**：实现组件健康检查接口
7. **安全认证**：生产环境添加 API 认证和授权

## 故障排除

### 常见问题

1. **组件注册失败**
   - 检查组件服务是否启动
   - 检查网络连接和防火墙
   - 查看组件健康检查是否通过

2. **事务执行失败**
   - 查看实时日志了解具体错误
   - 检查组件 Try 阶段实现
   - 验证数据库连接和表结构

3. **仪表板无法访问**
   - 检查服务器是否启动成功
   - 确认端口没有被占用
   - 查看服务器日志

### 调试技巧

1. 设置 `LOG_LEVEL=DEBUG` 查看详细日志
2. 使用 `/api/v1/health` 检查系统状态
3. 通过 `/api/v1/metrics` 监控系统指标
4. 在仪表板中实时查看日志输出
