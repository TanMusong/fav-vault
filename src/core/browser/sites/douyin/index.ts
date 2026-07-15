import type { Page } from 'puppeteer-core';
import BaseSite, { type TaskContext } from '../base';
import { type TaskResult, type DownloadFile, DownloadStatus } from '../../../../types';
import { resolveDownloadDir, DEFAULT_PATH_TEMPLATE } from '../../../downloader/path';
import { downloadFile } from '../../../downloader/downloader';
import { config } from '../../../config/manager';
import { FetchItem, getDetailUrl, getDownloadUrls, ApiItem, ApiData } from './douyin-api';
import { unfavoritePage } from './unfavorite';
import { interceptApiResponse } from '../shared/page-utils';
import path from 'path';
import fs from 'fs';
import { runPool, type Executable } from '../../../utils/pool';

const COLLECTION_URL = 'https://www.douyin.com/user/self?showSubTab=video&showTab=favorite_collection';

class DouyinSite extends BaseSite {
	constructor() {
		super('douyin', {
			label: '抖音',
			icon: 'fa-brands fa-tiktok',
			color: '#fe2c55'
		});
	}

	public async checkLogin(page: Page, timeout = 60000): Promise<{ username: string; userId: string }> {
		let username = '', userId = '';
		try {
			await page.goto(COLLECTION_URL, { waitUntil: 'networkidle2', timeout });
			for (let i = 0; i < 10; i++) {
				const result = await page.evaluate(() => {
					const nameEl = document.querySelector('[data-e2e="user-info"] h1')
						|| document.querySelector('[class*="user-info"] [class*="name"]');
					const name = (nameEl as HTMLElement | null)?.innerText?.trim() || '';
					let uid = '';
					const infoEl = document.querySelector('[data-e2e="user-info"]');
					const allText = (infoEl as HTMLElement | null)?.innerText || '';
					const match = allText.match(/抖音号[：:](\S+)/);
					if (match) uid = match[1];
					return { name, uid };
				});
				if (result.name) { username = result.name; userId = result.uid; break; }
				await new Promise<void>(r => setTimeout(r, 1000));
			}
		} catch (err) {
			console.error('[douyin] checkLogin error:', (err as Error).message);
		}
		return { username, userId };
	}

	private async fetchItems(page: Page, skipIds?: string[]): Promise<{ items: FetchItem[]; has_more: 0 | 1 }> {
		const captured = await interceptApiResponse(page, 'listcollection', COLLECTION_URL);
		if (!captured) return { items: [], has_more: 0 };

		const apiData = captured as unknown as ApiData;
		const has_more = apiData?.has_more || 0;
		const items: FetchItem[] = (apiData?.aweme_list || [])
			.filter(item => !skipIds || skipIds.indexOf(item.aweme_id) < 0)
			.map((item: ApiItem) => ({
				id: item.aweme_id,
				type: item.aweme_type,
				desc: item.desc || '',
				author: item.author?.nickname || '',
				author_id: item.author_user_id,
				video: (item.video || null) as Record<string, unknown> | null,
				images: (item.images || []) as Array<Record<string, unknown>>,
				raw: item
			}));

		return { items, has_more };
	}

	public async executeTask(ctx: TaskContext): Promise<TaskResult> {
		const startTime = Date.now();
		const { task, browser, concurrency } = ctx;

		let page: Page | null = null;
		page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });

		const { username } = await this.checkLogin(page, ctx.timeout);
		if (!username) {
			ctx.addLog('warn', 'Douyin login expired');
			return { state: 0, message: 'status.login_expired', downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
		}
		let downloaded = 0, failed = 0;
		const skipIds: string[] = [];
		const unfavoriteWithNewPage = async (detailUrl: string): Promise<void> => {
			const actionPage = await browser.newPage();
			await actionPage.setViewport({ width: 1280, height: 800 });
			try {
				await unfavoritePage(actionPage, detailUrl);
			} finally {
				await actionPage.close().catch(() => { });
			}
		};

		const processItem = async (item: FetchItem): Promise<void> => {
			skipIds.push(item.id);
			const detailUrl = getDetailUrl(item);
			if (ctx.hasSuccessfulDownload(item.id)) {
				await unfavoriteWithNewPage(detailUrl);
				return;
			}
			const downloadUrls = getDownloadUrls(item);
			if (downloadUrls.length === 0) {
				ctx.addLog('warn', `No download URLs: ${item.id} (${item.author})`);
				ctx.addDownload({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Failed, stateMessage: 'no download urls', files: [], dataJson: { detailUrl, raw: item.raw } });
				failed++;
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
					author_id: String(item.author_id || 'unknown')
				});
				if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
				for (const dl of downloadUrls) {
					files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: 'downloading' });
				}
				ctx.addDownload({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Downloading, stateMessage: '', files, dataJson: { detailUrl, raw: item.raw } });

				await Promise.all(downloadUrls.map(async (dl, fi) => {
					const dest = path.join(userDir, dl.filename);
					for (const url of dl.urls) {
						const result = await downloadFile(url, dest, {
							cookies: task.cookies,
							headers: { 'Referer': 'https://www.douyin.com/', 'Origin': 'https://www.douyin.com' },
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
					ctx.addLog('info', `Downloaded: ${item.author} (${item.author_id})/${item.id} | ${files.length} files`);
					downloaded++;
				} else {
					const failedFiles = files.filter(f => f.fileStatus !== 'success').map(f => `${f.filename}(${f.fileStatus})`).join(', ');
					ctx.updateDownload(item.id, { state: DownloadStatus.Failed, stateMessage: `partial: ${failedFiles}`, files });
					ctx.addLog('warn', `Partial download failed: ${item.id} (${item.author}) | failed files: ${failedFiles}`);
					failed++;
				}
			} catch (err) {
				console.error('[douyin] download error:', (err as Error).message);
				ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
				ctx.addDownload({ id: item.id, author: item.author, authorId: String(item.author_id), desc: item.desc, state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50), files: [], dataJson: { detailUrl, raw: item.raw } });
				failed++;
			}
			await unfavoriteWithNewPage(detailUrl);
		};

		try {
			let fetched: { items: FetchItem[]; has_more: 0 | 1; };
			let maxRequestCount = 20;
			do {
				fetched = await this.fetchItems(page, skipIds);
				maxRequestCount--;
				const executables: Executable[] = fetched.items.map(item => ({ execute: () => processItem(item) }));
				await runPool(executables, concurrency);
			} while (fetched.items?.length !== 0 && fetched.has_more === 1 && maxRequestCount > 0);
		} catch (err) {
			ctx.addLog('error', `Douyin task error: ${(err as Error).message}`);
			return { state: 0, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
		} finally {
			if (page) await page.close().catch(() => { });
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

export default new DouyinSite();
