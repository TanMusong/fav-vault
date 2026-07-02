import * as store from '../db/store';
import { runTask } from '../browser/runner';
import type { Task } from '../../types';
import { events } from '../events';

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function msToNext(intervalMs: number, nextRun: string | null): number {
	if (!nextRun) return intervalMs;
	const remaining = new Date(nextRun).getTime() - Date.now();
	if (remaining < 0) return intervalMs;
	return remaining;
}

function scheduleTask(task: Task, immediate?: boolean): void {
	clearTask(task.id);

	if (task.paused) return;

	const intervalMs = (task.interval || 1800) * 1000;

	async function tick(): Promise<void> {
		const current = store.getTask(task.id);
		if (!current || current.paused) return;
		console.log(`[scheduler] Running task: ${current.name} (${current.id})`);
		try {
			await runTask(current.id);
		} catch (err) {
			console.error(`[scheduler] Task ${current.id} failed:`, (err as Error).message);
			store.addLog(current.id, 'error', `Scheduler run failed: ${(err as Error).message}`);
		}
		const updated = store.getTask(current.id);
		if (updated && !updated.paused) {
			const nextRun = new Date(Date.now() + updated.interval * 1000).toISOString();
			const timer = setTimeout(tick, updated.interval * 1000);
			timers.set(current.id, timer);
			store.setTaskRunState(current.id, { nextRun });
			events.emitSchedulerUpdated(current.id, nextRun);
		}
	}

	const delay = immediate ? 0 : msToNext(intervalMs, task.next_run);
	const timer = setTimeout(tick, delay);
	timers.set(task.id, timer);
	const nextRun = new Date(Date.now() + delay).toISOString();
	store.setTaskRunState(task.id, { nextRun });
	events.emitSchedulerUpdated(task.id, nextRun);
	console.log(`[scheduler] Task "${task.name}" scheduled in ${Math.round(delay / 1000)}s`);
}

function clearTask(taskId: string): void {
	if (timers.has(taskId)) {
		clearTimeout(timers.get(taskId)!);
		timers.delete(taskId);
	}
}

function rescheduleTask(taskId: string, immediate?: boolean): void {
	const task = store.getTask(taskId);
	if (task) scheduleTask(task, immediate);
}

function startAll(): void {
	const tasks = store.getTasks();
	for (const task of tasks) {
		if (!task.paused) scheduleTask(task);
	}
	console.log(`[scheduler] Started ${tasks.filter(t => !t.paused).length} tasks`);
}

function stopAll(): void {
	for (const [id] of timers) clearTask(id);
	timers.clear();
}

export { scheduleTask, clearTask, rescheduleTask, startAll, stopAll };
