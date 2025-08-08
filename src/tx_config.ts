export class TxConfig {
    // 事务执行时长限制，单位毫秒
    timeout: number;
    // 轮询监控任务间隔时长
    monitorInterval: number;
    // 是否启用轮询监控任务
    enableMonitor: boolean;

    constructor(timeout: number, monitorInterval: number, enableMonitor: boolean = true) {
        this.timeout = timeout > 0 ? timeout : 5000;
        this.monitorInterval = monitorInterval > 0 ? monitorInterval : 1000;
        this.enableMonitor = enableMonitor;
    }
}
