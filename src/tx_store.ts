import {TccComponent} from "./tccComponent";
import {Transaction} from "./model";

export interface TxStore {
    // 创建一条事务明细记录
    CreateTx(components: TccComponent[]): Promise<number>
    // 更新事务进度：
    // 规则为：倘若有一个 component try 操作执行失败，则整个事务失败；倘若所有 component try 操作执行成功，则事务成功
    TXUpdateComponentStatus(txID: number, componentID: string, accept: boolean): Promise<void>
    // 提交事务的最终状态
    TXSubmit(txID: number, success: boolean): Promise<void>
    // 获取到所有处于中间态的事务
    GetHangingTXs(): Promise<Transaction[]>
    // 获取指定的一笔事务
    GetTX(txID: number): Promise<Transaction>
    // 锁住事务日志表
    // 单位毫秒
    Lock(expireDuration: number): Promise<void>
    // 解锁事务日志表
    Unlock(): Promise<void>
}

