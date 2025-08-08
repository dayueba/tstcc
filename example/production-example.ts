import { TxManager } from "../src/tx_manager";
import { MySQLTxStore } from "../src/stores/mysql-store";
import { logger, LogLevel, ConsoleLogger } from "../src/logger";
import { metricsCollector } from "../src/metrics";
import { DEFAULT_CONFIG, loadConfigFromEnv, mergeConfig, createTxConfig, validateConfig } from "../src/config";
import { TccComponent } from "../src/tccComponent";
import { withRetry, RetryableError } from "../src/retry";
import * as mysql from 'mysql2/promise';
import * as dayjs from "dayjs";

// 生产级转账组件实现
class TransferComponent implements TccComponent {
    id: string;
    private pool: mysql.Pool;
    private userId: string;
    private amount: number;

    constructor(id: string, pool: mysql.Pool, userId: string, amount: number) {
        this.id = id;
        this.pool = pool;
        this.userId = userId;
        this.amount = amount;
    }

    async try(): Promise<void> {
        // Try 阶段：冻结资金
        const sql = `
            UPDATE wallet 
            SET trading_balance = trading_balance + ?, 
                updated_at = NOW()
            WHERE user_id = ? 
            AND balance + trading_balance + ? >= 0
        `;
        
        const [result] = await this.pool.execute(sql, [this.amount, this.userId, this.amount]);
        
        if ((result as any).affectedRows === 0) {
            throw new RetryableError(`用户 ${this.userId} 资金不足或不存在`);
        }

        logger.debug('Try 阶段成功', { 
            componentId: this.id, 
            userId: this.userId, 
            amount: this.amount 
        });
    }

    async confirm(): Promise<void> {
        // Confirm 阶段：确认转账，从冻结资金转移到实际余额
        const sql = `
            UPDATE wallet 
            SET trading_balance = trading_balance - ?,
                balance = balance + ?,
                updated_at = NOW()
            WHERE user_id = ?
        `;
        
        const [result] = await this.pool.execute(sql, [this.amount, this.amount, this.userId]);
        
        if ((result as any).affectedRows === 0) {
            throw new RetryableError(`确认转账失败：用户 ${this.userId} 不存在`);
        }

        logger.debug('Confirm 阶段成功', { 
            componentId: this.id, 
            userId: this.userId, 
            amount: this.amount 
        });
    }

    async cancel(): Promise<void> {
        // Cancel 阶段：回滚冻结的资金
        const sql = `
            UPDATE wallet 
            SET trading_balance = trading_balance - ?,
                updated_at = NOW()
            WHERE user_id = ?
        `;
        
        const [result] = await this.pool.execute(sql, [-this.amount, this.userId]);
        
        if ((result as any).affectedRows === 0) {
            logger.warn('Cancel 阶段警告：用户可能不存在', { 
                componentId: this.id, 
                userId: this.userId 
            });
            // Cancel 阶段即使失败也不抛出异常，确保幂等性
            return;
        }

        logger.debug('Cancel 阶段成功', { 
            componentId: this.id, 
            userId: this.userId, 
            amount: this.amount 
        });
    }
}

// 幂等性组件包装器
class IdempotentComponent implements TccComponent {
    id: string;
    private innerComponent: TccComponent;
    private pool: mysql.Pool;

    constructor(innerComponent: TccComponent, pool: mysql.Pool) {
        this.id = innerComponent.id;
        this.innerComponent = innerComponent;
        this.pool = pool;
    }

    async try(): Promise<void> {
        return this.innerComponent.try();
    }

    async confirm(): Promise<void> {
        const key = `confirm_${this.id}_${Date.now()}`;
        if (await this.checkIdempotency(key)) {
            logger.debug('Confirm 操作已执行，跳过', { componentId: this.id, key });
            return;
        }

        await this.innerComponent.confirm();
        await this.recordIdempotency(key);
    }

    async cancel(): Promise<void> {
        const key = `cancel_${this.id}_${Date.now()}`;
        if (await this.checkIdempotency(key)) {
            logger.debug('Cancel 操作已执行，跳过', { componentId: this.id, key });
            return;
        }

        await this.innerComponent.cancel();
        await this.recordIdempotency(key);
    }

    private async checkIdempotency(key: string): Promise<boolean> {
        try {
            const sql = `SELECT 1 FROM idempotency_keys WHERE idem_key = ?`;
            const [rows] = await this.pool.query(sql, [key]);
            return (rows as any[]).length > 0;
        } catch (error) {
            logger.warn('检查幂等性失败', { key, error: (error as Error).message });
            return false;
        }
    }

    private async recordIdempotency(key: string): Promise<void> {
        try {
            const sql = `
                INSERT IGNORE INTO idempotency_keys (idem_key, created_at) 
                VALUES (?, NOW())
            `;
            await this.pool.execute(sql, [key]);
        } catch (error) {
            logger.warn('记录幂等性失败', { key, error: (error as Error).message });
        }
    }
}

// 初始化数据库表
async function initDatabase(pool: mysql.Pool) {
    const tables = [
        // 钱包表
        `CREATE TABLE IF NOT EXISTS wallet (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL UNIQUE,
            balance DECIMAL(15,2) NOT NULL DEFAULT 0,
            trading_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_user_id (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        
        // 事务记录表
        `CREATE TABLE IF NOT EXISTS tx_record (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            status VARCHAR(16) NOT NULL COMMENT '事务状态',
            component_try_statuses JSON DEFAULT NULL COMMENT '各组件状态',
            created_at DATETIME NOT NULL COMMENT '创建时间',
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        
        // 幂等性键表
        `CREATE TABLE IF NOT EXISTS idempotency_keys (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            idem_key VARCHAR(255) NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        
        // 插入测试数据
        `INSERT IGNORE INTO wallet (user_id, balance) VALUES 
         ('alice', 1000.00), 
         ('bob', 500.00)`
    ];

    for (const sql of tables) {
        try {
            await pool.execute(sql);
        } catch (error) {
            logger.error('初始化数据库表失败', error as Error, { sql });
            throw error;
        }
    }
    
    logger.info('数据库初始化完成');
}

// 优雅关闭处理
class GracefulShutdown {
    private shutdownHandlers: Array<() => Promise<void>> = [];
    private isShuttingDown = false;

    addHandler(handler: () => Promise<void>) {
        this.shutdownHandlers.push(handler);
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        
        this.isShuttingDown = true;
        logger.info('开始优雅关闭...');

        for (const handler of this.shutdownHandlers) {
            try {
                await handler();
            } catch (error) {
                logger.error('关闭处理器执行失败', error as Error);
            }
        }

        logger.info('优雅关闭完成');
        process.exit(0);
    }

    setupSignalHandlers() {
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
        process.on('uncaughtException', (error) => {
            logger.error('未捕获的异常', error);
            this.shutdown();
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('未处理的 Promise 拒绝', reason as Error, { promise });
            this.shutdown();
        });
    }
}

// 主函数
async function main() {
    const shutdown = new GracefulShutdown();
    shutdown.setupSignalHandlers();

    try {
        // 加载配置
        const envConfig = loadConfigFromEnv();
        const config = mergeConfig(DEFAULT_CONFIG, envConfig);
        
        // 验证配置
        const configErrors = validateConfig(config);
        if (configErrors.length > 0) {
            logger.error('配置验证失败', new Error(configErrors.join('; ')));
            process.exit(1);
        }

        // 设置日志级别
        const customLogger = new ConsoleLogger(config.logging.level);
        Object.setPrototypeOf(logger, customLogger);

        logger.info('TCC 生产级示例启动', { config });

        // 创建数据库连接池
        const pool = mysql.createPool({
            host: config.database.host,
            port: config.database.port,
            user: config.database.user,
            password: config.database.password,
            database: config.database.database,
            waitForConnections: true,
            connectionLimit: config.database.connectionLimit,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0
        });

        shutdown.addHandler(async () => {
            logger.info('关闭数据库连接池');
            await pool.end();
        });

        // 初始化数据库
        await initDatabase(pool);

        // 创建存储实例
        const txStore = new MySQLTxStore({ 
            pool,
            lockTimeoutMs: 30000,
            retryConfig: config.retry
        });

        // 创建事务管理器
        const txConfig = createTxConfig(config);
        const txManager = new TxManager(txStore, txConfig);

        shutdown.addHandler(async () => {
            logger.info('停止事务管理器');
            await txManager.stop();
        });

        // 创建转账组件（Alice 向 Bob 转账 100 元）
        const transferAmount = 100;
        const aliceComponent = new TransferComponent('alice_transfer', pool, 'alice', -transferAmount);
        const bobComponent = new TransferComponent('bob_receive', pool, 'bob', transferAmount);

        // 包装为幂等组件
        const idempotentAlice = new IdempotentComponent(aliceComponent, pool);
        const idempotentBob = new IdempotentComponent(bobComponent, pool);

        // 注册组件
        txManager.register(idempotentAlice);
        txManager.register(idempotentBob);

        // 执行多笔转账测试
        const transferCount = 3;
        const results = [];

        for (let i = 1; i <= transferCount; i++) {
            logger.info(`开始第 ${i} 笔转账`, { amount: transferAmount });
            
            try {
                const result = await txManager.startTransaction();
                results.push(result);
                
                if (result.success) {
                    logger.info(`第 ${i} 笔转账成功`, { txId: result.txId });
                } else {
                    logger.warn(`第 ${i} 笔转账失败`, { txId: result.txId });
                }
                
                // 间隔一秒
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                logger.error(`第 ${i} 笔转账异常`, error as Error);
                results.push({ txId: -1, success: false });
            }
        }

        // 打印最终结果
        const successCount = results.filter(r => r.success).length;
        logger.info('转账测试完成', { 
            total: transferCount,
            success: successCount,
            failed: transferCount - successCount
        });

        // 打印指标摘要
        metricsCollector.logMetricsSummary();

        // 查询最终余额
        try {
            const [balances] = await pool.query(`
                SELECT user_id, balance, trading_balance 
                FROM wallet 
                WHERE user_id IN ('alice', 'bob')
            `);
            
            logger.info('最终余额', { balances });
        } catch (error) {
            logger.error('查询余额失败', error as Error);
        }

        // 等待一段时间观察监控
        logger.info('等待 10 秒观察系统运行...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        logger.info('生产级示例执行完成');

    } catch (error) {
        logger.error('生产级示例执行失败', error as Error);
        process.exit(1);
    } finally {
        await shutdown.shutdown();
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(error => {
        console.error('程序启动失败:', error);
        process.exit(1);
    });
}

export { main as runProductionExample };
