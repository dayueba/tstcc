import {ComponentTryStatus, TXStatus} from "./enums";

// 事务
export class Transaction {
    // @ts-ignore
    txID: number
    // @ts-ignore
    component_try_statuses: any // todo
    // @ts-ignore
    status: TXStatus
    // @ts-ignore
    createdAt: string

    // constructor(txID: string, components: { tryStatus: ComponentTryStatus, componentID: string }[]) {
    //     this.txID = txID
    //     this.components = components
    //     this.status = TXStatus.TXHanging
    //     this.createdAt = dayjs().format('YYYY-MM-DD HH:mm:ss')
    // }
}
