import express, { Request, Response } from 'express';
import cors from 'cors';
import { logger } from '../src/logger';

// 模拟业务服务，实现 TCC 三阶段接口
export class MockBusinessService {
    private app: express.Application;
    private port: number;
    private serviceName: string;
    private server: any;
    
    // 模拟业务状态
    private transactions: Map<string, {
        phase: 'try' | 'confirm' | 'cancel';
        status: 'pending' | 'success' | 'failed';
        data: any;
        timestamp: number;
    }> = new Map();

    constructor(serviceName: string, port: number) {
        this.serviceName = serviceName;
        this.port = port;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());
        
        // 请求日志
        this.app.use((req: Request, res: Response, next: any) => {
            logger.info(`[${this.serviceName}] 收到请求`, {
                method: req.method,
                url: req.url,
                body: req.body
            });
            next();
        });
    }

    private setupRoutes() {
        // 健康检查
        this.app.get('/health', (req: Request, res: Response) => {
            res.json({
                success: true,
                healthy: true,
                service: this.serviceName,
                timestamp: new Date().toISOString()
            });
        });

        // Try 阶段
        this.app.post('/try', (req: Request, res: Response) => {
            const { componentId, metadata } = req.body;
            const txKey = `${componentId}_${Date.now()}`;
            
            logger.info(`[${this.serviceName}] 执行 Try 阶段`, { componentId, txKey });

            // 模拟业务逻辑 - 随机失败 10% 的情况
            const shouldFail = Math.random() < 0.1;
            
            if (shouldFail) {
                logger.warn(`[${this.serviceName}] Try 阶段失败`, { componentId, txKey });
                return res.status(400).json({
                    success: false,
                    message: `${this.serviceName} Try 阶段业务逻辑失败`,
                    componentId,
                    txKey
                });
            }

            // 记录事务状态
            this.transactions.set(txKey, {
                phase: 'try',
                status: 'success',
                data: { componentId, metadata },
                timestamp: Date.now()
            });

            logger.info(`[${this.serviceName}] Try 阶段成功`, { componentId, txKey });
            res.json({
                success: true,
                message: `${this.serviceName} Try 阶段执行成功`,
                componentId,
                txKey
            });
        });

        // Confirm 阶段
        this.app.post('/confirm', (req: Request, res: Response) => {
            const { componentId, metadata } = req.body;
            
            logger.info(`[${this.serviceName}] 执行 Confirm 阶段`, { componentId });

            // 查找相关的 try 记录（简化处理，实际应该基于事务ID）
            const tryRecord = Array.from(this.transactions.entries())
                .find(([key, value]) => value.data.componentId === componentId && value.phase === 'try');

            if (!tryRecord) {
                logger.warn(`[${this.serviceName}] Confirm 阶段失败：未找到对应的 Try 记录`, { componentId });
                return res.status(400).json({
                    success: false,
                    message: `${this.serviceName} 未找到对应的 Try 记录`,
                    componentId
                });
            }

            const [txKey] = tryRecord;
            
            // 更新事务状态
            this.transactions.set(txKey + '_confirm', {
                phase: 'confirm',
                status: 'success',
                data: { componentId, metadata, originalTxKey: txKey },
                timestamp: Date.now()
            });

            logger.info(`[${this.serviceName}] Confirm 阶段成功`, { componentId, txKey });
            res.json({
                success: true,
                message: `${this.serviceName} Confirm 阶段执行成功`,
                componentId,
                txKey
            });
        });

        // Cancel 阶段
        this.app.post('/cancel', (req: Request, res: Response) => {
            const { componentId, metadata } = req.body;
            
            logger.info(`[${this.serviceName}] 执行 Cancel 阶段`, { componentId });

            // 查找相关的 try 记录（简化处理，实际应该基于事务ID）
            const tryRecord = Array.from(this.transactions.entries())
                .find(([key, value]) => value.data.componentId === componentId && value.phase === 'try');

            if (!tryRecord) {
                logger.warn(`[${this.serviceName}] Cancel 阶段警告：未找到对应的 Try 记录`, { componentId });
                // Cancel 阶段即使没有找到记录也返回成功，确保幂等性
            }

            const txKey = tryRecord ? tryRecord[0] : `unknown_${componentId}`;
            
            // 更新事务状态
            this.transactions.set(txKey + '_cancel', {
                phase: 'cancel',
                status: 'success',
                data: { componentId, metadata, originalTxKey: txKey },
                timestamp: Date.now()
            });

            logger.info(`[${this.serviceName}] Cancel 阶段成功`, { componentId, txKey });
            res.json({
                success: true,
                message: `${this.serviceName} Cancel 阶段执行成功`,
                componentId,
                txKey
            });
        });

        // 获取事务历史（调试用）
        this.app.get('/transactions', (req: Request, res: Response) => {
            const transactions = Array.from(this.transactions.entries()).map(([key, value]) => ({
                key,
                ...value
            }));

            res.json({
                success: true,
                service: this.serviceName,
                transactions
            });
        });

        // 清空事务历史
        this.app.delete('/transactions', (req: Request, res: Response) => {
            this.transactions.clear();
            logger.info(`[${this.serviceName}] 清空事务历史`);
            
            res.json({
                success: true,
                message: `${this.serviceName} 事务历史已清空`
            });
        });
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(this.port, () => {
                logger.info(`[${this.serviceName}] 模拟业务服务启动`, {
                    port: this.port,
                    endpoints: {
                        health: `http://localhost:${this.port}/health`,
                        try: `http://localhost:${this.port}/try`,
                        confirm: `http://localhost:${this.port}/confirm`,
                        cancel: `http://localhost:${this.port}/cancel`,
                        transactions: `http://localhost:${this.port}/transactions`
                    }
                });
                resolve();
            });

            this.server.on('error', (error: any) => {
                logger.error(`[${this.serviceName}] 服务启动失败`, error);
                reject(error);
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    logger.info(`[${this.serviceName}] 模拟业务服务已停止`);
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

// 启动多个模拟服务的示例
async function startMockServices() {
    const services = [
        new MockBusinessService('PaymentService', 3001),
        new MockBusinessService('InventoryService', 3002),
        new MockBusinessService('ShippingService', 3003)
    ];

    logger.info('启动模拟业务服务...');

    for (const service of services) {
        await service.start();
    }

    logger.info('所有模拟业务服务启动完成');

    // 优雅关闭处理
    const shutdown = async () => {
        logger.info('正在停止模拟业务服务...');
        
        for (const service of services) {
            await service.stop();
        }
        
        logger.info('所有模拟业务服务已停止');
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('uncaughtException', (error) => {
        logger.error('未捕获的异常', error);
        shutdown();
    });

    return services;
}

// 如果直接运行此文件
if (require.main === module) {
    startMockServices().catch(error => {
        console.error('启动模拟服务失败:', error);
        process.exit(1);
    });
}

export { startMockServices };
