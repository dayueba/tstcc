import axios from 'axios';
import { logger } from '../src/logger';

interface ComponentEndpoint {
    tryUrl: string;
    confirmUrl: string;
    cancelUrl: string;
    timeout?: number;
}

interface ComponentRegistrationRequest {
    componentId: string;
    endpoint: ComponentEndpoint;
    metadata?: Record<string, any>;
}

class TccClient {
    private baseUrl: string;
    private axiosInstance: any;

    constructor(tccServerUrl: string) {
        this.baseUrl = tccServerUrl;
        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    // 注册组件
    async registerComponent(request: ComponentRegistrationRequest): Promise<any> {
        try {
            logger.info('注册组件', { componentId: request.componentId });
            
            const response = await this.axiosInstance.post('/api/v1/components/register', request);
            
            if (response.data.success) {
                logger.info('组件注册成功', { 
                    componentId: request.componentId,
                    registrationId: response.data.registrationId 
                });
            } else {
                logger.error('组件注册失败', new Error(response.data.message), {
                    componentId: request.componentId
                });
            }
            
            return response.data;
        } catch (error) {
            logger.error('组件注册异常', error as Error, { componentId: request.componentId });
            throw error;
        }
    }

    // 取消注册组件
    async unregisterComponent(componentId: string): Promise<any> {
        try {
            logger.info('取消注册组件', { componentId });
            
            const response = await this.axiosInstance.delete(`/api/v1/components/${componentId}`);
            
            if (response.data.success) {
                logger.info('组件取消注册成功', { componentId });
            } else {
                logger.error('组件取消注册失败', new Error(response.data.message), { componentId });
            }
            
            return response.data;
        } catch (error) {
            logger.error('组件取消注册异常', error as Error, { componentId });
            throw error;
        }
    }

    // 获取已注册组件列表
    async getComponents(): Promise<any> {
        try {
            const response = await this.axiosInstance.get('/api/v1/components');
            return response.data;
        } catch (error) {
            logger.error('获取组件列表异常', error as Error);
            throw error;
        }
    }

    // 启动事务
    async startTransaction(metadata?: Record<string, any>): Promise<any> {
        try {
            logger.info('启动事务', { metadata });
            
            const response = await this.axiosInstance.post('/api/v1/transactions/start', {
                metadata: {
                    source: 'client',
                    timestamp: new Date().toISOString(),
                    ...metadata
                }
            });
            
            if (response.data.success) {
                logger.info('事务启动成功', { 
                    txId: response.data.txId,
                    duration: response.data.duration 
                });
            } else {
                logger.error('事务启动失败', new Error(response.data.message), {
                    txId: response.data.txId
                });
            }
            
            return response.data;
        } catch (error) {
            logger.error('事务启动异常', error as Error);
            throw error;
        }
    }

    // 获取系统健康状态
    async getHealth(): Promise<any> {
        try {
            const response = await this.axiosInstance.get('/api/v1/health');
            return response.data;
        } catch (error) {
            logger.error('获取健康状态异常', error as Error);
            throw error;
        }
    }

    // 获取系统指标
    async getMetrics(): Promise<any> {
        try {
            const response = await this.axiosInstance.get('/api/v1/metrics');
            return response.data;
        } catch (error) {
            logger.error('获取系统指标异常', error as Error);
            throw error;
        }
    }
}

// 演示完整的客户端使用流程
async function demonstrateClientUsage() {
    const tccServerUrl = process.env.TCC_SERVER_URL || 'http://localhost:5000';
    const client = new TccClient(tccServerUrl);

    logger.info('TCC 客户端示例启动', { tccServerUrl });

    try {
        // 1. 检查服务器健康状态
        logger.info('=== 检查服务器健康状态 ===');
        const health = await client.getHealth();
        logger.info('服务器健康状态', health);

        // 2. 注册多个组件
        logger.info('=== 注册业务组件 ===');
        const components = [
            {
                componentId: 'payment-service',
                endpoint: {
                    tryUrl: 'http://localhost:3001/try',
                    confirmUrl: 'http://localhost:3001/confirm',
                    cancelUrl: 'http://localhost:3001/cancel',
                    timeout: 30000
                },
                metadata: {
                    service: 'PaymentService',
                    version: '1.0.0',
                    description: '支付服务组件'
                }
            },
            {
                componentId: 'inventory-service',
                endpoint: {
                    tryUrl: 'http://localhost:3002/try',
                    confirmUrl: 'http://localhost:3002/confirm',
                    cancelUrl: 'http://localhost:3002/cancel',
                    timeout: 30000
                },
                metadata: {
                    service: 'InventoryService',
                    version: '1.0.0',
                    description: '库存服务组件'
                }
            },
            {
                componentId: 'shipping-service',
                endpoint: {
                    tryUrl: 'http://localhost:3003/try',
                    confirmUrl: 'http://localhost:3003/confirm',
                    cancelUrl: 'http://localhost:3003/cancel',
                    timeout: 30000
                },
                metadata: {
                    service: 'ShippingService',
                    version: '1.0.0',
                    description: '物流服务组件'
                }
            }
        ];

        for (const component of components) {
            await client.registerComponent(component);
            await new Promise(resolve => setTimeout(resolve, 500)); // 稍微延迟
        }

        // 3. 查看已注册的组件
        logger.info('=== 查看已注册组件 ===');
        const registeredComponents = await client.getComponents();
        logger.info('已注册组件', registeredComponents);

        // 4. 执行多笔事务
        logger.info('=== 执行分布式事务 ===');
        const transactionCount = 5;
        const results = [];

        for (let i = 1; i <= transactionCount; i++) {
            logger.info(`执行第 ${i} 笔事务`);
            
            try {
                const result = await client.startTransaction({
                    orderId: `ORDER_${Date.now()}_${i}`,
                    amount: 100 + i * 10,
                    description: `测试订单 ${i}`
                });
                
                results.push(result);
                
                // 每笔事务间隔1秒
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                logger.error(`第 ${i} 笔事务执行失败`, error as Error);
                results.push({ success: false, txId: -1, error: (error as Error).message });
            }
        }

        // 5. 统计结果
        logger.info('=== 事务执行结果统计 ===');
        const successCount = results.filter(r => r.success).length;
        const failureCount = results.length - successCount;
        
        logger.info('事务执行统计', {
            总数: results.length,
            成功: successCount,
            失败: failureCount,
            成功率: `${((successCount / results.length) * 100).toFixed(1)}%`
        });

        // 6. 获取系统指标
        logger.info('=== 获取系统指标 ===');
        const metrics = await client.getMetrics();
        logger.info('系统指标', metrics);

        // 7. 等待一段时间观察系统
        logger.info('=== 等待观察系统运行 ===');
        logger.info('等待 10 秒观察系统运行状态...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // 8. 取消注册组件（可选）
        logger.info('=== 取消注册组件（演示） ===');
        // 注释掉取消注册，保持组件可用于手动测试
        // for (const component of components) {
        //     await client.unregisterComponent(component.componentId);
        //     await new Promise(resolve => setTimeout(resolve, 500));
        // }

        logger.info('客户端示例执行完成');
        logger.info('提示：访问 http://localhost:3000/dashboard 查看仪表板');

    } catch (error) {
        logger.error('客户端示例执行失败', error as Error);
        throw error;
    }
}

// 如果直接运行此文件
if (require.main === module) {
    demonstrateClientUsage().catch(error => {
        console.error('客户端示例失败:', error);
        process.exit(1);
    });
}

export { TccClient, demonstrateClientUsage };
