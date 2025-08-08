import { TxManager } from "../src/tx_manager";
import { TxConfig } from "../src/tx_config";
import { MySQLTxStore } from "../src/stores/mysql-store";
import { logger, LogLevel } from "../src/logger";
import { metricsCollector } from "../src/metrics";
import * as mysql from 'mysql2/promise';
import { TccComponent } from "../src/tccComponent";
import { TxStore } from "../src/tx_store";
import { ComponentTryStatus, TXStatus } from "../src/enums";
import { Transaction } from "../src/model";
import * as dayjs from "dayjs";


// a转账给b 100元
class MockComponent implements TccComponent {
    id: string
    // redisClient: Redis
    pool: mysql.Pool

    try_sql: string;
    confirm_sql: string;
    cancel_sql: string;

    constructor(id: string, pool: mysql.Pool, try_sql: string, confirm_sql: string, cancel_sql: string) {
        this.id = id
        this.pool = pool
        this.try_sql = try_sql
        this.confirm_sql = confirm_sql
        this.cancel_sql = cancel_sql
    }

    async try() {
        const [res] = await this.pool.execute(this.try_sql);
        if ((res as any).affectedRows === 0) {
            throw new Error('try阶段失败');
        }
    }

    async confirm() {
        const [res] = await this.pool.execute(this.confirm_sql);
        if ((res as any).affectedRows === 0) {
            throw new Error('confirm阶段失败');
        }
    }

    async cancel() {
        const [res] = await this.pool.execute(this.cancel_sql);
        if ((res as any).affectedRows === 0) {
            throw new Error('cancel阶段失败');
        }
    }
}

function newUpdateTradingSql(user_id: string, amount: number) {
    return `update wallet set trading_balance = trading_balance + ${amount} where user_id = '${user_id}' and trading_balance + ${amount} + balance >= 0`
}

function newUpdateBalanceSql(user_id: string, amount: number) {
    return `update wallet set trading_balance=trading_balance-${amount}, balance=balance+${amount} where user_id = '${user_id}'`
}

class MockTxStore implements TxStore {
    pool: mysql.Pool

    constructor(pool: mysql.Pool) {
        this.pool = pool
    }

    async TXUpdateComponentStatus(txID: number, componentID: string, success: boolean): Promise<void> {
        const status = success ? ComponentTryStatus.TrySuccessful : ComponentTryStatus.TryFailure;
        const sql = `update tx_record set component_try_statuses = json_replace(component_try_statuses,'$.${componentID}.tryStatus','${status}') where id = ?`
        const [res] = await this.pool.execute(sql, [txID])
        if ((res as any).affectedRows === 0) {
            throw new Error('更新事务记录失败');
        }
    }

    async TXSubmit(txID: number, success: boolean): Promise<void> {
        const status = success ? TXStatus.TXSuccessful : TXStatus.TXFailure
        const sql = `update tx_record set status = ? where id = ?`
        const [res] = await this.pool.execute(sql, [status, txID])
        if ((res as any).affectedRows === 0) {
            throw new Error('更新事务记录失败');
        }
    }
    async GetHangingTXs(): Promise<Transaction[]> {
        const context = { operation: 'GetHangingTXs' };
        
        try {
            const sql = `
                SELECT * FROM tx_record 
                WHERE status = ? 
                ORDER BY created_at ASC
                LIMIT 100
            `;
            
            const [rows] = await this.pool.query(sql, [TXStatus.TXHanging]);
            
            const transactions = (rows as any[]).map(row => {
                return {
                    id: row.id,
                    status: row.status,
                    component_try_statuses: typeof row.component_try_statuses === 'string'
                        ? JSON.parse(row.component_try_statuses)
                        : row.component_try_statuses,
                    created_at: dayjs(row.created_at).format('YYYY-MM-DD HH:mm:ss')
                } as Transaction;
            });
            
            logger.debug('获取挂起事务成功', { ...context, count: transactions.length });
            return transactions;
            
        } catch (error) {
            logger.error('获取挂起事务失败', error as Error, context);
            return [];
        }
    }
    async GetTX(txID: number): Promise<Transaction> {
        const [res] = await this.pool.query(`select * from tx_record where id = ${txID}`)
        if ((res as any[]).length === 0) {
            throw new Error('未找到事务记录');
        }
        const row = (res as any[])[0];
        // 解析 JSON 字段
        const tx: Transaction = {
            id: row.id,
            status: row.status,
            component_try_statuses: typeof row.component_try_statuses === 'string'
                ? JSON.parse(row.component_try_statuses)
                : row.component_try_statuses,
            created_at: dayjs(row.created_at).format('YYYY-MM-DD HH:mm:ss')
        };
        return tx

    }
    async Lock(expireDuration: number): Promise<void> {
        const context = { operation: 'Lock', expireDuration };
        
        try {
            // 使用 GET_LOCK 函数实现分布式锁
            const sql = `SELECT GET_LOCK(?, ?) as lock_result`;
            const [rows] = await this.pool.query(sql, ['tcc_global_lock', expireDuration / 1000]);
            
            const lockResult = (rows as any[])[0]?.lock_result;
            
            if (lockResult !== 1) {
                throw new Error(`获取锁失败: ${lockResult}`);
            }

            logger.debug('获取锁成功', context);
            
        } catch (error) {
            logger.error('获取锁失败', error as Error, context);
            throw error;
        }
    }
    
    async Unlock(): Promise<void> {
        const context = { operation: 'Unlock' };
        
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
        }
    }

    async CreateTx(components: TccComponent[]): Promise<number> {
        const tryStatusMap = new Map<string, {componentId: string, tryStatus: ComponentTryStatus}>();

        for (const component of components) {
            tryStatusMap.set(component.id, {
                componentId: component.id,
                tryStatus: ComponentTryStatus.TryHanging
            })
        }

        const sql = `insert into tx_record (status, component_try_statuses, created_at) values ('${TXStatus.TXHanging}', '${JSON.stringify(Object.fromEntries(tryStatusMap))}', '${dayjs().format('YYYY-MM-DD HH:mm:ss')}')`
        const [res] = await this.pool.execute(sql)
        if ((res as any).affectedRows === 0) {
            throw new Error('插入事务记录失败');
        }
        return (res as any).insertId;
    }

}

async function main() {
    // 设置日志级别为 DEBUG 以查看详细日志
    logger.info('TCC 分布式事务示例启动');

    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '123456',
        database: 'test',
        waitForConnections: true,
        connectionLimit: 10,
        maxIdle: 10, // max idle connections, the default value is the same as `connectionLimit`
        idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0
    });

    // 创建组件：A 向 B 转账 100 元
    const componentA = new MockComponent(
        'A', pool, 
        newUpdateTradingSql('A', -100),  // try: 冻结 A 的 100 元
        newUpdateBalanceSql('A', -100),  // confirm: 从 A 的余额中扣除 100 元
        newUpdateBalanceSql('A', 100)    // cancel: 解冻 A 的 100 元
    );
    
    const componentB = new MockComponent(
        'B', pool, 
        newUpdateTradingSql('B', 100),   // try: 为 B 预留 100 元
        newUpdateBalanceSql('B', 100),   // confirm: 增加 B 的余额 100 元
        newUpdateBalanceSql('B', -100)   // cancel: 取消为 B 预留的 100 元
    );

    // 使用生产级存储（可选，这里仍用示例存储）
    const txStore = new MockTxStore(pool);
    // 或者使用生产级存储：
    // const txStore = new MySQLTxStore({ pool });

    // 配置：5秒超时，1秒监控间隔，关闭监控（示例）
    const config = new TxConfig(5000, 1000, false);
    const txManager = new TxManager(txStore, config);

    try {
        // 注册组件
        txManager.register(componentA);
        txManager.register(componentB);

        logger.info('开始执行转账事务');
        
        // 启动事务
        const result = await txManager.startTransaction();
        
        if (result.success) {
            logger.info('转账事务执行成功', { txId: result.txId });
        } else {
            logger.warn('转账事务执行失败', { txId: result.txId });
        }

        // 打印指标
        metricsCollector.logMetricsSummary();
        
    } catch (e) {
        logger.error('转账事务异常', e as Error);
    } finally {
        // 优雅停止
        await txManager.stop();
        await pool.end();
        logger.info('示例程序结束');
    }
}

main()
