import * as mysql from 'mysql2/promise';
import * as dayjs from 'dayjs';
import { TxStore } from '../tx_store';
import { TccComponent } from '../tccComponent';
import { Transaction, ComponentTryStatusRecord } from '../model';
import { ComponentTryStatus, TXStatus } from '../enums';
import { logger } from '../logger';
import { StorageError, TransactionNotFoundError, LockAcquisitionError } from '../errors';
import { withRetry, RetryableError } from '../retry';

export interface MySQLStoreConfig {
    pool: mysql.Pool;
    lockTimeoutMs?: number;
    retryConfig?: {
        maxRetries: number;
        baseDelayMs: number;
    };
}

export class MySQLTxStore implements TxStore {
    private pool: mysql.Pool;
    private lockTimeoutMs: number;
    private lockKey: string | null = null;
    private lockExpireTime: Date | null = null;

    constructor(config: MySQLStoreConfig) {
        this.pool = config.pool;
        this.lockTimeoutMs = config.lockTimeoutMs || 30000; // 默认30秒锁超时
    }

    async CreateTx(components: TccComponent[]): Promise<number> {
        const context = { operation: 'CreateTx', componentCount: components.length };
        
        return withRetry(async () => {
            try {
                const tryStatusMap: ComponentTryStatusRecord = {};
                
                for (const component of components) {
                    tryStatusMap[component.id] = {
                        componentId: component.id,
                        tryStatus: ComponentTryStatus.TryHanging
                    };
                }

                const sql = `
                    INSERT INTO tx_record (status, component_try_statuses, created_at) 
                    VALUES (?, ?, ?)
                `;
                
                const [result] = await this.pool.execute(sql, [
                    TXStatus.TXHanging,
                    JSON.stringify(tryStatusMap),
                    dayjs().format('YYYY-MM-DD HH:mm:ss')
                ]);

                const insertId = (result as any).insertId;
                
                if (!insertId) {
                    throw new RetryableError('创建事务记录失败：未获得插入ID');
                }

                logger.info('事务记录创建成功', { ...context, txId: insertId });
                return insertId;
                
            } catch (error) {
                const wrappedError = new StorageError('CreateTx', error as Error);
                logger.error('创建事务记录失败', wrappedError, context);
                throw new RetryableError(wrappedError.message, wrappedError);
            }
        }, undefined, context);
    }

    async TXUpdateComponentStatus(txID: number, componentID: string, accept: boolean): Promise<void> {
        const context = { operation: 'TXUpdateComponentStatus', txId: txID, componentId: componentID, accept };
        
        return withRetry(async () => {
            try {
                const status = accept ? ComponentTryStatus.TrySuccessful : ComponentTryStatus.TryFailure;
                const sql = `
                    UPDATE tx_record 
                    SET component_try_statuses = JSON_REPLACE(
                        component_try_statuses, 
                        CONCAT('$."', ?, '".tryStatus'), 
                        ?
                    ) 
                    WHERE id = ?
                `;
                
                const [result] = await this.pool.execute(sql, [componentID, status, txID]);
                
                if ((result as any).affectedRows === 0) {
                    throw new TransactionNotFoundError(txID);
                }

                logger.debug('组件状态更新成功', context);
                
            } catch (error) {
                if (error instanceof TransactionNotFoundError) {
                    throw error;
                }
                
                const wrappedError = new StorageError('TXUpdateComponentStatus', error as Error);
                logger.error('更新组件状态失败', wrappedError, context);
                throw new RetryableError(wrappedError.message, wrappedError);
            }
        }, undefined, context);
    }

    async TXSubmit(txID: number, success: boolean): Promise<void> {
        const context = { operation: 'TXSubmit', txId: txID, success };
        
        return withRetry(async () => {
            try {
                const status = success ? TXStatus.TXSuccessful : TXStatus.TXFailure;
                const sql = `UPDATE tx_record SET status = ? WHERE id = ?`;
                
                const [result] = await this.pool.execute(sql, [status, txID]);
                
                if ((result as any).affectedRows === 0) {
                    throw new TransactionNotFoundError(txID);
                }

                logger.info('事务状态提交成功', context);
                
            } catch (error) {
                if (error instanceof TransactionNotFoundError) {
                    throw error;
                }
                
                const wrappedError = new StorageError('TXSubmit', error as Error);
                logger.error('提交事务状态失败', wrappedError, context);
                throw new RetryableError(wrappedError.message, wrappedError);
            }
        }, undefined, context);
    }

    async GetHangingTXs(): Promise<Transaction[]> {
        const context = { operation: 'GetHangingTXs' };
        
        return withRetry(async () => {
            try {
                // 查询挂起状态的事务，同时考虑超时的事务
                const sql = `
                    SELECT * FROM tx_record 
                    WHERE status = ? 
                    ORDER BY created_at ASC
                    LIMIT 100
                `;
                
                const [rows] = await this.pool.query(sql, [TXStatus.TXHanging]);
                
                const transactions = (rows as any[]).map(row => this.parseTransactionRow(row));
                
                logger.debug('获取挂起事务成功', { ...context, count: transactions.length });
                return transactions;
                
            } catch (error) {
                const wrappedError = new StorageError('GetHangingTXs', error as Error);
                logger.error('获取挂起事务失败', wrappedError, context);
                throw new RetryableError(wrappedError.message, wrappedError);
            }
        }, undefined, context);
    }

    async GetTX(txID: number): Promise<Transaction> {
        const context = { operation: 'GetTX', txId: txID };
        
        return withRetry(async () => {
            try {
                const sql = `SELECT * FROM tx_record WHERE id = ?`;
                const [rows] = await this.pool.query(sql, [txID]);
                
                if ((rows as any[]).length === 0) {
                    throw new TransactionNotFoundError(txID);
                }

                const transaction = this.parseTransactionRow((rows as any[])[0]);
                logger.debug('获取事务成功', context);
                return transaction;
                
            } catch (error) {
                if (error instanceof TransactionNotFoundError) {
                    throw error;
                }
                
                const wrappedError = new StorageError('GetTX', error as Error);
                logger.error('获取事务失败', wrappedError, context);
                throw new RetryableError(wrappedError.message, wrappedError);
            }
        }, undefined, context);
    }

    async Lock(expireDuration: number): Promise<void> {
        const context = { operation: 'Lock', expireDuration };
        
        return withRetry(async () => {
            try {
                const lockKey = `tcc_lock_${Date.now()}_${Math.random()}`;
                const expireTime = new Date(Date.now() + expireDuration);
                
                // 使用 GET_LOCK 函数实现分布式锁
                const sql = `SELECT GET_LOCK(?, ?) as lock_result`;
                const [rows] = await this.pool.query(sql, ['tcc_global_lock', expireDuration / 1000]);
                
                const lockResult = (rows as any[])[0]?.lock_result;
                
                if (lockResult !== 1) {
                    throw new LockAcquisitionError('tcc_global_lock', expireDuration);
                }

                this.lockKey = lockKey;
                this.lockExpireTime = expireTime;
                
                logger.debug('获取锁成功', { ...context, lockKey });
                
            } catch (error) {
                if (error instanceof LockAcquisitionError) {
                    throw error;
                }
                
                const wrappedError = new StorageError('Lock', error as Error);
                logger.error('获取锁失败', wrappedError, context);
                throw new RetryableError(wrappedError.message, wrappedError);
            }
        }, { maxRetries: 1 }, context); // 锁操作只重试一次
    }

    async Unlock(): Promise<void> {
        const context = { operation: 'Unlock', lockKey: this.lockKey };
        
        if (!this.lockKey) {
            logger.warn('尝试释放未持有的锁', context);
            return;
        }

        try {
            // 使用 RELEASE_LOCK 函数释放锁
            const sql = `SELECT RELEASE_LOCK(?) as release_result`;
            const [rows] = await this.pool.query(sql, ['tcc_global_lock']);
            
            const releaseResult = (rows as any[])[0]?.release_result;
            
            if (releaseResult !== 1) {
                logger.warn('释放锁失败或锁已过期', { ...context, releaseResult });
            } else {
                logger.debug('释放锁成功', context);
            }
            
        } catch (error) {
            logger.error('释放锁异常', error as Error, context);
        } finally {
            this.lockKey = null;
            this.lockExpireTime = null;
        }
    }

    private parseTransactionRow(row: any): Transaction {
        return {
            id: row.id,
            status: row.status,
            component_try_statuses: typeof row.component_try_statuses === 'string'
                ? JSON.parse(row.component_try_statuses)
                : row.component_try_statuses,
            created_at: dayjs(row.created_at).format('YYYY-MM-DD HH:mm:ss')
        };
    }

    // 健康检查
    async healthCheck(): Promise<boolean> {
        try {
            const [rows] = await this.pool.query('SELECT 1 as health');
            return (rows as any[])[0]?.health === 1;
        } catch (error) {
            logger.error('数据库健康检查失败', error as Error);
            return false;
        }
    }

    // 获取超时的事务（基于创建时间）
    async getTimeoutTransactions(timeoutMs: number): Promise<Transaction[]> {
        const context = { operation: 'getTimeoutTransactions', timeoutMs };
        
        try {
            const cutoffTime = dayjs().subtract(timeoutMs, 'millisecond').format('YYYY-MM-DD HH:mm:ss');
            const sql = `
                SELECT * FROM tx_record 
                WHERE status = ? AND created_at < ?
                ORDER BY created_at ASC
                LIMIT 100
            `;
            
            const [rows] = await this.pool.query(sql, [TXStatus.TXHanging, cutoffTime]);
            const transactions = (rows as any[]).map(row => this.parseTransactionRow(row));
            
            logger.debug('获取超时事务成功', { ...context, count: transactions.length });
            return transactions;
            
        } catch (error) {
            logger.error('获取超时事务失败', error as Error, context);
            return [];
        }
    }
}
