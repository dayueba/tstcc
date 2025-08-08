import { logger } from './logger';

export interface RetryConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitterMs?: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterMs: 100
};

export class RetryableError extends Error {
    constructor(message: string, public readonly cause?: Error) {
        super(message);
        this.name = 'RetryableError';
    }
}

export async function withRetry<T>(
    operation: () => Promise<T>,
    config: Partial<RetryConfig> = {},
    context?: { txId?: number; componentId?: string; operation?: string }
): Promise<T> {
    const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
    let lastError: Error;
    
    for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                logger.info(`重试操作，第 ${attempt} 次尝试`, context);
            }
            
            return await operation();
        } catch (error) {
            lastError = error as Error;
            
            // 如果不是可重试错误，直接抛出
            if (!(error instanceof RetryableError)) {
                logger.error(`操作失败，不可重试`, lastError, context);
                throw error;
            }
            
            // 如果已经达到最大重试次数，抛出错误
            if (attempt >= finalConfig.maxRetries) {
                logger.error(`操作失败，已达到最大重试次数 ${finalConfig.maxRetries}`, lastError, context);
                throw lastError;
            }
            
            // 计算延迟时间
            const delay = Math.min(
                finalConfig.baseDelayMs * Math.pow(finalConfig.backoffMultiplier, attempt),
                finalConfig.maxDelayMs
            );
            
            // 添加随机抖动
            const jitter = finalConfig.jitterMs ? Math.random() * finalConfig.jitterMs : 0;
            const finalDelay = delay + jitter;
            
            logger.warn(`操作失败，${finalDelay}ms 后重试`, { ...context, attempt, delay: finalDelay, error: lastError.message });
            
            await new Promise(resolve => setTimeout(resolve, finalDelay));
        }
    }
    
    throw lastError!;
}
