import puppeteer, { type Browser } from 'puppeteer-core';
import { config } from '../config/manager';

function findChrome(): string {
	if (config.chromePath) return config.chromePath;
	return '';
}

const browsers = new Map<string, Browser>();

export async function getBrowser(taskId: string): Promise<Browser> {
	const key = taskId || '__default__';
	let browser = browsers.get(key);
	if (!browser || !browser.connected) {
		const executablePath = findChrome();
		if (!executablePath) throw new Error('Chrome/Chromium not found, set CHROME_PATH env');
		browser = await puppeteer.launch({
			headless: process.env.PUPPETEER_HEADLESS !== 'false',
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
			executablePath
		});
		browsers.set(key, browser);
		console.log(`[browser] Launched for task: ${key}`);
	}
	return browser;
}

export async function closeBrowser(taskId: string): Promise<void> {
	const key = taskId || '__default__';
	const browser = browsers.get(key);
	if (browser) {
		await browser.close().catch(() => { });
		browsers.delete(key);
	}
}

export async function closeAllBrowsers(): Promise<void> {
	for (const [, browser] of browsers) {
		await browser.close().catch(() => { });
	}
	browsers.clear();
}
