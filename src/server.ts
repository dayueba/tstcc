import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as path from 'path';
import { TxManager } from './tx_manager';
import { NetworkTccComponent, ComponentRegistrationRequest, ComponentRegistrationResponse } from './network-component';
import { logger, LogContext } from './logger';
import { metricsCollector } from './metrics';
import { TXStatus } from './enums';

export interface ServerConfig {
    port: number;
    host: string;
    enableCors: boolean;
    staticPath?: string;
}

export interface TransactionRequest {
    timeout?: number;
    metadata?: Record<string, any>;
}

export interface TransactionResponse {
    success: boolean;
    txId: number;
    message: string;
    duration?: number;
}

export class TccServer {
    private app: express.Application;
    private server: http.Server;
    private wss: WebSocket.Server;
    private txManager: TxManager;
    private config: ServerConfig;
    private registeredComponents: Map<string, NetworkTccComponent> = new Map();
    private logBuffer: LogContext[] = [];
    private readonly maxLogBuffer = 1000;

    constructor(txManager: TxManager, config: ServerConfig) {
        this.txManager = txManager;
        this.config = config;
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.setupLogCapture();
    }

    private setupMiddleware() {
        // 基础中间件
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));

        // CORS 支持
        if (this.config.enableCors) {
            this.app.use(cors({
                origin: true,
                credentials: true
            }));
        }

        // 请求日志中间件
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            const start = Date.now();
            
            res.on('finish', () => {
                const duration = Date.now() - start;
                logger.info('HTTP 请求', {
                    method: req.method,
                    url: req.url,
                    status: res.statusCode,
                    duration,
                    userAgent: req.get('User-Agent'),
                    ip: req.ip
                });
            });

            next();
        });

        // 静态文件服务
        if (this.config.staticPath) {
            this.app.use('/dashboard', express.static(this.config.staticPath));
        } else {
            // 提供内置的简单仪表板
            this.app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));
        }
    }

    private setupRoutes() {
        // API 根路径
        const apiRouter = express.Router();

        // 健康检查
        apiRouter.get('/health', async (req: Request, res: Response) => {
            try {
                const health = await this.txManager.getHealthStatus();
                const componentsHealth = await this.checkComponentsHealth();
                
                res.json({
                    success: true,
                    data: {
                        ...health,
                        components: componentsHealth,
                        server: {
                            uptime: process.uptime(),
                            memory: process.memoryUsage(),
                            version: process.version
                        }
                    }
                });
            } catch (error) {
                logger.error('健康检查失败', error as Error);
                res.status(500).json({
                    success: false,
                    message: '健康检查失败',
                    error: (error as Error).message
                });
            }
        });

        // 注册组件
        apiRouter.post('/components/register', async (req: Request, res: Response) => {
            try {
                const request: ComponentRegistrationRequest = req.body;
                
                if (!request.componentId || !request.endpoint) {
                    return res.status(400).json({
                        success: false,
                        message: '缺少必要参数：componentId 和 endpoint'
                    });
                }

                // 检查是否已注册
                if (this.registeredComponents.has(request.componentId)) {
                    return res.status(409).json({
                        success: false,
                        message: `组件 ${request.componentId} 已经注册`
                    });
                }

                // 创建网络组件
                const networkComponent = new NetworkTccComponent(
                    request.componentId,
                    request.endpoint,
                    request.metadata || {}
                );

                // 进行健康检查
                const isHealthy = await networkComponent.healthCheck();
                if (!isHealthy) {
                    return res.status(400).json({
                        success: false,
                        message: `组件 ${request.componentId} 健康检查失败`
                    });
                }

                // 注册到事务管理器
                this.txManager.register(networkComponent);
                this.registeredComponents.set(request.componentId, networkComponent);

                const response: ComponentRegistrationResponse = {
                    success: true,
                    message: `组件 ${request.componentId} 注册成功`,
                    registrationId: request.componentId
                };

                logger.info('组件注册成功', { componentId: request.componentId });
                res.json(response);

            } catch (error) {
                logger.error('组件注册失败', error as Error, { request: req.body });
                res.status(500).json({
                    success: false,
                    message: '组件注册失败',
                    error: (error as Error).message
                });
            }
        });

        // 取消注册组件
        apiRouter.delete('/components/:componentId', async (req: Request, res: Response) => {
            try {
                const componentId = req.params.componentId;
                
                if (!this.registeredComponents.has(componentId)) {
                    return res.status(404).json({
                        success: false,
                        message: `组件 ${componentId} 未找到`
                    });
                }

                this.registeredComponents.delete(componentId);
                
                logger.info('组件取消注册成功', { componentId });
                res.json({
                    success: true,
                    message: `组件 ${componentId} 取消注册成功`
                });

            } catch (error) {
                logger.error('组件取消注册失败', error as Error);
                res.status(500).json({
                    success: false,
                    message: '组件取消注册失败',
                    error: (error as Error).message
                });
            }
        });

        // 获取已注册组件列表
        apiRouter.get('/components', (req: Request, res: Response) => {
            try {
                const components = Array.from(this.registeredComponents.values()).map(comp => comp.getInfo());
                
                res.json({
                    success: true,
                    data: components
                });
            } catch (error) {
                logger.error('获取组件列表失败', error as Error);
                res.status(500).json({
                    success: false,
                    message: '获取组件列表失败',
                    error: (error as Error).message
                });
            }
        });

        // 启动事务
        apiRouter.post('/transactions/start', async (req: Request, res: Response) => {
            try {
                const request: TransactionRequest = req.body;
                const startTime = Date.now();

                logger.info('收到启动事务请求', { metadata: request.metadata });

                const result = await this.txManager.startTransaction();
                const duration = Date.now() - startTime;

                const response: TransactionResponse = {
                    success: result.success,
                    txId: result.txId,
                    message: result.success ? '事务执行成功' : '事务执行失败',
                    duration
                };

                res.json(response);

            } catch (error) {
                logger.error('启动事务失败', error as Error);
                res.status(500).json({
                    success: false,
                    txId: -1,
                    message: '启动事务失败',
                    error: (error as Error).message
                });
            }
        });

        // 获取事务状态
        apiRouter.get('/transactions/:txId', async (req: Request, res: Response) => {
            try {
                const txId = parseInt(req.params.txId);
                
                if (isNaN(txId)) {
                    return res.status(400).json({
                        success: false,
                        message: '无效的事务ID'
                    });
                }

                // 这里需要扩展 TxStore 接口来获取事务详情
                // 暂时返回基本信息
                res.json({
                    success: true,
                    data: {
                        txId,
                        status: 'unknown',
                        message: '事务状态查询功能待实现'
                    }
                });

            } catch (error) {
                logger.error('获取事务状态失败', error as Error);
                res.status(500).json({
                    success: false,
                    message: '获取事务状态失败',
                    error: (error as Error).message
                });
            }
        });

        // 获取指标
        apiRouter.get('/metrics', (req: Request, res: Response) => {
            try {
                const metrics = metricsCollector.getMetrics();
                
                res.json({
                    success: true,
                    data: metrics
                });
            } catch (error) {
                logger.error('获取指标失败', error as Error);
                res.status(500).json({
                    success: false,
                    message: '获取指标失败',
                    error: (error as Error).message
                });
            }
        });

        // 获取日志
        apiRouter.get('/logs', (req: Request, res: Response) => {
            try {
                const limit = parseInt(req.query.limit as string) || 100;
                const logs = this.logBuffer.slice(-limit);
                
                res.json({
                    success: true,
                    data: logs
                });
            } catch (error) {
                logger.error('获取日志失败', error as Error);
                res.status(500).json({
                    success: false,
                    message: '获取日志失败',
                    error: (error as Error).message
                });
            }
        });

        this.app.use('/api/v1', apiRouter);

        // 根路径重定向到仪表板
        this.app.get('/', (req: Request, res: Response) => {
            res.redirect('/dashboard');
        });
    }

    private setupWebSocket() {
        this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
            logger.info('WebSocket 连接建立', { 
                ip: req.socket.remoteAddress,
                userAgent: req.headers['user-agent']
            });

            // 发送当前状态
            this.sendCurrentStatus(ws);

            ws.on('message', (message: string) => {
                try {
                    const data = JSON.parse(message);
                    logger.debug('收到 WebSocket 消息', { data });
                    
                    // 处理客户端请求
                    if (data.type === 'subscribe') {
                        // 客户端订阅特定类型的更新
                        ws.send(JSON.stringify({
                            type: 'subscription_confirmed',
                            data: { subscribed: data.topics || ['all'] }
                        }));
                    }
                } catch (error) {
                    logger.warn('解析 WebSocket 消息失败', { message, error: (error as Error).message });
                }
            });

            ws.on('close', () => {
                logger.info('WebSocket 连接关闭');
            });

            ws.on('error', (error) => {
                logger.error('WebSocket 错误', error);
            });
        });
    }

    private setupLogCapture() {
        // 拦截日志输出，缓存最近的日志
        const originalConsoleLog = console.log;
        const originalConsoleWarn = console.warn;
        const originalConsoleError = console.error;

        const captureLog = (level: string, args: any[]) => {
            const logEntry: LogContext = {
                level,
                timestamp: new Date().toISOString(),
                message: args.join(' ')
            };

            this.logBuffer.push(logEntry);
            
            // 保持缓冲区大小
            if (this.logBuffer.length > this.maxLogBuffer) {
                this.logBuffer.shift();
            }

            // 通过 WebSocket 广播日志
            this.broadcastLog(logEntry);
        };

        console.log = (...args) => {
            originalConsoleLog.apply(console, args);
            captureLog('info', args);
        };

        console.warn = (...args) => {
            originalConsoleWarn.apply(console, args);
            captureLog('warn', args);
        };

        console.error = (...args) => {
            originalConsoleError.apply(console, args);
            captureLog('error', args);
        };
    }

    private async sendCurrentStatus(ws: WebSocket) {
        try {
            const health = await this.txManager.getHealthStatus();
            const metrics = metricsCollector.getMetrics();
            const components = Array.from(this.registeredComponents.values()).map(comp => comp.getInfo());

            ws.send(JSON.stringify({
                type: 'status_update',
                data: {
                    health,
                    metrics,
                    components,
                    timestamp: new Date().toISOString()
                }
            }));
        } catch (error) {
            logger.error('发送当前状态失败', error as Error);
        }
    }

    private broadcastLog(logEntry: LogContext) {
        const message = JSON.stringify({
            type: 'log_update',
            data: logEntry
        });

        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    private async checkComponentsHealth(): Promise<Array<{id: string, healthy: boolean}>> {
        const healthChecks = Array.from(this.registeredComponents.values()).map(async (component) => {
            try {
                const healthy = await component.healthCheck();
                return { id: component.id, healthy };
            } catch (error) {
                return { id: component.id, healthy: false };
            }
        });

        return Promise.all(healthChecks);
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.server.listen(this.config.port, this.config.host, () => {
                    logger.info('TCC 服务器启动成功', {
                        host: this.config.host,
                        port: this.config.port,
                        dashboard: `http://${this.config.host}:${this.config.port}/dashboard`,
                        api: `http://${this.config.host}:${this.config.port}/api/v1`
                    });
                    resolve();
                });

                this.server.on('error', (error) => {
                    logger.error('服务器启动失败', error);
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            logger.info('正在停止 TCC 服务器...');

            // 关闭 WebSocket 连接
            this.wss.clients.forEach((client) => {
                client.close();
            });

            // 关闭 HTTP 服务器
            this.server.close(() => {
                logger.info('TCC 服务器已停止');
                resolve();
            });
        });
    }
}
