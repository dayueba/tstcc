import { TxManager } from "../src/tx_manager";
import { MySQLTxStore } from "../src/stores/mysql-store";
import { TccServer } from "../src/server";
import { logger, LogLevel, ConsoleLogger } from "../src/logger";
import { DEFAULT_CONFIG, loadConfigFromEnv, mergeConfig, createTxConfig, validateConfig } from "../src/config";
import * as mysql from 'mysql2/promise';

// 扩展配置以支持服务器配置
interface ServerTccConfig {
    transaction: {
        timeout: number;
        monitorInterval: number;
        enableMonitor: boolean;
    };
    retry: {
        maxRetries: number;
        baseDelayMs: number;
        maxDelayMs: number;
        backoffMultiplier: number;
        jitterMs?: number;
    };
    logging: {
        level: any;
    };
    database: {
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        connectionLimit?: number;
        acquireTimeout?: number;
        timeout?: number;
    };
    monitoring: {
        metricsEnabled: boolean;
        healthCheckInterval?: number;
    };
    server: {
        port: number;
        host: string;
        enableCors: boolean;
    };
}

const DEFAULT_SERVER_CONFIG: ServerTccConfig = {
    ...DEFAULT_CONFIG,
    server: {
        port: 5000,
        host: '0.0.0.0',
        enableCors: true
    }
};

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
        logger.info('开始优雅关闭 TCC 服务器...');

        for (const handler of this.shutdownHandlers) {
            try {
                await handler();
            } catch (error) {
                logger.error('关闭处理器执行失败', error as Error);
            }
        }

        logger.info('TCC 服务器优雅关闭完成');
        process.exit(0);
    }

    setupSignalHandlers() {
        process.on('SIGTERM', () => {
            logger.info('收到 SIGTERM 信号');
            this.shutdown();
        });
        
        process.on('SIGINT', () => {
            logger.info('收到 SIGINT 信号');
            this.shutdown();
        });
        
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
            INDEX idx_status (status),
            INDEX idx_created_at (created_at)
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
         ('bob', 500.00),
         ('charlie', 800.00)`
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

// 加载服务器配置
function loadServerConfigFromEnv(): Partial<ServerTccConfig> {
    const baseConfig = loadConfigFromEnv();
    const serverConfig: Partial<ServerTccConfig> = {
        ...baseConfig,
        server: {
            port: parseInt(process.env.TCC_SERVER_PORT || '5000'),
            host: process.env.TCC_SERVER_HOST || '0.0.0.0',
            enableCors: process.env.TCC_ENABLE_CORS !== 'false'
        }
    };
    
    return serverConfig;
}

// 主函数
async function main() {
    const shutdown = new GracefulShutdown();
    shutdown.setupSignalHandlers();

    try {
        // 加载配置
        const envConfig = loadServerConfigFromEnv();
        const config: ServerTccConfig = {
            ...DEFAULT_SERVER_CONFIG,
            ...envConfig
        };
        
        // 验证基础配置
        const configErrors = validateConfig(config);
        if (configErrors.length > 0) {
            logger.error('配置验证失败', new Error(configErrors.join('; ')));
            process.exit(1);
        }

        // 设置日志级别
        const customLogger = new ConsoleLogger(config.logging.level);
        Object.setPrototypeOf(logger, customLogger);

        logger.info('TCC HTTP 服务器启动', { 
            config: {
                server: config.server,
                database: { ...config.database, password: '***' },
                logging: config.logging,
                transaction: config.transaction
            }
        });

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

        // 创建事务管理器（启用监控）
        const txConfig = createTxConfig({
            ...config,
            transaction: {
                ...config.transaction,
                enableMonitor: true  // HTTP 服务器模式下启用监控
            }
        });
        const txManager = new TxManager(txStore, txConfig);

        shutdown.addHandler(async () => {
            logger.info('停止事务管理器');
            await txManager.stop();
        });

        // 创建并启动 HTTP 服务器
        const tccServer = new TccServer(txManager, {
            port: config.server.port,
            host: config.server.host,
            enableCors: config.server.enableCors
        });

        shutdown.addHandler(async () => {
            logger.info('停止 HTTP 服务器');
            await tccServer.stop();
        });

        // 启动服务器
        await tccServer.start();

        logger.info('TCC HTTP 服务器启动完成', {
            dashboard: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}/dashboard`,
            api: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}/api/v1`,
            healthCheck: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}/api/v1/health`
        });

        // 打印使用说明
        logger.info('使用说明', {
            '访问仪表板': `浏览器打开 http://localhost:${config.server.port}/dashboard`,
            '注册组件': 'POST /api/v1/components/register',
            '启动事务': 'POST /api/v1/transactions/start',
            '查看健康状态': 'GET /api/v1/health',
            '查看指标': 'GET /api/v1/metrics'
        });

        // 保持进程运行
        await new Promise(() => {});

    } catch (error) {
        logger.error('TCC HTTP 服务器启动失败', error as Error);
        process.exit(1);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(error => {
        console.error('程序启动失败:', error);
        process.exit(1);
    });
}

export { main as runTccServer };
