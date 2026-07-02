import type { Page, Browser } from 'puppeteer-core';
import type { CookieField, SiteMeta, Task, TaskResult, DownloadData, DownloadFile } from '../../../types';

export interface TaskContext {
  taskId: string;
  task: Task;
  browser: Browser;
  concurrency: number;
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

  public abstract checkLogin(page: Page): Promise<{ username: string; userId: string }>;

  public abstract executeTask(ctx: TaskContext): Promise<TaskResult>;

  public getCookieField(): CookieField {
    return { label: 'Cookie', placeholder: '从浏览器复制完整 Cookie 字符串', required: true };
  }

  public getCookieDomain(): string {
    return '.douyin.com';
  }
}
