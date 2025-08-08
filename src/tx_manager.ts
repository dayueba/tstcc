import { TxStore } from "./tx_store";
import { TxConfig } from "./tx_config";
import { TccComponent } from "./tccComponent";
import { ComponentTryStatus, TXStatus } from "./enums";
import { Transaction } from "./model";
import { logger } from "./logger";
import { metricsCollector } from "./metrics";
import { withRetry, RetryableError } from "./retry";
import { 
    TransactionTimeoutError, 
    ComponentExecutionError, 
    DuplicateComponentError,
    wrapError,
    isRetryableError
} from "./errors";
import timers = require('timers/promises');


export class TxManager {
    // 内置的事务日志存储模块，需要由使用方实现并完成注入
    txStore: TxStore;
    components: Map<string, TccComponent>
    config: TxConfig;
    // 用于反映 TXManager 运行生命周期的的 context，当 ctx 终止时，异步轮询任务也会随之退出
    // ctx;
    stopFlag: boolean;
    private monitorPromise: Promise<void> | null = null;
    private readonly instanceId: string;

    constructor(txStore: TxStore, tsConfig: TxConfig) {
        this.txStore = txStore;
        this.config = tsConfig;
        this.components = new Map<string, TccComponent>();
        this.stopFlag = false;
        this.instanceId = `txmgr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        logger.info('TxManager 初始化', { 
            instanceId: this.instanceId,
            enableMonitor: this.config.enableMonitor,
            timeout: this.config.timeout,
            monitorInterval: this.config.monitorInterval 
        });

        if (this.config.enableMonitor) {
            this.monitorPromise = this.run();
        }
    }


    async run() {
        logger.info('监控任务启动', { instanceId: this.instanceId });
        
        while (!this.stopFlag) {
            try {
                await timers.setTimeout(this.config.monitorInterval);

                // 尝试获取锁以避免多节点竞争
                let lockAcquired = false;
                try {
                    await this.txStore.Lock(this.config.monitorInterval * 2);
                    lockAcquired = true;
                    
                    // 获取处于 hanging 状态的事务
                    const hangingTXs = await this.txStore.GetHangingTXs();
                    metricsCollector.recordHangingTransactionCount(hangingTXs.length);
                    
                    if (hangingTXs.length > 0) {
                        logger.info('发现挂起事务，开始处理', { 
                            instanceId: this.instanceId,
                            count: hangingTXs.length 
                        });
                    }

                    const jobs = [];
                    for (const transaction of hangingTXs) {
                        jobs.push(this.advanceTransactionProgress(transaction));
                    }

                    // 并发处理所有挂起事务
                    const results = await Promise.allSettled(jobs);
                    
                    // 记录处理结果
                    const succeeded = results.filter(r => r.status === 'fulfilled').length;
                    const failed = results.filter(r => r.status === 'rejected').length;
                    
                    if (failed > 0) {
                        logger.warn('部分挂起事务处理失败', {
                            instanceId: this.instanceId,
                            succeeded,
                            failed,
                            total: hangingTXs.length
                        });
                        
                        // 记录失败的详细信息
                        results.forEach((result, index) => {
                            if (result.status === 'rejected') {
                                logger.error('挂起事务处理失败', result.reason, {
                                    instanceId: this.instanceId,
                                    txId: hangingTXs[index].id
                                });
                            }
                        });
                    }
                    
                } catch (error) {
                    logger.error('监控任务执行异常', wrapError(error, '监控循环'), {
                        instanceId: this.instanceId
                    });
                } finally {
                    if (lockAcquired) {
                        try {
                            await this.txStore.Unlock();
                        } catch (unlockError) {
                            logger.error('释放锁失败', wrapError(unlockError, '监控循环'), {
                                instanceId: this.instanceId
                            });
                        }
                    }
                }
                
            } catch (error) {
                logger.error('监控任务异常', wrapError(error, '监控循环'), {
                    instanceId: this.instanceId
                });
                
                // 发生异常时等待更长时间再重试
                await timers.setTimeout(this.config.monitorInterval * 3);
            }
        }
        
        logger.info('监控任务停止', { instanceId: this.instanceId });
    }

    // TCC 组件不能重复注册
    register(component: TccComponent) {
        if (this.components.has(component.id)) {
            throw new DuplicateComponentError(component.id);
        }
        
        this.components.set(component.id, component);
        
        logger.info('组件注册成功', { 
            instanceId: this.instanceId,
            componentId: component.id,
            totalComponents: this.components.size 
        });
    }

    getComponents(): TccComponent[] {
        return Array.from(this.components.values());
    }

    async startTransaction(): Promise<{ txId: number; success: boolean }> {
        const startTime = Date.now();
        const components = this.getComponents();

        if (components.length === 0) {
            throw new Error('没有注册的组件，无法启动事务');
        }

        let txId: number;
        
        try {
            // 创建事务记录
            txId = await this.txStore.CreateTx(components);
            metricsCollector.recordTransactionStarted();
            
            logger.info('事务启动', { 
                instanceId: this.instanceId,
                txId, 
                componentCount: components.length,
                timeout: this.config.timeout 
            });

            const jobs: Array<Promise<void>> = []
            const timeout = this.config.timeout;
            
            // 超时 Promise
            const timer = new Promise<void>((resolve, reject) => {
                setTimeout(() => {
                    reject(new TransactionTimeoutError(txId, timeout))
                }, timeout);
            });
            jobs.push(timer);

            // 并发启动，批量执行各 tcc 组件的 try 流程
            for (const component of components) {
                jobs.push((async () => {
                    const componentStartTime = Date.now();
                    try {
                        logger.debug('组件 try 开始', { 
                            instanceId: this.instanceId,
                            txId, 
                            componentId: component.id 
                        });
                        
                        await component.try();
                        await this.txStore.TXUpdateComponentStatus(txId, component.id, true);
                        
                        metricsCollector.recordComponentTry(component.id, true);
                        logger.debug('组件 try 成功', { 
                            instanceId: this.instanceId,
                            txId, 
                            componentId: component.id,
                            duration: Date.now() - componentStartTime 
                        });
                        
                    } catch (e) {
                        const error = wrapError(e, `组件 ${component.id} try 阶段`);
                        
                        try {
                            await this.txStore.TXUpdateComponentStatus(txId, component.id, false);
                        } catch (updateError) {
                            logger.error('更新组件状态失败', wrapError(updateError, 'TXUpdateComponentStatus'), {
                                instanceId: this.instanceId,
                                txId,
                                componentId: component.id
                            });
                        }
                        
                        metricsCollector.recordComponentTry(component.id, false);
                        logger.error('组件 try 失败', error, { 
                            instanceId: this.instanceId,
                            txId, 
                            componentId: component.id,
                            duration: Date.now() - componentStartTime 
                        });
                        
                        throw new ComponentExecutionError(component.id, 'try', error.message, error);
                    }
                })())
            }

            let transactionSuccess = false;
            let transactionError: Error | null = null;
            
            try {
                await Promise.all(jobs);
                transactionSuccess = true;
            } catch (e) {
                transactionError = wrapError(e, 'try 阶段');
                transactionSuccess = false;
            }

            // 推进事务到第二阶段
            try {
                await this.advanceTransactionProgress(txId);
            } catch (advanceError) {
                logger.error('推进事务进度失败', wrapError(advanceError, 'advanceTransactionProgress'), {
                    instanceId: this.instanceId,
                    txId
                });
            }

            const duration = Date.now() - startTime;
            
            if (transactionSuccess) {
                metricsCollector.recordTransactionSuccess(duration);
                logger.info('事务完成（成功）', { 
                    instanceId: this.instanceId,
                    txId, 
                    duration,
                    success: true 
                });
            } else {
                if (transactionError instanceof TransactionTimeoutError) {
                    metricsCollector.recordTransactionTimeout(duration);
                } else {
                    metricsCollector.recordTransactionFailure(duration);
                }
                
                logger.info('事务完成（失败）', { 
                    instanceId: this.instanceId,
                    txId, 
                    duration,
                    success: false,
                    error: transactionError?.message 
                });
            }

            return { txId, success: transactionSuccess };
            
        } catch (error) {
            const duration = Date.now() - startTime;
            metricsCollector.recordTransactionFailure(duration);
            
            logger.error('事务启动失败', wrapError(error, 'startTransaction'), {
                instanceId: this.instanceId,
                duration
            });
            
            throw error;
        }
    }

    async advanceTransactionProgress(transaction: Transaction): Promise<void>;
    async advanceTransactionProgress(txID: number): Promise<void>;
    async advanceTransactionProgress(query: any): Promise<void> {
        let transaction: Transaction;
        if (typeof query === "number") {
            transaction = await this.txStore.GetTX(query)
        } else {
            transaction = query;
        }
        
        const txStatus = this.getStatus(transaction);
        const context = { 
            instanceId: this.instanceId,
            txId: transaction.id, 
            status: txStatus 
        };
        
        logger.debug('推进事务进度', context);
        
        if (txStatus === TXStatus.TXHanging) {
            // hanging 状态的事务暂时不处理
            logger.debug('事务仍在挂起状态，暂不处理', context);
            return;
        }

        if (txStatus === TXStatus.TXSuccessful) {
            logger.info('开始执行 confirm 阶段', context);
            
            const jobs: Array<Promise<void>> = []
            for (const component of this.getComponents()) {
                jobs.push((async () => {
                    await withRetry(async () => {
                        try {
                            await component.confirm();
                            metricsCollector.recordComponentConfirm(component.id, true);
                            logger.debug('组件 confirm 成功', { 
                                ...context, 
                                componentId: component.id 
                            });
                        } catch (error) {
                            metricsCollector.recordComponentConfirm(component.id, false);
                            logger.error('组件 confirm 失败', wrapError(error, `组件 ${component.id} confirm`), {
                                ...context,
                                componentId: component.id
                            });
                            
                            if (isRetryableError(wrapError(error, 'confirm'))) {
                                throw new RetryableError(`组件 ${component.id} confirm 失败: ${error}`, error as Error);
                            }
                            throw error;
                        }
                    }, undefined, { ...context, componentId: component.id, operation: 'confirm' });
                })())
            }

            await Promise.all(jobs);
            await this.txStore.TXSubmit(transaction.id, true);
            
            logger.info('事务 confirm 阶段完成', context);
            
        } else {
            logger.info('开始执行 cancel 阶段', context);
            
            const jobs: Array<Promise<void>> = []
            for (const component of this.getComponents()) {
                jobs.push((async () => {
                    await withRetry(async () => {
                        try {
                            await component.cancel();
                            metricsCollector.recordComponentCancel(component.id, true);
                            logger.debug('组件 cancel 成功', { 
                                ...context, 
                                componentId: component.id 
                            });
                        } catch (error) {
                            metricsCollector.recordComponentCancel(component.id, false);
                            logger.error('组件 cancel 失败', wrapError(error, `组件 ${component.id} cancel`), {
                                ...context,
                                componentId: component.id
                            });
                            
                            if (isRetryableError(wrapError(error, 'cancel'))) {
                                throw new RetryableError(`组件 ${component.id} cancel 失败: ${error}`, error as Error);
                            }
                            throw error;
                        }
                    }, undefined, { ...context, componentId: component.id, operation: 'cancel' });
                })())
            }

            await Promise.all(jobs);
            await this.txStore.TXSubmit(transaction.id, false);
            
            logger.info('事务 cancel 阶段完成', context);
        }
    }

    // 获取事务的状态
    getStatus(transaction: Transaction): TXStatus {
        // 1 如果事务超时了，都还未被置为成功，直接置为失败
        // 2 如果所有的 try 请求都成功了,—> successful
        // 3 如果有一个 try 请求失败,—> failure

        // 如果任一组件失败 -> 失败
        for (const component of this.getComponents()) {
            if (transaction.component_try_statuses[component.id].tryStatus === ComponentTryStatus.TryFailure) {
                return TXStatus.TXFailure
            }
        }

        // 如果存在仍在挂起的组件 -> 挂起
        for (const component of this.getComponents()) {
            if (transaction.component_try_statuses[component.id].tryStatus === ComponentTryStatus.TryHanging) {
                return TXStatus.TXHanging
            }
        }

        // 全部成功 -> 成功
        return TXStatus.TXSuccessful
    }

    async stop() {
        logger.info('开始停止 TxManager', { instanceId: this.instanceId });
        
        this.stopFlag = true;
        
        // 等待监控任务完成
        if (this.monitorPromise) {
            try {
                await this.monitorPromise;
                logger.info('监控任务已停止', { instanceId: this.instanceId });
            } catch (error) {
                logger.error('监控任务停止异常', wrapError(error, '停止监控任务'), {
                    instanceId: this.instanceId
                });
            }
        }
        
        // 打印最终指标
        metricsCollector.logMetricsSummary();
        
        logger.info('TxManager 已停止', { instanceId: this.instanceId });
    }

    // 获取健康状态
    async getHealthStatus(): Promise<{
        healthy: boolean;
        instanceId: string;
        componentsCount: number;
        monitorEnabled: boolean;
        metrics: any;
    }> {
        return {
            healthy: !this.stopFlag,
            instanceId: this.instanceId,
            componentsCount: this.components.size,
            monitorEnabled: this.config.enableMonitor,
            metrics: metricsCollector.getMetrics()
        };
    }
}
