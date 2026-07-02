export interface Executable {
	execute(): Promise<void>;
}

export async function runPool(items: Executable[], concurrency: number): Promise<void> {
	let idx = 0;
	const running = new Set<Promise<void>>();
	while (idx < items.length || running.size > 0) {
		while (running.size < concurrency && idx < items.length) {
			const item = items[idx++];
			const p = item.execute().then(() => { running.delete(p); });
			running.add(p);
		}
		if (running.size > 0) await Promise.race(running);
	}
}
