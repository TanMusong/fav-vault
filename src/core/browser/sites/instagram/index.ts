import type { Page } from 'puppeteer-core';
import BaseSite, { type TaskContext } from '../base';
import { type TaskResult, type DownloadFile, DownloadStatus } from '../../../../types';
import { resolveDownloadDir, DEFAULT_PATH_TEMPLATE } from '../../../downloader/path';
import { downloadFile } from '../../../downloader/downloader';
import { config } from '../../../config/manager';
import { InstagramItem, NewApiResponse, SavedPostsApiResponse, parseApiResponse, parseSavedPostsResponse, getMediaUrls } from './instagram-api';
import { unsavePage } from './unsave';
import path from 'path';
import fs from 'fs';
import { runPool, type Executable } from '../../../utils/pool';

class InstagramSite extends BaseSite {
	constructor() {
		super('instagram', {
			label: 'Instagram',
			icon: 'fa-brands fa-instagram',
			color: '#E4405F'
		});
	}

	public getCookieDomain(): string {
		return '.instagram.com';
	}

	public getCookieField() {
		return { label: 'Cookie', placeholder: 'msg.cookie_placeholder_instagram', required: true };
	}

	public async checkLogin(page: Page, timeout = 60000): Promise<{ username: string; userId: string }> {
		let username = '', userId = '';
		try {
			// Navigate to home page to get handle
			await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout });
			await new Promise<void>(r => setTimeout(r, 3000));

			const result = await page.evaluate(() => {
				if (window.location.href.includes('login')) return { displayName: '', handle: '' };

				// Extract handle from profile links
				let handle = '';
				const links = document.querySelectorAll('a');
				for (const link of links) {
					const href = link.getAttribute('href') || '';
					const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
					if (match && ['login', 'explore', 'accounts', 'reels', 'saved', 'popular', 'direct'].indexOf(match[1]) === -1) {
						handle = match[1];
						break;
					}
				}

				return { handle };
			});

			if (result.handle) {
				userId = result.handle;

				// Get display name from profile page meta
				await page.goto(`https://www.instagram.com/${result.handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
				await new Promise<void>(r => setTimeout(r, 2000));

				const displayName = await page.evaluate(() => {
					const meta = document.querySelector('meta[property="og:description"]');
					const content = meta?.getAttribute('content') || '';
					// Parse "See Instagram photos and videos from DISPLAY_NAME (@handle)"
					const match = content.match(/from\s+(.+?)\s*\(@/);
					return match ? match[1] : '';
				});

				username = displayName || userId;
			}
		} catch (err) {
			console.error('[instagram] checkLogin error:', (err as Error).message);
		}
		return { username, userId };
	}

	private async fetchItems(page: Page, username: string, skipIds?: string[], endCursor?: string | null): Promise<{ items: InstagramItem[]; endCursor: string | null; hasNextPage: boolean }> {
		let allItems: InstagramItem[] = [];
		let nextCursor: string | null = null;
		let hasNext = false;

		const savedUrl = `https://www.instagram.com/${username}/saved/all-posts/`;
		const handler = async (res: import('puppeteer-core').HTTPResponse) => {
			const url = res.url();
			try {
				// REST API for saved posts
				if (url.includes('/api/v1/feed/saved/posts/')) {
					const text = await res.text();
					const parsed = JSON.parse(text) as SavedPostsApiResponse;
					if (parsed?.items?.length) {
						const { items, hasMore } = parseSavedPostsResponse(parsed, username);
						for (const item of items) {
							if (!allItems.find(x => x.id === item.id)) allItems.push(item);
						}
						hasNext = hasMore;
					}
					return;
				}

				// GraphQL API fallback
				if (!url.includes('graphql') && !url.includes('api/graphql')) return;
				const text = await res.text();
				let parsed: NewApiResponse | null = null;
				try { parsed = JSON.parse(text); } catch (_e) {
					const match = text.match(/=\s*({.+})\s*;?\s*$/s);
					if (match) { try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ } }
				}
				if (!parsed) return;

				const { items, endCursor: ec, hasNextPage: hp } = parseApiResponse(parsed, username);
				if (items.length > 0) {
					for (const item of items) {
						if (!allItems.find(x => x.id === item.id)) allItems.push(item);
					}
					if (ec) nextCursor = ec;
					if (hp) hasNext = hp;
				}
			} catch (_e) { /* */ }
		};

		page.on('response', handler);
		try {
			const navigateUrl = endCursor ? `${savedUrl}?max_id=${endCursor}` : savedUrl;
			try {
				await page.goto(navigateUrl, { waitUntil: 'networkidle2', timeout: 60000 });
			} catch (_navErr) {
				// Navigation timeout is expected when no more pages
				console.log('[instagram] fetchItems: navigation ended (possibly no more pages)');
			}
			for (let i = 0; i < 30 && allItems.length === 0; i++) {
				await new Promise<void>(r => setTimeout(r, 1000));
			}
		} finally {
			page.off('response', handler);
		}

		const filtered = allItems.filter(item => !skipIds || skipIds.indexOf(item.id) < 0);
		console.log(`[instagram] fetchItems: ${allItems.length} total, ${filtered.length} after filter`);
		return { items: filtered, endCursor: nextCursor, hasNextPage: hasNext };
	}

	public async executeTask(ctx: TaskContext): Promise<TaskResult> {
		const startTime = Date.now();
		const { task, browser, concurrency } = ctx;
		console.log(`[instagram] executeTask: ${task.name}`);

		let page: Page | null = null;
		page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });

		const { username, userId } = await this.checkLogin(page, ctx.timeout);
		if (!userId) {
			ctx.addLog('warn', 'Instagram login expired');
			return { state: 0, message: 'status.login_expired', downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
		}
		ctx.addLog('info', `Instagram login OK: ${username} (${userId})`);

		// Use userId (handle) for URL, username (display name) for display
		const handle = userId;

		let downloaded = 0, failed = 0;
		const skipIds: string[] = [];

		const handleUnsave = async (item: InstagramItem) => {
			const actionPage = await browser.newPage();
			await actionPage.setViewport({ width: 1280, height: 800 });
			let ok = false;
			try {
				ok = await unsavePage(actionPage, item.detailUrl);
			} catch (err) {
				ctx.addLog('error', `Unsave exception: ${item.id} - ${(err as Error).message}`);
			} finally {
				await actionPage.close().catch(() => {});
			}
			if (!ok) {
				ctx.addLog('warn', `Unsave failed: ${item.id} (${item.authorId})`);
			}
		};

		const processItem = async (item: InstagramItem): Promise<void> => {
			skipIds.push(item.id);
			if (ctx.hasSuccessfulDownload(item.id)) {
				if (item.bookmarked) await handleUnsave(item);
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
				if (item.bookmarked) await handleUnsave(item);
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
							headers: { 'Referer': 'https://www.instagram.com/' },
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
					if (item.bookmarked) await handleUnsave(item);
				} else {
					const failedFiles = files.filter(f => f.fileStatus !== 'success').map(f => `${f.filename}(${f.fileStatus})`).join(', ');
					ctx.updateDownload(item.id, { state: DownloadStatus.Failed, stateMessage: `partial: ${failedFiles}`, files });
					ctx.addLog('warn', `Partial download failed: ${item.id} (${item.authorId}) | failed files: ${failedFiles}`);
					failed++;
				}
			} catch (err) {
				console.error('[instagram] download error:', (err as Error).message);
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
			let endCursor: string | null = null;
			let maxRequestCount = 20;

			do {
				const fetched = await this.fetchItems(page, handle, skipIds, endCursor);
				maxRequestCount--;
				endCursor = fetched.endCursor;
				const executables: Executable[] = fetched.items.map(item => ({ execute: () => processItem(item) }));
				await runPool(executables, concurrency);
				if (fetched.items.length > 0) {
					await new Promise<void>(r => setTimeout(r, 3000));
				}
			} while (endCursor && maxRequestCount > 0);
		} catch (err) {
			ctx.addLog('error', `Instagram task error: ${(err as Error).message}`);
			return { state: 2, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
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

export default new InstagramSite();
