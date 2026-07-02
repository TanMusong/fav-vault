import type { Page } from 'puppeteer-core';

export async function unfavoritePage(page: Page, detailUrl: string): Promise<void> {
	for (let retry = 0; retry < 3; retry++) {
		await new Promise<void>(r => setTimeout(r, 3000));
		try {
			await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
			const beforeState = await page.evaluate(() => {
				const btn = document.querySelector('[data-e2e="video-player-collect"]');
				return btn?.getAttribute('data-e2e-state') || 'none';
			});
			if (beforeState === 'none') continue;
			if (beforeState !== 'video-player-is-collected') return;
			await page.evaluate(() => {
				const btn = document.querySelector('[data-e2e="video-player-collect"]') as HTMLElement | null;
				if (btn) btn.click();
			});
			for (let i = 0; i < 10; i++) {
				await new Promise<void>(r => setTimeout(r, 1000));
				const afterState = await page.evaluate(() => {
					const btn = document.querySelector('[data-e2e="video-player-collect"]');
					return btn?.getAttribute('data-e2e-state') || 'none';
				});
				if (afterState === 'video-player-no-collect') return;
				if (afterState === 'none') break;
			}
		} catch (e) {
		}
	}
	console.error('[douyin] unfavorite error: failed to unfavorite after 10 seconds');
}
