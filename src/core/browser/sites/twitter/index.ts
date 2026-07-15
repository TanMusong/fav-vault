import type { Page } from 'puppeteer-core';
import BaseSite, { type TaskContext } from '../base';
import { type TaskResult, type DownloadFile, DownloadStatus } from '../../../../types';
import { resolveDownloadDir, DEFAULT_PATH_TEMPLATE } from '../../../downloader/path';
import { downloadFile } from '../../../downloader/downloader';
import { config } from '../../../config/manager';
import { TwitterItem, TwitterApiResponse, parseApiResponse, getMediaUrls } from './twitter-api';
import { unbookmarkPage, type UnbookmarkResult } from './unbookmark';
import path from 'path';
import fs from 'fs';
import { runPool, type Executable } from '../../../utils/pool';

const BOOKMARKS_URL = 'https://x.com/i/bookmarks';

class TwitterSite extends BaseSite {
	constructor() {
		super('twitter', {
			label: 'X',
			icon: 'fa-brands fa-x-twitter',
			color: '#1d9bf0'
		});
	}

	public getCookieDomain(): string {
		return '.x.com';
	}

	public getCookieField() {
		return { label: 'Cookie', placeholder: 'msg.cookie_placeholder_twitter', required: true };
	}

	public async checkLogin(page: Page, timeout = 60000): Promise<{ username: string; userId: string }> {
		let username = '', userId = '';
		try {
			await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout });
			for (let i = 0; i < 10; i++) {
				const result = await page.evaluate(() => {
					const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
					if (!btn) return { name: '', id: '' };
					const nameImg = btn.querySelector('img[alt]');
					const name = nameImg?.getAttribute('alt') || '';
					let displayName = name;
					if (!displayName) {
						const avatarDiv = btn.querySelector('div[aria-label]');
						displayName = avatarDiv?.getAttribute('aria-label') || '';
					}
					let handle = '';
					const allSpans = btn.querySelectorAll('span');
					for (const s of allSpans) {
						if (s.textContent?.startsWith('@')) {
							handle = s.textContent.replace(/^@/, '');
							break;
						}
					}
					if (!handle) {
						const handleSpan = btn.querySelector('span[class*="r-16dba41"]');
						handle = handleSpan?.textContent?.replace(/^@/, '') || '';
					}
					return { name: displayName, id: handle };
				});
				if (result.id) { username = result.name || result.id; userId = result.id; break; }
				await new Promise<void>(r => setTimeout(r, 1000));
			}
			if (!userId) {
				const fallback = await page.evaluate(() => {
					const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
					if (profileLink) {
						const href = (profileLink.getAttribute('href') || '').replace(/^\//, '');
						if (href && !href.startsWith('i/')) return href;
					}
					return '';
				});
				if (fallback) { username = fallback; userId = fallback; }
			}
		} catch (err) {
			console.error('[twitter] checkLogin error:', (err as Error).message);
		}
		return { username, userId };
	}

	private async fetchItems(page: Page, skipIds?: string[], timeout = 60000): Promise<{ items: TwitterItem[]; cursor: string | null }> {
		let allItems: TwitterItem[] = [];
		let lastCursor: string | null = null;

		const responseHandler = async (res: import('puppeteer-core').HTTPResponse) => {
			const url = res.url();
			if (!url.includes('Bookmarks')) return;
			try {
				const text = await res.text();
				let parsed: TwitterApiResponse | null = null;
				try { parsed = JSON.parse(text); } catch (_e) {
					const match = text.match(/=\s*({.+})\s*;?\s*$/s);
					if (match) { try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ } }
				}
				if (!parsed?.data?.bookmark_timeline_v2?.timeline?.instructions?.length) return;
				for (const item of parseApiResponse(parsed)) {
					if (!allItems.find(x => x.id === item.id)) allItems.push(item);
				}
				for (const inst of parsed.data.bookmark_timeline_v2.timeline.instructions) {
					const entries = inst.entries || [];
					const lastEntry = entries[entries.length - 1];
					if (lastEntry?.entryId?.startsWith('cursor-bottom')) {
						lastCursor = (lastEntry.content as { value?: string })?.value || null;
					}
				}
			} catch (_e) { /* */ }
		};

		page.on('response', responseHandler);
		try {
			await page.goto(BOOKMARKS_URL, { waitUntil: 'networkidle2', timeout });
			for (let i = 0; i < 30 && allItems.length === 0; i++) {
				await new Promise<void>(r => setTimeout(r, 1000));
			}
			const filtered = allItems.filter(item => !skipIds || skipIds.indexOf(item.id) < 0);
			console.log(`[twitter] fetchItems: ${allItems.length} total, ${filtered.length} after filter`);
			return { items: filtered, cursor: lastCursor };
		} finally {
			page.off('response', responseHandler);
		}
	}

	public async executeTask(ctx: TaskContext): Promise<TaskResult> {
		const startTime = Date.now();
		const { task, browser, concurrency } = ctx;
		console.log(`[twitter] executeTask: ${task.name}`);

		let page: Page | null = null;
		page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });

		const { username } = await this.checkLogin(page, ctx.timeout);
		if (!username) {
			ctx.addLog('warn', 'X login expired - checkLogin returned empty username');
			return { state: 0, message: 'status.login_expired', downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
		}
		ctx.addLog('info', `X login OK: ${username}`);

		let downloaded = 0, failed = 0;
		const skipIds: string[] = [];

		const handleUnbookmark = async (item: TwitterItem) => {
			const actionPage = await browser.newPage();
			await actionPage.setViewport({ width: 1280, height: 800 });
			let result: UnbookmarkResult = { ok: false, reason: 'unknown' };
			try {
				result = await unbookmarkPage(actionPage, item.detailUrl);
			} catch (err) {
				result = { ok: false, reason: 'exception', detail: (err as Error).message };
			} finally {
				await actionPage.close().catch(() => {});
			}
			if (!result.ok) {
				const detailInfo = result.detail ? ` | detail: ${result.detail}` : '';
				ctx.addLog('warn', `Unbookmark failed: ${item.id} (${item.authorId}) | reason: ${result.reason}${detailInfo}`);
			}
		};

		const processItem = async (item: TwitterItem): Promise<void> => {
			skipIds.push(item.id);
			if (ctx.hasSuccessfulDownload(item.id)) {
				if (item.bookmarked) await handleUnbookmark(item);
				return;
			}
			const mediaUrls = getMediaUrls(item);
			if (mediaUrls.length === 0) {
				ctx.addLog('info', `No media: ${item.id} (${item.authorId})`);
				ctx.addDownload({
					id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
					state: DownloadStatus.Success, stateMessage: 'status.no_media',
					files: [{ type: 'text', filename: 'status.no_media', url: '', fileSize: 0, fileExpectedSize: 0, fileStatus: 'success' }],
					dataJson: { detailUrl: item.detailUrl, raw: item.raw }
				});
				if (item.bookmarked) await handleUnbookmark(item);
				return;
			}
			try {
				const files: DownloadFile[] = [];
				const pathTemplate = (task.customConfigJson as Record<string, unknown>)?.downloadPath as string || DEFAULT_PATH_TEMPLATE;
				const userDir = resolveDownloadDir(config.downloadDir, pathTemplate, {
					type: this.meta.label || task.site,
					user: task.name,
					id: task.userId || '',
					author: item.author || 'unknown',
					author_id: item.authorId || 'unknown'
				});
				if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
				for (const dl of mediaUrls) {
					files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: 'downloading' });
				}
				ctx.addDownload({
					id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
					state: DownloadStatus.Downloading, stateMessage: '',
					files, dataJson: { detailUrl: item.detailUrl, raw: item.raw }
				});
				await Promise.all(mediaUrls.map(async (dl, fi) => {
					const dest = path.join(userDir, dl.filename);
					for (const url of dl.urls) {
						const result = await downloadFile(url, dest, {
							cookies: task.cookies,
							headers: { 'Referer': 'https://x.com/' },
							timeout: ctx.timeout,
							maxRetries: ctx.maxRetries,
							proxy: ctx.proxy,
							onProgress: (downloaded, expected) => {
								files[fi].fileSize = downloaded;
								files[fi].fileExpectedSize = expected;
								ctx.emitDownloadProgress(item.id, files);
							}
						});
						if (result) {
							files[fi].fileSize = result.fileSize;
							files[fi].fileExpectedSize = result.expectedSize;
							files[fi].url = url;
							files[fi].fileStatus = 'success';
							ctx.updateDownload(item.id, { files });
							return;
						}
					}
					files[fi].fileStatus = 'failed';
					ctx.updateDownload(item.id, { files });
				}));
				const allSuccess = files.length > 0 && files.every(f => f.fileStatus === 'success');
				if (allSuccess) {
					ctx.updateDownload(item.id, { state: DownloadStatus.Success, stateMessage: '', files });
					ctx.addLog('info', `Downloaded: ${item.author} (${item.authorId})/${item.id} | ${files.length} files`);
					downloaded++;
					if (item.bookmarked) await handleUnbookmark(item);
				} else {
					const failedFiles = files.filter(f => f.fileStatus !== 'success').map(f => `${f.filename}(${f.fileStatus})`).join(', ');
					ctx.updateDownload(item.id, { state: DownloadStatus.Failed, stateMessage: `partial: ${failedFiles}`, files });
					ctx.addLog('warn', `Partial download failed: ${item.id} (${item.authorId}) | failed files: ${failedFiles}`);
					failed++;
				}
			} catch (err) {
				console.error('[twitter] download error:', (err as Error).message);
				ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
				ctx.addDownload({
					id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
					state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50),
					files: [], dataJson: { detailUrl: item.detailUrl, raw: item.raw }
				});
				failed++;
			}
		};

		try {
			let fetched: { items: TwitterItem[]; cursor: string | null };
			let maxRequestCount = 10;

			do {
				fetched = await this.fetchItems(page, skipIds, ctx.timeout);
				maxRequestCount--;
				const executables: Executable[] = fetched.items.map(item => ({ execute: () => processItem(item) }));
				await runPool(executables, concurrency);
			} while (fetched.items.length > 0 && maxRequestCount > 0);
		} catch (err) {
			ctx.addLog('error', `X task error: ${(err as Error).message}`);
			return { state: 0, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
		} finally {
			if (page) await page.close().catch(() => {});
		}

		return {
			state: 1,
			message: 'ok',
			downloaded, failed,
			total: downloaded + failed,
			duration: Date.now() - startTime
		};
	}
}

export default new TwitterSite();
