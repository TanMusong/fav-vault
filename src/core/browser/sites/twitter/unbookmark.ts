import type { Page } from 'puppeteer-core';

let cachedQueryId: string | null = null;

async function extractQueryId(page: Page, detailUrl: string): Promise<string | null> {
	if (cachedQueryId) { console.log('[twitter] using cached queryId:', cachedQueryId); return cachedQueryId; }

	const queryId = await new Promise<string | null>((resolve) => {
		let found: string | null = null;

		const handler = async (res: import('puppeteer-core').HTTPResponse) => {
			const url = res.url();
			if (!url.includes('twimg.com') || !url.includes('main.') || !url.endsWith('.js')) return;
			try {
				const text = await res.text();
				const match = text.match(/queryId\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*operationName\s*:\s*"DeleteBookmark"/);
				if (match && !found) { found = match[1]; console.log('[twitter] queryId found in:', url.slice(-60)); }
			} catch (_e) { /* */ }
		};

		page.on('response', handler);

		page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => {
			setTimeout(() => {
				page.off('response', handler);
				if (found) cachedQueryId = found;
				console.log('[twitter] extractQueryId result:', found);
				resolve(found);
			}, 10000);
		}).catch(() => {
			page.off('response', handler);
			console.log('[twitter] extractQueryId: navigation failed');
			resolve(found);
		});
	});

	return queryId;
}

export async function unbookmarkPage(page: Page, detailUrl: string): Promise<boolean> {
	const tweetId = detailUrl.match(/\/status\/(\d+)/)?.[1];
	if (!tweetId) return false;

	const queryId = await extractQueryId(page, detailUrl);
	console.log(`[twitter] queryId: ${queryId}`);
	if (!queryId) return false;

	for (let retry = 0; retry < 3; retry++) {
		await new Promise<void>(r => setTimeout(r, 1000));
		try {
			const result = await page.evaluate(async ({ tweetId, queryId }) => {
				const ct0 = document.cookie.match(/ct0=([^;]+)/)?.[1] || '';
				if (!ct0) return { ok: false, text: 'no ct0' };

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
				return { ok: resp.status === 200 && text.includes('tweet_bookmark_delete'), status: resp.status, text };
			}, { tweetId, queryId });

			console.log(`[twitter] unbookmark response: ${result.status} ${result.text?.slice(0, 200)}`);
			if (result.ok) return true;
			cachedQueryId = null;
		} catch (_e) { /* */ }
	}
	return false;
}
