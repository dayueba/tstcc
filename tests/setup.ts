// Jest 测试设置文件
import { logger } from '../src/logger';

// 在测试期间禁用日志输出
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// 设置测试超时
jest.setTimeout(30000);
