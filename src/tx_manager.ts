import {TxStore} from "./tx_store";
import {TxConfig} from "./tx_config";
import {TccComponent} from "./tccComponent";
import {ComponentTryStatus, TXStatus} from "./enums";
import {Transaction} from "./model";
import timers = require('timers/promises');


export class TxManager {
    // 内置的事务日志存储模块，需要由使用方实现并完成注入
    txStore: TxStore;
    components: Map<string, TccComponent>
    config: TxConfig;
    // 用于反映 TXManager 运行生命周期的的 context，当 ctx 终止时，异步轮询任务也会随之退出
    // ctx;
    stopFlag: boolean;

    constructor(txStore: TxStore, tsConfig: TxConfig) {
        this.txStore = txStore;
        this.config = tsConfig;
        this.components = new Map<string, TccComponent>();
        this.stopFlag = false;

        this.run();
    }


    async run() {
        // 获取数据库中没有完成的分布式事务，多节点部署的情况下需要加锁，目前不需要
        while (!this.stopFlag) {
            // 这里可以加退避谦让策略，为了简单实现，统一
            await timers.setTimeout(this.config.monitorInterval);

            // 获取处于 hanging 状态的事务
            const hangingTXs = await this.txStore.GetHangingTXs()
            const jobs = [];
            for (const transaction of hangingTXs) {
                jobs.push(this.advanceTransactionProgress(transaction))
            }

            // 遇到多次失败的情况，建议添加告警，由开发人员介入
            await Promise.allSettled(jobs);
        }
    }

    // TCC 组件不能重复注册
    register(component: TccComponent) {
        if (this.components.has(component.id)) {
            throw new Error('TCC 组件不能重复注册')
        }
        this.components.set(component.id, component);
    }

    getComponents(): TccComponent[] {
        return Array.from(this.components.values());
    }

    async startTransaction() {
        const components = this.getComponents();

        // 创建事务记录
        const txId = await this.txStore.CreateTx(components)

        const jobs = []
        const timeout = this.config.timeout;
        const timer = new Promise((resolve, reject) => {
            setTimeout(() => {
                reject(new Error('timeout'))
            }, timeout);
        }) as Promise<Error>;
        jobs.push(timer);

        // 并发启动，批量执行各 tcc 组件的 try 流程
        for (const component of components) {
            jobs.push((async () => {
                try {
                    await component.try();
                    await this.txStore.TXUpdateComponentStatus(txId, component.id, true);
                } catch (e) {
                    await this.txStore.TXUpdateComponentStatus(txId, component.id, false);
                    throw e;
                }
            })())
        }

        // 只要超时或者一个try失败 就立即返回
        await Promise.all(jobs);


        // 异步执行第二阶段的 confirm/cancel 流程
        // 之所以是异步，是因为实际上在第一阶段 try 的响应结果尘埃落定时，对应事务的成败已经有了定论
        // 第二阶段能够容忍异步执行的原因在于，执行失败时，还有轮询任务进行兜底
        this.advanceTransactionProgress(txId)


        // try阶段不管成功或者失败，只要执行完，事务就算完成
    }

    async advanceTransactionProgress(transaction: Transaction): Promise<void>;
    async advanceTransactionProgress(txID: number): Promise<void>;
    async advanceTransactionProgress(query: any): Promise<void> {
        let transaction: Transaction;
        if (typeof query === "number") {
            transaction = await this.txStore.GetTX(query)
        } else {
            transaction = query;
        }
        const txStatus = this.getStatus(transaction)
        if (txStatus === TXStatus.TXHanging) {
            // hanging 状态的事务暂时不处理
            return
        }

        if (txStatus === TXStatus.TXSuccessful) {
            const jobs = []
            for (const component of this.getComponents()) {
                jobs.push((async () => {
                    await component.confirm();
                })())
            }

            await Promise.all(jobs);
            await this.txStore.TXSubmit(transaction.txID, true)
        } else {
            const jobs = []
            for (const component of this.getComponents()) {
                jobs.push((async () => {
                    await component.cancel();
                })())
            }

            await Promise.all(jobs);
            await this.txStore.TXSubmit(transaction.txID, false)
        }
    }

    // 获取事务的状态
    getStatus(transaction: Transaction): TXStatus {
        // 1 如果事务超时了，都还未被置为成功，直接置为失败
        // 2 如果所有的 try 请求都成功了,—> successful
        // 3 如果有一个 try 请求失败,—> failure

        for (const transactionElement of this.getComponents()) {
            if (transaction.component_try_statuses[transactionElement.id].tryStatus === ComponentTryStatus.TryFailure) {
                return TXStatus.TXFailure
            }
        }

        return TXStatus.TXSuccessful
    }

    stop() {
        this.stopFlag = true
    }
}
