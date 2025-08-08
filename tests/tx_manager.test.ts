import { TxManager } from '../src/tx_manager';
import { TxConfig } from '../src/tx_config';
import { TccComponent } from '../src/tccComponent';
import { TxStore } from '../src/tx_store';
import { Transaction } from '../src/model';
import { ComponentTryStatus, TXStatus } from '../src/enums';
import { DuplicateComponentError, TransactionTimeoutError } from '../src/errors';

// Mock TxStore 实现
class MockTxStore implements TxStore {
    private transactions: Map<number, Transaction> = new Map();
    private nextId = 1;
    private lockAcquired = false;

    async CreateTx(components: TccComponent[]): Promise<number> {
        const txId = this.nextId++;
        const componentStatuses: any = {};
        
        components.forEach(component => {
            componentStatuses[component.id] = {
                componentId: component.id,
                tryStatus: ComponentTryStatus.TryHanging
            };
        });

        const transaction: Transaction = {
            id: txId,
            status: TXStatus.TXHanging,
            component_try_statuses: componentStatuses,
            created_at: new Date().toISOString()
        };

        this.transactions.set(txId, transaction);
        return txId;
    }

    async TXUpdateComponentStatus(txID: number, componentID: string, accept: boolean): Promise<void> {
        const tx = this.transactions.get(txID);
        if (!tx) throw new Error('Transaction not found');
        
        tx.component_try_statuses[componentID].tryStatus = 
            accept ? ComponentTryStatus.TrySuccessful : ComponentTryStatus.TryFailure;
    }

    async TXSubmit(txID: number, success: boolean): Promise<void> {
        const tx = this.transactions.get(txID);
        if (!tx) throw new Error('Transaction not found');
        
        tx.status = success ? TXStatus.TXSuccessful : TXStatus.TXFailure;
    }

    async GetHangingTXs(): Promise<Transaction[]> {
        return Array.from(this.transactions.values())
            .filter(tx => tx.status === TXStatus.TXHanging);
    }

    async GetTX(txID: number): Promise<Transaction> {
        const tx = this.transactions.get(txID);
        if (!tx) throw new Error('Transaction not found');
        return tx;
    }

    async Lock(expireDuration: number): Promise<void> {
        if (this.lockAcquired) {
            throw new Error('Lock already acquired');
        }
        this.lockAcquired = true;
    }

    async Unlock(): Promise<void> {
        this.lockAcquired = false;
    }
}

// Mock TccComponent 实现
class MockTccComponent implements TccComponent {
    id: string;
    private shouldTryFail: boolean = false;
    private shouldConfirmFail: boolean = false;
    private shouldCancelFail: boolean = false;
    private tryDelay: number = 0;

    constructor(id: string) {
        this.id = id;
    }

    setTryFail(fail: boolean) {
        this.shouldTryFail = fail;
    }

    setConfirmFail(fail: boolean) {
        this.shouldConfirmFail = fail;
    }

    setCancelFail(fail: boolean) {
        this.shouldCancelFail = fail;
    }

    setTryDelay(delay: number) {
        this.tryDelay = delay;
    }

    async try(): Promise<void> {
        if (this.tryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, this.tryDelay));
        }
        
        if (this.shouldTryFail) {
            throw new Error(`Component ${this.id} try failed`);
        }
    }

    async confirm(): Promise<void> {
        if (this.shouldConfirmFail) {
            throw new Error(`Component ${this.id} confirm failed`);
        }
    }

    async cancel(): Promise<void> {
        if (this.shouldCancelFail) {
            throw new Error(`Component ${this.id} cancel failed`);
        }
    }
}

describe('TxManager', () => {
    let txManager: TxManager;
    let mockStore: MockTxStore;
    let config: TxConfig;

    beforeEach(() => {
        mockStore = new MockTxStore();
        config = new TxConfig(5000, 1000, false); // 关闭监控
        txManager = new TxManager(mockStore, config);
    });

    afterEach(async () => {
        await txManager.stop();
    });

    describe('组件注册', () => {
        it('应该能够注册组件', () => {
            const component = new MockTccComponent('test1');
            
            expect(() => txManager.register(component)).not.toThrow();
            expect(txManager.getComponents()).toHaveLength(1);
            expect(txManager.getComponents()[0].id).toBe('test1');
        });

        it('应该阻止重复注册组件', () => {
            const component1 = new MockTccComponent('test1');
            const component2 = new MockTccComponent('test1');
            
            txManager.register(component1);
            
            expect(() => txManager.register(component2))
                .toThrow(DuplicateComponentError);
        });
    });

    describe('事务执行', () => {
        it('应该成功执行所有组件都成功的事务', async () => {
            const component1 = new MockTccComponent('comp1');
            const component2 = new MockTccComponent('comp2');
            
            txManager.register(component1);
            txManager.register(component2);

            const result = await txManager.startTransaction();

            expect(result.success).toBe(true);
            expect(result.txId).toBeGreaterThan(0);
        });

        it('应该处理组件 try 失败的情况', async () => {
            const component1 = new MockTccComponent('comp1');
            const component2 = new MockTccComponent('comp2');
            
            component1.setTryFail(true); // 设置组件1失败
            
            txManager.register(component1);
            txManager.register(component2);

            const result = await txManager.startTransaction();

            expect(result.success).toBe(false);
            expect(result.txId).toBeGreaterThan(0);
        });

        it('应该处理事务超时', async () => {
            const shortTimeoutConfig = new TxConfig(100, 1000, false); // 100ms 超时
            const shortTimeoutManager = new TxManager(mockStore, shortTimeoutConfig);
            
            const component1 = new MockTccComponent('comp1');
            component1.setTryDelay(200); // 延迟200ms，超过超时时间
            
            shortTimeoutManager.register(component1);

            const result = await shortTimeoutManager.startTransaction();

            expect(result.success).toBe(false);
            
            await shortTimeoutManager.stop();
        });

        it('应该拒绝没有组件的事务', async () => {
            await expect(txManager.startTransaction())
                .rejects
                .toThrow('没有注册的组件，无法启动事务');
        });
    });

    describe('状态判定', () => {
        it('应该正确判定成功状态', () => {
            const transaction: Transaction = {
                id: 1,
                status: TXStatus.TXHanging,
                component_try_statuses: {
                    'comp1': { componentId: 'comp1', tryStatus: ComponentTryStatus.TrySuccessful },
                    'comp2': { componentId: 'comp2', tryStatus: ComponentTryStatus.TrySuccessful }
                },
                created_at: new Date().toISOString()
            };

            const component1 = new MockTccComponent('comp1');
            const component2 = new MockTccComponent('comp2');
            txManager.register(component1);
            txManager.register(component2);

            const status = txManager.getStatus(transaction);
            expect(status).toBe(TXStatus.TXSuccessful);
        });

        it('应该正确判定失败状态', () => {
            const transaction: Transaction = {
                id: 1,
                status: TXStatus.TXHanging,
                component_try_statuses: {
                    'comp1': { componentId: 'comp1', tryStatus: ComponentTryStatus.TrySuccessful },
                    'comp2': { componentId: 'comp2', tryStatus: ComponentTryStatus.TryFailure }
                },
                created_at: new Date().toISOString()
            };

            const component1 = new MockTccComponent('comp1');
            const component2 = new MockTccComponent('comp2');
            txManager.register(component1);
            txManager.register(component2);

            const status = txManager.getStatus(transaction);
            expect(status).toBe(TXStatus.TXFailure);
        });

        it('应该正确判定挂起状态', () => {
            const transaction: Transaction = {
                id: 1,
                status: TXStatus.TXHanging,
                component_try_statuses: {
                    'comp1': { componentId: 'comp1', tryStatus: ComponentTryStatus.TrySuccessful },
                    'comp2': { componentId: 'comp2', tryStatus: ComponentTryStatus.TryHanging }
                },
                created_at: new Date().toISOString()
            };

            const component1 = new MockTccComponent('comp1');
            const component2 = new MockTccComponent('comp2');
            txManager.register(component1);
            txManager.register(component2);

            const status = txManager.getStatus(transaction);
            expect(status).toBe(TXStatus.TXHanging);
        });
    });

    describe('健康检查', () => {
        it('应该返回健康状态', async () => {
            const component = new MockTccComponent('test1');
            txManager.register(component);

            const health = await txManager.getHealthStatus();

            expect(health.healthy).toBe(true);
            expect(health.instanceId).toBeDefined();
            expect(health.componentsCount).toBe(1);
            expect(health.monitorEnabled).toBe(false);
            expect(health.metrics).toBeDefined();
        });
    });
});
