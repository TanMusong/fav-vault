import { EventEmitter } from 'events';
import type { TaskResult, DownloadData, DownloadFile } from '../types';

class EventHub extends EventEmitter {
  private static instance: EventHub;

  private constructor() {
    super();
    this.setMaxListeners(50);
  }

  static getInstance(): EventHub {
    if (!EventHub.instance) {
      EventHub.instance = new EventHub();
    }
    return EventHub.instance;
  }

  public emitTaskStarted(taskId: string, taskName: string): void {
    this.emit('task:started', { taskId, taskName, timestamp: new Date().toISOString() });
  }

  public emitTaskCompleted(taskId: string, result: TaskResult): void {
    this.emit('task:completed', { taskId, result, timestamp: new Date().toISOString() });
  }

  public emitTaskFailed(taskId: string, error: string): void {
    this.emit('task:failed', { taskId, error, timestamp: new Date().toISOString() });
  }

  public emitDownloadAdded(taskId: string, download: DownloadData): void {
    this.emit('download:added', { taskId, ...download });
  }

  public emitDownloadProgress(taskId: string, postId: string, files: DownloadFile[], state?: number): void {
    this.emit('download:progress', { taskId, postId, files, state });
  }

  public emitSchedulerUpdated(taskId: string, nextRun: string): void {
    this.emit('scheduler:updated', { taskId, nextRun, timestamp: new Date().toISOString() });
  }

  public emitTaskPaused(taskId: string, paused: boolean): void {
    this.emit('task:paused', { taskId, paused, timestamp: new Date().toISOString() });
  }
}

export const events = EventHub.getInstance();
