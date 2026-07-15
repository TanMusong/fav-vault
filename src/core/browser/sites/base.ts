import type { Page, Browser } from 'puppeteer-core';
import type { CookieField, SiteMeta, Task, TaskResult, DownloadData, DownloadFile } from '../../../types';

export interface ProxyConfig {
  enabled: boolean;
  type: string;
  host: string;
  port: number;
}

export interface TaskContext {
  taskId: string;
  task: Task;
  browser: Browser;
  concurrency: number;
  timeout: number;
  maxRetries: number;
  proxy: ProxyConfig;
  downloadDir: string;
  addDownload(data: DownloadData): void;
  updateDownload(postId: string, data: { state?: number; stateMessage?: string; files?: DownloadFile[] }): void;
  emitDownloadProgress(postId: string, files: DownloadFile[]): void;
  hasSuccessfulDownload(postId: string): boolean;
  hasPostDownload(postId: string): boolean;
  addLog(level: string, message: string): void;
}

export default abstract class BaseSite {
  public name: string;
  public meta: SiteMeta;
  public enabled: boolean;

  constructor(name: string, meta: SiteMeta) {
    this.name = name;
    this.meta = meta;
    this.enabled = meta.enabled !== false;
  }

  public abstract checkLogin(page: Page, timeout?: number): Promise<{ username: string; userId: string }>;

  public abstract executeTask(ctx: TaskContext): Promise<TaskResult>;

  public getCookieField(): CookieField {
    return { label: 'Cookie', placeholder: 'msg.cookie_placeholder_douyin', required: true };
  }

  public getCookieDomain(): string {
    return '.douyin.com';
  }
}
