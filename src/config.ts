import { TxConfig } from './tx_config';
import { LogLevel } from './logger';
import dotenv from 'dotenv';
dotenv.config();

export interface DatabaseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit?: number;
    acquireTimeout?: number;
    timeout?: number;
}

export interface TccConfig {
    // 事务配置
    transaction: {
        timeout: number;
        monitorInterval: number;
        enableMonitor: boolean;
    };
    
    // 重试配置
    retry: {
        maxRetries: number;
        baseDelayMs: number;
        maxDelayMs: number;
        backoffMultiplier: number;
        jitterMs?: number;
    };
    
    // 日志配置
    logging: {
        level: LogLevel;
    };
    
    // 数据库配置
    database: DatabaseConfig;
    
    // 监控配置
    monitoring: {
        metricsEnabled: boolean;
        healthCheckInterval?: number;
    };
}

// 默认配置
export const DEFAULT_CONFIG: TccConfig = {
    transaction: {
        timeout: 30000,           // 30秒事务超时
        monitorInterval: 5000,    // 5秒监控间隔
        enableMonitor: true       // 启用监控
    },
    retry: {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitterMs: 100
    },
    logging: {
        level: LogLevel.INFO
    },
    database: {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: '',
        database: 'tcc',
        connectionLimit: 10,
        acquireTimeout: 60000,
        timeout: 60000
    },
    monitoring: {
        metricsEnabled: true,
        healthCheckInterval: 30000  // 30秒健康检查间隔
    }
};

// 从环境变量加载配置
export function loadConfigFromEnv(): Partial<TccConfig> {
    const config: Partial<TccConfig> = {};
    console.log('DB_PASSWORD: ', process.env.DB_PASSWORD)
    
    // 事务配置
    if (process.env.TCC_TRANSACTION_TIMEOUT) {
        config.transaction = {
            ...DEFAULT_CONFIG.transaction,
            timeout: parseInt(process.env.TCC_TRANSACTION_TIMEOUT)
        };
    }
    
    if (process.env.TCC_MONITOR_INTERVAL) {
        config.transaction = {
            ...config.transaction || DEFAULT_CONFIG.transaction,
            monitorInterval: parseInt(process.env.TCC_MONITOR_INTERVAL)
        };
    }
    
    if (process.env.TCC_ENABLE_MONITOR) {
        config.transaction = {
            ...config.transaction || DEFAULT_CONFIG.transaction,
            enableMonitor: process.env.TCC_ENABLE_MONITOR === 'true'
        };
    }
    
    // 数据库配置
    if (process.env.DB_HOST || process.env.DB_PORT || process.env.DB_USER || 
        process.env.DB_PASSWORD || process.env.DB_NAME) {
        config.database = {
            ...DEFAULT_CONFIG.database,
            host: process.env.DB_HOST || DEFAULT_CONFIG.database.host,
            port: parseInt(process.env.DB_PORT || String(DEFAULT_CONFIG.database.port)),
            user: process.env.DB_USER || DEFAULT_CONFIG.database.user,
            password: process.env.DB_PASSWORD || DEFAULT_CONFIG.database.password,
            database: process.env.DB_NAME || DEFAULT_CONFIG.database.database
        };
    }
    
    // 日志配置
    if (process.env.LOG_LEVEL) {
        config.logging = {
            level: process.env.LOG_LEVEL as LogLevel
        };
    }
    
    return config;
}

// 合并配置
export function mergeConfig(base: TccConfig, override: Partial<TccConfig>): TccConfig {
    return {
        transaction: { ...base.transaction, ...override.transaction },
        retry: { ...base.retry, ...override.retry },
        logging: { ...base.logging, ...override.logging },
        database: { ...base.database, ...override.database },
        monitoring: { ...base.monitoring, ...override.monitoring }
    };
}

// 创建 TxConfig 实例
export function createTxConfig(config: TccConfig): TxConfig {
    return new TxConfig(
        config.transaction.timeout,
        config.transaction.monitorInterval,
        config.transaction.enableMonitor
    );
}

// 验证配置
export function validateConfig(config: TccConfig): string[] {
    const errors: string[] = [];
    
    // 验证事务配置
    if (config.transaction.timeout <= 0) {
        errors.push('事务超时时间必须大于0');
    }
    
    if (config.transaction.monitorInterval <= 0) {
        errors.push('监控间隔必须大于0');
    }
    
    // 验证重试配置
    if (config.retry.maxRetries < 0) {
        errors.push('最大重试次数不能小于0');
    }
    
    if (config.retry.baseDelayMs <= 0) {
        errors.push('基础延迟时间必须大于0');
    }
    
    // 验证数据库配置
    if (!config.database.host) {
        errors.push('数据库主机不能为空');
    }
    
    if (config.database.port <= 0 || config.database.port > 65535) {
        errors.push('数据库端口必须在1-65535之间');
    }
    
    if (!config.database.user) {
        errors.push('数据库用户名不能为空');
    }
    
    if (!config.database.database) {
        errors.push('数据库名不能为空');
    }
    
    return errors;
}
