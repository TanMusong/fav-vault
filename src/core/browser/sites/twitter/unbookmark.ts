import type { Page } from 'puppeteer-core';

let cachedQueryId: string | null = null;

async function extractQueryId(page: Page, detailUrl: string): Promise<{ queryId: string | null; reason?: string }> {
	if (cachedQueryId) return { queryId: cachedQueryId };

	const queryId = await new Promise<string | null>((resolve) => {
		let found: string | null = null;

		const handler = async (res: import('puppeteer-core').HTTPResponse) => {
			const url = res.url();
			if (!url.includes('twimg.com') || !url.includes('main.') || !url.endsWith('.js')) return;
			try {
				const text = await res.text();
				const match = text.match(/queryId\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*operationName\s*:\s*"DeleteBookmark"/);
				if (match && !found) { found = match[1]; }
			} catch (_e) { /* */ }
		};

		page.on('response', handler);

		page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => {
			setTimeout(() => {
				page.off('response', handler);
				if (found) cachedQueryId = found;
				resolve(found);
			}, 10000);
		}).catch(() => {
			page.off('response', handler);
			resolve(found);
		});
	});

	return { queryId, reason: queryId ? undefined : 'failed to extract queryId from page' };
}

export interface UnbookmarkResult {
	ok: boolean;
	reason?: string;
	detail?: string;
}

export async function unbookmarkPage(page: Page, detailUrl: string): Promise<UnbookmarkResult> {
	const tweetId = detailUrl.match(/\/status\/(\d+)/)?.[1];
	if (!tweetId) return { ok: false, reason: 'invalid tweet URL', detail: detailUrl };

	const { queryId, reason: queryIdReason } = await extractQueryId(page, detailUrl);
	if (!queryId) return { ok: false, reason: queryIdReason || 'queryId is null' };

	// Navigate to x.com to ensure cookies are accessible
	await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
	await new Promise<void>(r => setTimeout(r, 1000));

	// Read ct0 via Puppeteer API instead of document.cookie (avoids SecurityError)
	const allCookies = await page.cookies('https://x.com').catch(() => []);
	const ct0 = allCookies.find(c => c.name === 'ct0')?.value || '';
	if (!ct0) return { ok: false, reason: 'missing_csrf_token', detail: 'ct0 cookie not found on x.com' };

	for (let retry = 0; retry < 3; retry++) {
		await new Promise<void>(r => setTimeout(r, 1000));
		try {
			const result = await page.evaluate(async ({ tweetId, queryId, ct0 }) => {
				const resp = await fetch('/i/api/graphql/' + queryId + '/DeleteBookmark', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-CSRF-Token': ct0,
						'X-Twitter-Active-User': 'yes',
						'X-Twitter-Client-Language': 'en',
						'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
					},
					body: JSON.stringify({
						variables: { tweet_id: tweetId },
						features: {
							rweb_tipjar_consumption_enabled: true,
							responsive_web_graphql_exclude_directive_enabled: true,
							verified_phone_label_enabled: false,
							responsive_web_graphql_timeline_navigation_enabled: true,
							responsive_web_graphql_skip_user_profile_image_extensions_enabled: false
						}
					})
				});
				const text = await resp.text();
				const ok = resp.status === 200 && text.includes('tweet_bookmark_delete');
				let reason: string | undefined;
				if (!ok) {
					if (resp.status === 403) reason = 'forbidden (CSRF or auth issue)';
					else if (resp.status === 404) reason = 'not found (tweet may not exist)';
					else if (resp.status === 429) reason = 'rate limited';
					else if (resp.status >= 500) reason = 'server error';
					else reason = `unexpected status ${resp.status}`;
				}
				return { ok, status: resp.status, text: text.slice(0, 500), reason };
			}, { tweetId, queryId, ct0 });

			if (result.ok) return { ok: true };
			cachedQueryId = null;
			if (retry === 2) {
				return { ok: false, reason: result.reason || 'unknown', detail: `status=${result.status} body=${result.text?.slice(0, 300)}` };
			}
		} catch (err) {
			if (retry === 2) {
				return { ok: false, reason: 'exception', detail: (err as Error).message };
			}
		}
	}
	return { ok: false, reason: 'exhausted retries' };
}
