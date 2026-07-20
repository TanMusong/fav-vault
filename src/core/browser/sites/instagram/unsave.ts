import type { Page } from 'puppeteer-core';

export async function unsavePage(page: Page, detailUrl: string): Promise<boolean> {
	for (let retry = 0; retry < 3; retry++) {
		await new Promise<void>(r => setTimeout(r, 3000));
		try {
			await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });
			await new Promise<void>(r => setTimeout(r, 5000));

			// Check save state
			const state = await page.evaluate(() => {
				const removeSvg = document.querySelector('svg[aria-label="Remove"]');
				const removeBtn = document.querySelector('[aria-label="Remove"]') ||
					document.querySelector('[aria-label="Remove from saved"]') ||
					document.querySelector('[aria-label="Unsave"]');
				const saveSvg = document.querySelector('svg[aria-label="Save"]') ||
					document.querySelector('svg[aria-label="Save to collection"]');

				if (removeSvg || removeBtn) return 'saved';
				if (saveSvg) return 'unsaved';
				return 'unknown';
			});

			if (state === 'unsaved') return true;
			if (state === 'unknown') continue;

			// Click the remove element
			await page.evaluate(() => {
				const el = document.querySelector('svg[aria-label="Remove"]') ||
					document.querySelector('[aria-label="Remove"]') ||
					document.querySelector('[aria-label="Remove from saved"]') ||
					document.querySelector('[aria-label="Unsave"]');
				if (el) {
					el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				}
			});

			await new Promise<void>(r => setTimeout(r, 3000));

			// Verify
			const afterState = await page.evaluate(() => {
				const removeSvg = document.querySelector('svg[aria-label="Remove"]');
				const removeBtn = document.querySelector('[aria-label="Remove"]') ||
					document.querySelector('[aria-label="Remove from saved"]');
				const saveSvg = document.querySelector('svg[aria-label="Save"]') ||
					document.querySelector('svg[aria-label="Save to collection"]');
				if (saveSvg) return 'unsaved';
				if (removeSvg || removeBtn) return 'still_saved';
				return 'unknown';
			});
			// After clicking remove, if buttons disappear or state is unknown, assume success
			if (afterState === 'unsaved' || afterState === 'unknown') return true;
		} catch (_e) { /* retry */ }
	}
	return false;
}
