import { getBrowser, launchBrowser } from './puppeteer';
import { getSite } from './registry';
import * as store from '../db/store';
import type { TaskResult } from '../../types';
import type { Page, Browser } from 'puppeteer-core';
import type { TaskContext } from './sites/base';
import { config } from '../config/manager';
import { events } from '../events';

const runningTasks = new Set<string>();

function isRunning(taskId: string): boolean { return runningTasks.has(taskId); }

function parseCookies(rawCookie: string): Array<{ name: string; value: string }> {
	if (!rawCookie) return [];
	return rawCookie.split(';').map(p => p.trim()).filter(Boolean).map(p => {
		const idx = p.indexOf('=');
		return idx > 0 ? { name: p.slice(0, idx).trim(), value: p.slice(idx + 1).trim() } : null;
	}).filter((c): c is { name: string; value: string } => c !== null);
}

async function setBrowserCookies(browser: import('puppeteer-core').Browser, rawCookie: string, domain: string): Promise<void> {
	const cookies = parseCookies(rawCookie);
	if (cookies.length === 0) throw new Error('No cookies provided');
	await browser.setCookie(...cookies.map(c => ({ name: c.name, value: c.value, domain })));
}

async function verifyTask(taskId: string): Promise<{ username: string; userId: string }> {
	const task = store.getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	const site = getSite(task.site);
	if (!site) throw new Error(`Site "${task.site}" not registered`);
	const browser = await getBrowser(taskId);
	const domain = site ? site.getCookieDomain() : '.douyin.com';
	await setBrowserCookies(browser, task.cookies, domain);
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 800 });
	try {
		const { username, userId } = await site.checkLogin(page);
		if (!username) throw new Error('error.invalid_cookies');
		return { username, userId };
	} finally {
		await page.close();
	}
}

async function runTask(taskId: string): Promise<TaskResult> {
	if (runningTasks.has(taskId)) throw new Error('error.task_running');
	const task = store.getTask(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (task.paused) throw new Error(`Task ${taskId} is paused`);
	const site = getSite(task.site);
	if (!site) throw new Error(`Site "${task.site}" not registered`);

	runningTasks.add(taskId);
	const startTime = Date.now();
	let page: Page | null = null;
	let taskBrowser: Browser | null = null;
	let ownBrowser = false;

	try {
		const proxyConfig = (task.customConfigJson as Record<string, unknown>)?.proxy as { enabled?: boolean; type?: string; host?: string; port?: number } | undefined;
		const useProxy = !!(proxyConfig?.enabled && proxyConfig?.host && proxyConfig?.port);
		const proxyServer = useProxy ? `${proxyConfig.type || 'http'}://${proxyConfig.host}:${proxyConfig.port}` : undefined;

		if (proxyServer) {
			taskBrowser = await launchBrowser(proxyServer);
			ownBrowser = true;
		} else {
			taskBrowser = await getBrowser(taskId);
		}
		const browser = taskBrowser;

		const context = browser.defaultBrowserContext();
		const existingCookies = await context.cookies();
		if (existingCookies.length > 0) {
			await context.deleteCookie(...existingCookies);
		}

		const domain = site.getCookieDomain();
		await setBrowserCookies(browser, task.cookies, domain);
		page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });

		events.emitTaskStarted(taskId, task.name);
		store.addLog(taskId, 'info', `Task started: ${task.name}${proxyServer ? ' (proxy: ' + proxyServer + ')' : ''}`);

		const ctx: TaskContext = {
			taskId,
			task,
			browser,
			concurrency: (task.customConfigJson as Record<string, unknown>)?.maxConcurrent as number || config.maxConcurrent,
			timeout: ((task.customConfigJson as Record<string, unknown>)?.timeout as number || 60) * 1000,
			maxRetries: (task.customConfigJson as Record<string, unknown>)?.maxRetries as number || 3,
			proxy: { enabled: useProxy || false, type: proxyConfig?.type || 'http', host: proxyConfig?.host || '', port: proxyConfig?.port || 0 },
			downloadDir: config.downloadDir,
			addDownload: (data) => {
				store.addDownload(taskId, data);
				events.emitDownloadAdded(taskId, data);
			},
			updateDownload: (postId, data) => {
				store.updateDownload(taskId, postId, data);
				events.emitDownloadProgress(taskId, postId, data.files || [], data.state);
			},
			emitDownloadProgress: (postId, files) => {
				events.emitDownloadProgress(taskId, postId, files);
			},
			hasSuccessfulDownload: (postId) => store.hasSuccessfulDownload(taskId, postId),
			hasPostDownload: (postId) => store.hasPostDownload(taskId, postId),
			addLog: (level, message) => store.addLog(taskId, level, message),
		};

		const result = await site.executeTask(ctx);

		// Save updated cookies back to database
		try {
			const updatedCookies = await taskBrowser.defaultBrowserContext().cookies();
			const cookieStr = updatedCookies.map(c => `${c.name}=${c.value}`).join('; ');
			if (cookieStr) store.updateTask(taskId, { cookies: cookieStr });
		} catch (_e) { /* ignore cookie save errors */ }

		store.setTaskRunState(taskId, { last_state: result.state });
		store.addLog(taskId, 'info', `Task completed: ${task.name}, downloaded ${result.downloaded}, failed ${result.failed}, duration ${result.duration}ms`);
		events.emitTaskCompleted(taskId, result);
		return result;

	} catch (err) {
		const message = (err as Error).message;
		store.addLog(taskId, 'error', message);
		const result: TaskResult = { state: 0, message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
		store.setTaskRunState(taskId, { last_state: result.state });
		events.emitTaskFailed(taskId, message);
		throw err;
	} finally {
		runningTasks.delete(taskId);
		if (page) await page.close().catch(() => {});
		if (ownBrowser && taskBrowser) await taskBrowser.close().catch(() => {});
	}
}

async function verifyCredentials(siteName: string, cookies: string): Promise<{ username: string; userId: string }> {
	const site = getSite(siteName);
	if (!site) throw new Error('error.site_not_found');
	const browser = await getBrowser('verify-' + siteName);
	const context = await browser.createBrowserContext();
	try {
		const domain = site.getCookieDomain();
		const parsedCookies = parseCookies(cookies);
		if (parsedCookies.length === 0) throw new Error('No cookies provided');
		await context.setCookie(...parsedCookies.map(c => ({ name: c.name, value: c.value, domain })));
		const page = await context.newPage();
		await page.setViewport({ width: 1280, height: 800 });
		try {
			const { username, userId } = await site.checkLogin(page);
			if (!username) throw new Error('error.invalid_cookies');
			return { username, userId };
		} finally {
			await page.close().catch(() => {});
		}
	} finally {
		await context.close().catch(() => {});
	}
}

export { verifyTask, verifyCredentials, runTask, isRunning };
