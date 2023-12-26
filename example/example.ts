import {TxManager} from "../src/tx_manager";
import Redis from "ioredis";
import {RedisComponent} from "../src/component/redis.component";
import {TypeormStore} from "../src/tx_store/typeorm.store";
import {TxConfig} from "../src/tx_config";

import * as mysql from 'mysql2/promise';
import {TccComponent} from "../src/tccComponent";
import {TxStore} from "../src/tx_store";
import {ComponentTryStatus, TXStatus} from "../src/enums";
import { Transaction } from "../src/model";
import {afterEach} from "node:test";
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
    GetHangingTXs(): Promise<Transaction[]> {
        throw new Error("Method not implemented.");
    }
    async GetTX(txID: number): Promise<Transaction> {
        const [res] = await this.pool.query(`select * from tx_record where id = ${txID}`)
        if ((res as Transaction[]).length === 0) {
            throw new Error('未找到事务记录');
        }
        const transaction = (res as Transaction[])[0];
        // transaction.components = (new Map(JSON.parse(transaction.components as any))) as any;
        return transaction

    }
    Lock(expireDuration: number): Promise<void> {
        throw new Error("Method not implemented.");
    }
    Unlock(): Promise<void> {
        throw new Error("Method not implemented.");
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

    const componentA = new MockComponent(
        'A', pool, newUpdateTradingSql('A', -100), newUpdateBalanceSql('A', -100), newUpdateBalanceSql('A', 100)
    )
    const componentB = new MockComponent(
        'B', pool, newUpdateTradingSql('B', 100), newUpdateBalanceSql('B', 100), newUpdateBalanceSql('B', -100)
    )

    const txStore = new MockTxStore(pool);
    const config = new TxConfig(5000, 1000)
    const txManager = new TxManager(txStore, config)

    try {
        txManager.register(componentA)
        txManager.register(componentB)

        await txManager.startTransaction();
        console.log('success')
    } catch (e) {
        console.log('fail')
        console.error(e)
    } finally {
        txManager.stop()
    }


}

main()
