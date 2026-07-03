export interface Executable {
	execute(): Promise<void>;
}

export async function runPool(items: Executable[], concurrency: number): Promise<void> {
	let idx = 0;
	const running = new Set<Promise<void>>();
	const errors: unknown[] = [];
	const limit = Math.max(1, Math.floor(concurrency || 1));
	while (idx < items.length || running.size > 0) {
		while (running.size < limit && idx < items.length) {
			const item = items[idx++];
			const p = item.execute().catch(err => { errors.push(err); }).finally(() => { running.delete(p); });
			running.add(p);
		}
		if (running.size > 0) await Promise.race(running);
	}
	if (errors.length > 0) {
		throw errors[0];
	}
}
