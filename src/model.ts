import { ComponentTryStatus, TXStatus } from "./enums";

export type ComponentTryStatusRecord = Record<string, {
    componentId: string;
    tryStatus: ComponentTryStatus;
}>;

// 事务模型（与示例 SQL 中的字段保持一致）
export interface Transaction {
    id: number;
    status: TXStatus;
    component_try_statuses: ComponentTryStatusRecord;
    created_at: string; // 格式：YYYY-MM-DD HH:mm:ss
}
