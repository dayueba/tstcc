import dayjs from 'dayjs';

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR'
}

export interface LogContext {
    txId?: number;
    componentId?: string;
    traceId?: string;
    [key: string]: any;
}

export interface Logger {
    debug(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, error?: Error, context?: LogContext): void;
}

export class ConsoleLogger implements Logger {
    private minLevel: LogLevel;

    constructor(minLevel: LogLevel = LogLevel.INFO) {
        this.minLevel = minLevel;
    }

    private shouldLog(level: LogLevel): boolean {
        const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
        return levels.indexOf(level) >= levels.indexOf(this.minLevel);
    }

    private formatLog(level: LogLevel, message: string, context?: LogContext, error?: Error): string {
        const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');
        const contextStr = context ? JSON.stringify(context) : '';
        const errorStr = error ? `\nError: ${error.message}\nStack: ${error.stack}` : '';
        
        return `[${timestamp}] ${level} ${message} ${contextStr}${errorStr}`;
    }

    debug(message: string, context?: LogContext): void {
        if (this.shouldLog(LogLevel.DEBUG)) {
            console.log(this.formatLog(LogLevel.DEBUG, message, context));
        }
    }

    info(message: string, context?: LogContext): void {
        if (this.shouldLog(LogLevel.INFO)) {
            console.log(this.formatLog(LogLevel.INFO, message, context));
        }
    }

    warn(message: string, context?: LogContext): void {
        if (this.shouldLog(LogLevel.WARN)) {
            console.warn(this.formatLog(LogLevel.WARN, message, context));
        }
    }

    error(message: string, error?: Error, context?: LogContext): void {
        if (this.shouldLog(LogLevel.ERROR)) {
            console.error(this.formatLog(LogLevel.ERROR, message, context, error));
        }
    }
}

// 全局日志实例
export const logger = new ConsoleLogger(LogLevel.INFO);
