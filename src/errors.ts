export class TccError extends Error {
    constructor(message: string, public readonly code: string, public readonly cause?: Error) {
        super(message);
        this.name = 'TccError';
    }
}

export class TransactionTimeoutError extends TccError {
    constructor(txId: number, timeoutMs: number, cause?: Error) {
        super(`事务 ${txId} 超时 (${timeoutMs}ms)`, 'TRANSACTION_TIMEOUT', cause);
        this.name = 'TransactionTimeoutError';
    }
}

export class ComponentExecutionError extends TccError {
    constructor(
        public readonly componentId: string,
        public readonly phase: 'try' | 'confirm' | 'cancel',
        message: string,
        cause?: Error
    ) {
        super(`组件 ${componentId} ${phase} 阶段执行失败: ${message}`, 'COMPONENT_EXECUTION_ERROR', cause);
        this.name = 'ComponentExecutionError';
    }
}

export class TransactionNotFoundError extends TccError {
    constructor(txId: number) {
        super(`事务 ${txId} 不存在`, 'TRANSACTION_NOT_FOUND');
        this.name = 'TransactionNotFoundError';
    }
}

export class DuplicateComponentError extends TccError {
    constructor(componentId: string) {
        super(`组件 ${componentId} 已注册，不能重复注册`, 'DUPLICATE_COMPONENT');
        this.name = 'DuplicateComponentError';
    }
}

export class StorageError extends TccError {
    constructor(operation: string, cause?: Error) {
        super(`存储操作失败: ${operation}`, 'STORAGE_ERROR', cause);
        this.name = 'StorageError';
    }
}

export class LockAcquisitionError extends TccError {
    constructor(resource: string, timeoutMs: number) {
        super(`获取锁失败: ${resource} (超时 ${timeoutMs}ms)`, 'LOCK_ACQUISITION_ERROR');
        this.name = 'LockAcquisitionError';
    }
}

export class InvalidTransactionStateError extends TccError {
    constructor(txId: number, currentState: string, expectedState: string) {
        super(
            `事务 ${txId} 状态无效: 当前状态 ${currentState}, 期望状态 ${expectedState}`,
            'INVALID_TRANSACTION_STATE'
        );
        this.name = 'InvalidTransactionStateError';
    }
}

// 错误工具函数
export function wrapError(error: unknown, context: string): Error {
    if (error instanceof Error) {
        return error;
    }
    
    return new Error(`${context}: ${String(error)}`);
}

export function isRetryableError(error: Error): boolean {
    // 网络错误、超时错误、临时存储错误等可以重试
    return error.message.includes('ECONNREFUSED') ||
           error.message.includes('ETIMEDOUT') ||
           error.message.includes('ENOTFOUND') ||
           error.message.includes('timeout') ||
           error instanceof StorageError;
}
