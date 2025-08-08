import axios, { AxiosInstance } from 'axios';
import { TccComponent } from './tccComponent';
import { logger } from './logger';
import { RetryableError } from './retry';

export interface ComponentEndpoint {
    tryUrl: string;
    confirmUrl: string;
    cancelUrl: string;
    timeout?: number;
    headers?: Record<string, string>;
}

export interface ComponentRegistrationRequest {
    componentId: string;
    endpoint: ComponentEndpoint;
    metadata?: Record<string, any>;
}

export interface ComponentRegistrationResponse {
    success: boolean;
    message: string;
    registrationId?: string;
}

export class NetworkTccComponent implements TccComponent {
    id: string;
    private endpoint: ComponentEndpoint;
    private axiosInstance: AxiosInstance;
    private metadata: Record<string, any>;

    constructor(id: string, endpoint: ComponentEndpoint, metadata: Record<string, any> = {}) {
        this.id = id;
        this.endpoint = endpoint;
        this.metadata = metadata;

        // 创建 axios 实例
        this.axiosInstance = axios.create({
            timeout: endpoint.timeout || 30000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'TCC-Coordinator/1.0',
                ...endpoint.headers
            }
        });

        // 添加请求拦截器
        this.axiosInstance.interceptors.request.use(
            (config) => {
                logger.debug('发送 HTTP 请求', {
                    componentId: this.id,
                    method: config.method,
                    url: config.url,
                    headers: config.headers
                });
                return config;
            },
            (error) => {
                logger.error('HTTP 请求拦截器错误', error, { componentId: this.id });
                return Promise.reject(error);
            }
        );

        // 添加响应拦截器
        this.axiosInstance.interceptors.response.use(
            (response) => {
                logger.debug('收到 HTTP 响应', {
                    componentId: this.id,
                    status: response.status,
                    url: response.config.url
                });
                return response;
            },
            (error) => {
                logger.error('HTTP 响应错误', error, {
                    componentId: this.id,
                    url: error.config?.url,
                    status: error.response?.status
                });
                return Promise.reject(error);
            }
        );
    }

    async try(): Promise<void> {
        try {
            logger.info('执行网络组件 Try 阶段', { componentId: this.id, url: this.endpoint.tryUrl });
            
            const response = await this.axiosInstance.post(this.endpoint.tryUrl, {
                componentId: this.id,
                phase: 'try',
                metadata: this.metadata,
                timestamp: new Date().toISOString()
            });

            if (response.status !== 200 || !response.data?.success) {
                throw new RetryableError(`Try 阶段失败: ${response.data?.message || '未知错误'}`);
            }

            logger.info('网络组件 Try 阶段成功', { componentId: this.id });

        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || (error.response?.status && error.response.status >= 500)) {
                    throw new RetryableError(`网络组件 Try 阶段网络错误: ${error.message}`, error);
                }
            }
            
            throw error;
        }
    }

    async confirm(): Promise<void> {
        try {
            logger.info('执行网络组件 Confirm 阶段', { componentId: this.id, url: this.endpoint.confirmUrl });
            
            const response = await this.axiosInstance.post(this.endpoint.confirmUrl, {
                componentId: this.id,
                phase: 'confirm',
                metadata: this.metadata,
                timestamp: new Date().toISOString()
            });

            if (response.status !== 200 || !response.data?.success) {
                throw new RetryableError(`Confirm 阶段失败: ${response.data?.message || '未知错误'}`);
            }

            logger.info('网络组件 Confirm 阶段成功', { componentId: this.id });

        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || (error.response?.status && error.response.status >= 500)) {
                    throw new RetryableError(`网络组件 Confirm 阶段网络错误: ${error.message}`, error);
                }
            }
            
            throw error;
        }
    }

    async cancel(): Promise<void> {
        try {
            logger.info('执行网络组件 Cancel 阶段', { componentId: this.id, url: this.endpoint.cancelUrl });
            
            const response = await this.axiosInstance.post(this.endpoint.cancelUrl, {
                componentId: this.id,
                phase: 'cancel',
                metadata: this.metadata,
                timestamp: new Date().toISOString()
            });

            if (response.status !== 200 || !response.data?.success) {
                // Cancel 阶段即使失败也要记录警告，不抛出异常
                logger.warn('网络组件 Cancel 阶段失败', {
                    componentId: this.id,
                    message: response.data?.message || '未知错误'
                });
                return;
            }

            logger.info('网络组件 Cancel 阶段成功', { componentId: this.id });

        } catch (error) {
            // Cancel 阶段的网络错误也只记录警告
            logger.warn('网络组件 Cancel 阶段网络错误', {
                componentId: this.id,
                error: (error as Error).message
            });
        }
    }

    // 健康检查
    async healthCheck(): Promise<boolean> {
        try {
            // 尝试访问 try 端点进行健康检查
            const healthUrl = this.endpoint.tryUrl.replace(/\/try$/, '/health');
            const response = await this.axiosInstance.get(healthUrl, { timeout: 5000 });
            
            return response.status === 200 && response.data?.healthy === true;
        } catch (error) {
            logger.warn('网络组件健康检查失败', {
                componentId: this.id,
                error: (error as Error).message
            });
            return false;
        }
    }

    // 获取组件信息
    getInfo() {
        return {
            id: this.id,
            endpoint: this.endpoint,
            metadata: this.metadata,
            type: 'network'
        };
    }
}
