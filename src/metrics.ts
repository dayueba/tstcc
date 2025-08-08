import { logger } from './logger';
import * as dayjs from 'dayjs';

export interface TccMetrics {
    transactionStarted: number;
    transactionSuccess: number;
    transactionFailure: number;
    transactionTimeout: number;
    componentTrySuccess: number;
    componentTryFailure: number;
    componentConfirmSuccess: number;
    componentConfirmFailure: number;
    componentCancelSuccess: number;
    componentCancelFailure: number;
    retryCount: number;
    averageTransactionDuration: number;
    hangingTransactionCount: number;
}

export interface MetricsCollector {
    recordTransactionStarted(): void;
    recordTransactionSuccess(durationMs: number): void;
    recordTransactionFailure(durationMs: number): void;
    recordTransactionTimeout(durationMs: number): void;
    recordComponentTry(componentId: string, success: boolean): void;
    recordComponentConfirm(componentId: string, success: boolean): void;
    recordComponentCancel(componentId: string, success: boolean): void;
    recordRetry(operation: string): void;
    recordHangingTransactionCount(count: number): void;
    getMetrics(): TccMetrics;
    reset(): void;
}

export class InMemoryMetricsCollector implements MetricsCollector {
    private metrics: TccMetrics = {
        transactionStarted: 0,
        transactionSuccess: 0,
        transactionFailure: 0,
        transactionTimeout: 0,
        componentTrySuccess: 0,
        componentTryFailure: 0,
        componentConfirmSuccess: 0,
        componentConfirmFailure: 0,
        componentCancelSuccess: 0,
        componentCancelFailure: 0,
        retryCount: 0,
        averageTransactionDuration: 0,
        hangingTransactionCount: 0
    };
    private transactionDurations: number[] = [];
    private readonly maxDurationSamples = 1000; // 保留最近1000个样本

    constructor() {
        this.reset();
    }

    reset(): void {
        this.metrics = {
            transactionStarted: 0,
            transactionSuccess: 0,
            transactionFailure: 0,
            transactionTimeout: 0,
            componentTrySuccess: 0,
            componentTryFailure: 0,
            componentConfirmSuccess: 0,
            componentConfirmFailure: 0,
            componentCancelSuccess: 0,
            componentCancelFailure: 0,
            retryCount: 0,
            averageTransactionDuration: 0,
            hangingTransactionCount: 0
        };
        this.transactionDurations = [];
    }

    recordTransactionStarted(): void {
        this.metrics.transactionStarted++;
    }

    recordTransactionSuccess(durationMs: number): void {
        this.metrics.transactionSuccess++;
        this.recordDuration(durationMs);
    }

    recordTransactionFailure(durationMs: number): void {
        this.metrics.transactionFailure++;
        this.recordDuration(durationMs);
    }

    recordTransactionTimeout(durationMs: number): void {
        this.metrics.transactionTimeout++;
        this.recordDuration(durationMs);
    }

    recordComponentTry(componentId: string, success: boolean): void {
        if (success) {
            this.metrics.componentTrySuccess++;
        } else {
            this.metrics.componentTryFailure++;
        }
    }

    recordComponentConfirm(componentId: string, success: boolean): void {
        if (success) {
            this.metrics.componentConfirmSuccess++;
        } else {
            this.metrics.componentConfirmFailure++;
        }
    }

    recordComponentCancel(componentId: string, success: boolean): void {
        if (success) {
            this.metrics.componentCancelSuccess++;
        } else {
            this.metrics.componentCancelFailure++;
        }
    }

    recordRetry(operation: string): void {
        this.metrics.retryCount++;
        logger.debug('重试操作记录', { operation });
    }

    recordHangingTransactionCount(count: number): void {
        this.metrics.hangingTransactionCount = count;
    }

    private recordDuration(durationMs: number): void {
        this.transactionDurations.push(durationMs);
        
        // 保持样本数量在限制内
        if (this.transactionDurations.length > this.maxDurationSamples) {
            this.transactionDurations.shift();
        }
        
        // 更新平均时长
        this.metrics.averageTransactionDuration = 
            this.transactionDurations.reduce((sum, d) => sum + d, 0) / this.transactionDurations.length;
    }

    getMetrics(): TccMetrics {
        return { ...this.metrics };
    }

    // 获取成功率
    getSuccessRate(): number {
        const total = this.metrics.transactionSuccess + this.metrics.transactionFailure + this.metrics.transactionTimeout;
        return total > 0 ? this.metrics.transactionSuccess / total : 0;
    }

    // 打印指标摘要
    logMetricsSummary(): void {
        const metrics = this.getMetrics();
        const successRate = this.getSuccessRate();
        
        logger.info('TCC 事务指标摘要', {
            总事务数: metrics.transactionStarted,
            成功数: metrics.transactionSuccess,
            失败数: metrics.transactionFailure,
            超时数: metrics.transactionTimeout,
            成功率: `${(successRate * 100).toFixed(2)}%`,
            平均耗时: `${metrics.averageTransactionDuration.toFixed(2)}ms`,
            挂起事务数: metrics.hangingTransactionCount,
            重试次数: metrics.retryCount
        });
    }
}

// 全局指标收集器
export const metricsCollector = new InMemoryMetricsCollector();
