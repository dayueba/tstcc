class TccDashboard {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectInterval = 5000;
        
        this.init();
    }

    init() {
        this.connectWebSocket();
        this.loadInitialData();
        
        // 定期刷新数据
        setInterval(() => {
            if (!this.isConnected) {
                this.loadInitialData();
            }
        }, 10000);
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket 连接建立');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionStatus(true);
                
                // 订阅所有更新
                this.ws.send(JSON.stringify({
                    type: 'subscribe',
                    topics: ['all']
                }));
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleWebSocketMessage(message);
                } catch (error) {
                    console.error('解析 WebSocket 消息失败:', error);
                }
            };

            this.ws.onclose = () => {
                console.log('WebSocket 连接关闭');
                this.isConnected = false;
                this.updateConnectionStatus(false);
                this.scheduleReconnect();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket 错误:', error);
                this.isConnected = false;
                this.updateConnectionStatus(false);
            };

        } catch (error) {
            console.error('创建 WebSocket 连接失败:', error);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`${this.reconnectInterval / 1000} 秒后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            
            setTimeout(() => {
                this.connectWebSocket();
            }, this.reconnectInterval);
        } else {
            console.error('WebSocket 重连失败，已达到最大重试次数');
            this.updateConnectionStatus(false, '连接失败');
        }
    }

    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'status_update':
                this.updateDashboard(message.data);
                break;
            case 'log_update':
                this.addLogEntry(message.data);
                break;
            case 'subscription_confirmed':
                console.log('WebSocket 订阅确认:', message.data);
                break;
            default:
                console.log('未知 WebSocket 消息类型:', message.type);
        }
    }

    async loadInitialData() {
        try {
            // 加载健康状态
            const healthResponse = await fetch('/api/v1/health');
            const healthData = await healthResponse.json();
            
            if (healthData.success) {
                this.updateDashboard(healthData.data);
            }

            // 加载指标
            const metricsResponse = await fetch('/api/v1/metrics');
            const metricsData = await metricsResponse.json();
            
            if (metricsData.success) {
                this.updateMetrics(metricsData.data);
            }

            // 加载组件列表
            const componentsResponse = await fetch('/api/v1/components');
            const componentsData = await componentsResponse.json();
            
            if (componentsData.success) {
                this.updateComponentsList(componentsData.data);
            }

            // 加载日志
            const logsResponse = await fetch('/api/v1/logs?limit=50');
            const logsData = await logsResponse.json();
            
            if (logsData.success) {
                this.updateLogs(logsData.data);
            }

        } catch (error) {
            console.error('加载初始数据失败:', error);
        }
    }

    updateConnectionStatus(connected, message = '') {
        const statusElement = document.getElementById('connectionStatus');
        
        if (connected) {
            statusElement.textContent = '已连接';
            statusElement.className = 'connection-status connected';
        } else {
            statusElement.textContent = message || '连接断开';
            statusElement.className = 'connection-status disconnected';
        }
    }

    updateDashboard(data) {
        // 更新系统状态
        if (data.health) {
            const systemStatus = document.getElementById('systemStatus');
            if (data.health.healthy) {
                systemStatus.innerHTML = '<span class="health-indicator health-healthy"></span>运行中';
            } else {
                systemStatus.innerHTML = '<span class="health-indicator health-unhealthy"></span>异常';
            }

            document.getElementById('componentCount').textContent = data.health.componentsCount || 0;
        }

        // 更新运行时间
        if (data.server && data.server.uptime) {
            document.getElementById('uptime').textContent = this.formatUptime(data.server.uptime);
        }

        // 更新指标
        if (data.metrics) {
            this.updateMetrics(data.metrics);
        }

        // 更新组件列表
        if (data.components) {
            this.updateComponentsList(data.components);
        }
    }

    updateMetrics(metrics) {
        const total = metrics.transactionStarted || 0;
        const success = metrics.transactionSuccess || 0;
        const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0';

        document.getElementById('totalTransactions').textContent = total;
        document.getElementById('successRate').textContent = successRate + '%';
        document.getElementById('avgDuration').textContent = Math.round(metrics.averageTransactionDuration || 0) + 'ms';
        document.getElementById('hangingTransactions').textContent = metrics.hangingTransactionCount || 0;
    }

    updateComponentsList(components) {
        const container = document.getElementById('componentsList');
        
        if (!components || components.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #6c757d; padding: 2rem;">暂无注册组件</div>';
            return;
        }

        const componentsHtml = components.map(component => `
            <div class="component-item">
                <div class="component-info">
                    <div class="component-id">${component.id}</div>
                    <div class="component-endpoint">
                        Try: ${component.endpoint.tryUrl}<br>
                        Confirm: ${component.endpoint.confirmUrl}<br>
                        Cancel: ${component.endpoint.cancelUrl}
                    </div>
                </div>
                <div>
                    <span class="health-indicator health-healthy"></span>
                    <button class="btn btn-danger" onclick="unregisterComponent('${component.id}')" style="margin-left: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.75rem;">
                        删除
                    </button>
                </div>
            </div>
        `).join('');

        container.innerHTML = componentsHtml;
    }

    updateLogs(logs) {
        const container = document.getElementById('logContainer');
        container.innerHTML = '';
        
        logs.forEach(log => {
            this.addLogEntry(log, false);
        });
        
        container.scrollTop = container.scrollHeight;
    }

    addLogEntry(logData, autoScroll = true) {
        const container = document.getElementById('logContainer');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        
        const timestamp = new Date(logData.timestamp || Date.now()).toLocaleTimeString();
        const level = logData.level || 'info';
        const message = logData.message || JSON.stringify(logData);
        
        logEntry.innerHTML = `
            <span class="log-timestamp">[${timestamp}]</span>
            <span class="log-level-${level}">[${level.toUpperCase()}]</span>
            <span>${this.escapeHtml(message)}</span>
        `;
        
        container.appendChild(logEntry);
        
        // 限制日志数量
        while (container.children.length > 1000) {
            container.removeChild(container.firstChild);
        }
        
        if (autoScroll) {
            container.scrollTop = container.scrollHeight;
        }
    }

    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (days > 0) {
            return `${days}天 ${hours}时 ${minutes}分`;
        } else if (hours > 0) {
            return `${hours}时 ${minutes}分 ${secs}秒`;
        } else if (minutes > 0) {
            return `${minutes}分 ${secs}秒`;
        } else {
            return `${secs}秒`;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async apiCall(method, url, data = null) {
        try {
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            if (data) {
                options.body = JSON.stringify(data);
            }

            const response = await fetch(url, options);
            return await response.json();

        } catch (error) {
            console.error('API 调用失败:', error);
            throw error;
        }
    }
}

// 全局函数
let dashboard = null;

document.addEventListener('DOMContentLoaded', () => {
    dashboard = new TccDashboard();
});

function showRegisterModal() {
    document.getElementById('registerModal').style.display = 'block';
}

function hideRegisterModal() {
    document.getElementById('registerModal').style.display = 'none';
    document.getElementById('registerForm').reset();
}

async function registerComponent(event) {
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const componentData = {
        componentId: formData.get('componentId'),
        endpoint: {
            tryUrl: formData.get('tryUrl'),
            confirmUrl: formData.get('confirmUrl'),
            cancelUrl: formData.get('cancelUrl'),
            timeout: parseInt(formData.get('timeout')) || 30000
        }
    };

    try {
        const result = await dashboard.apiCall('POST', '/api/v1/components/register', componentData);
        
        if (result.success) {
            alert('组件注册成功！');
            hideRegisterModal();
            dashboard.loadInitialData(); // 刷新数据
        } else {
            alert('组件注册失败: ' + result.message);
        }
    } catch (error) {
        alert('组件注册失败: ' + error.message);
    }
}

async function unregisterComponent(componentId) {
    if (!confirm(`确定要删除组件 "${componentId}" 吗？`)) {
        return;
    }

    try {
        const result = await dashboard.apiCall('DELETE', `/api/v1/components/${componentId}`);
        
        if (result.success) {
            alert('组件删除成功！');
            dashboard.loadInitialData(); // 刷新数据
        } else {
            alert('组件删除失败: ' + result.message);
        }
    } catch (error) {
        alert('组件删除失败: ' + error.message);
    }
}

async function startTransaction() {
    try {
        const result = await dashboard.apiCall('POST', '/api/v1/transactions/start', {
            metadata: {
                source: 'dashboard',
                timestamp: new Date().toISOString()
            }
        });
        
        if (result.success) {
            alert(`事务启动成功！\n事务ID: ${result.txId}\n耗时: ${result.duration}ms`);
        } else {
            alert('事务启动失败: ' + result.message);
        }
    } catch (error) {
        alert('事务启动失败: ' + error.message);
    }
}

function clearLogs() {
    document.getElementById('logContainer').innerHTML = '';
}

// 点击模态框外部关闭
window.onclick = function(event) {
    const modal = document.getElementById('registerModal');
    if (event.target === modal) {
        hideRegisterModal();
    }
}
