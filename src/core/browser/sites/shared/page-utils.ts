import type { Page, HTTPResponse } from 'puppeteer-core';

export async function interceptApiResponse(
	page: Page,
	urlPattern: string,
	navigateUrl: string,
	maxWaitMs: number = 30000
): Promise<Record<string, unknown> | null> {
	let captured: Record<string, unknown> | null = null;

	const handler = async (res: HTTPResponse) => {
		if (captured) return;
		const url = res.url();
		if (!url.includes(urlPattern)) return;
		try {
			const text = await res.text();
			let parsed: Record<string, unknown> | null = null;
			try {
				parsed = JSON.parse(text);
			} catch (_e) {
				const match = text.match(/=\s*({.+})\s*;?\s*$/s);
				if (match) {
					try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ }
				}
			}
			if (parsed) captured = parsed;
		} catch (_e) { /* */ }
	};

	page.on('response', handler);
	try {
		await page.goto(navigateUrl, { waitUntil: 'networkidle2', timeout: 60000 });
		for (let i = 0; i < maxWaitMs / 1000 && !captured; i++) {
			await new Promise<void>(r => setTimeout(r, 1000));
		}
		return captured;
	} finally {
		page.off('response', handler);
	}
}

export async function retryEvaluate<T>(
	page: Page,
	evaluator: () => T,
	maxRetries: number = 10,
	delayMs: number = 1000
): Promise<T | null> {
	for (let i = 0; i < maxRetries; i++) {
		try {
			const result = await page.evaluate(evaluator);
			if (result) return result;
		} catch (_e) { /* */ }
		await new Promise<void>(r => setTimeout(r, delayMs));
	}
	return null;
}
