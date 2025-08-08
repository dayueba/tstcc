## API 参考

### 枚举

- `TXStatus`: `hanging | successful | failure`
- `ComponentTryStatus`: `hanging | successful | failure`

### 接口 `TccComponent`

```
id: string
try(): Promise<void>
confirm(): Promise<void>
cancel(): Promise<void>
```

### 接口 `TxStore`

```
CreateTx(components: TccComponent[]): Promise<number>
TXUpdateComponentStatus(txID: number, componentID: string, accept: boolean): Promise<void>
TXSubmit(txID: number, success: boolean): Promise<void>
GetHangingTXs(): Promise<Transaction[]>
GetTX(txID: number): Promise<Transaction>
Lock(expireDuration: number): Promise<void>
Unlock(): Promise<void>
```

### 类 `TxConfig`

```
constructor(timeout: number, monitorInterval: number, enableMonitor = true)
```

### 类 `TxManager`

```
constructor(txStore: TxStore, tsConfig: TxConfig)
register(component: TccComponent)
getComponents(): TccComponent[]
startTransaction(): Promise<void>
advanceTransactionProgress(transaction: Transaction | number): Promise<void>
getStatus(transaction: Transaction): TXStatus
stop(): void
```


