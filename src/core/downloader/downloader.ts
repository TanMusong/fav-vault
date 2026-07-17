import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ProxyAgent } from 'undici';

export function normalizeFilename(name: string, options: { replacementChar?: string; maxLength?: number } = {}): string {
	const { replacementChar = '_', maxLength = 255 } = options;
	if (typeof name !== 'string' || !name) return 'file';

	const lastDotIndex = name.lastIndexOf('.');
	let baseName = name;
	let extension = '';
	if (lastDotIndex > 0 && lastDotIndex < name.length - 1) {
		baseName = name.slice(0, lastDotIndex);
		extension = name.slice(lastDotIndex);
	}

	const illegalChars = /[\\/:*?"<>|\x00-\x1f\u007f\u00a0\u200b\u200c\u200d\u2060\ufeff]/g;
	let cleanBase = baseName.replace(illegalChars, replacementChar);

	const reservedNames = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i;
	if (reservedNames.test(cleanBase)) {
		cleanBase = replacementChar + cleanBase;
	}

	cleanBase = cleanBase.replace(/[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+$/g, '').replace(/^[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+/g, '').replace(/^\.+/, '').replace(/\.+$/, '');
	if (cleanBase.length === 0) cleanBase = 'file';
	cleanBase = cleanBase.replace(new RegExp(`${replacementChar}{2,}`, 'g'), replacementChar);

	const maxBaseLength = maxLength - extension.length;
	if (maxBaseLength > 0 && cleanBase.length > maxBaseLength) {
		cleanBase = cleanBase.slice(0, maxBaseLength);
	}

	let result = cleanBase + extension;
	if (result.length === 0) result = 'file';
	return result;
}

interface DownloadOptions {
	cookies: string;
	headers?: Record<string, string>;
	timeout?: number;
	maxRetries?: number;
	proxy?: { enabled: boolean; type: string; host: string; port: number };
	onProgress?: (downloaded: number, expected: number) => void;
}

interface DownloadResult {
	fileSize: number;
	expectedSize: number;
}

export async function downloadFile(url: string, destPath: string, options: DownloadOptions): Promise<DownloadResult | null> {
	const { cookies, headers: extraHeaders = {}, timeout = 120000, maxRetries = 3, proxy, onProgress } = options;

	let alreadyDownloaded = 0;
	try {
		const stat = fs.statSync(destPath);
		alreadyDownloaded = stat.size;
	} catch (_e) { /* no partial file */ }

	let totalDownloaded = alreadyDownloaded;

	const dispatcher = proxy?.enabled && proxy.host && proxy.port
		? new ProxyAgent(`${proxy.type || 'http'}://${proxy.host}:${proxy.port}`)
		: undefined;

	// Proxy for downloads: browser-level proxy handles most requests via Chrome's --proxy-server flag
	// For direct Node.js fetch downloads, proxy support requires undici package (optional)

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		if (attempt > 0) {
			await new Promise(r => setTimeout(r, 1000 * attempt));
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);

			try {
				const reqHeaders: Record<string, string> = {
					'Cookie': cookies,
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
					...extraHeaders
				};
				if (alreadyDownloaded > 0) {
					reqHeaders['Range'] = 'bytes=' + alreadyDownloaded + '-';
				}

				const fetchOptions: RequestInit = {
					headers: reqHeaders,
					signal: controller.signal,
					redirect: 'follow'
				};
				if (dispatcher) (fetchOptions as any).dispatcher = dispatcher;
				const resp = await fetch(url, fetchOptions);

				const isResume = resp.status === 206;
				if (!resp.ok && !isResume) continue;

				const contentLength = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
				const expectedSize = isResume ? alreadyDownloaded + contentLength : contentLength;
				const body = resp.body;
				if (!body) continue;

				const nodeStream = Readable.fromWeb(body as any);
				const ws = fs.createWriteStream(destPath, { flags: isResume ? 'a' : 'w' });

				if (!isResume) totalDownloaded = 0;
				nodeStream.on('data', (chunk: Buffer) => {
					totalDownloaded += chunk.length;
					if (onProgress) onProgress(totalDownloaded, expectedSize);
				});

				await pipeline(nodeStream, ws);

				if (totalDownloaded > 1000) {
					return { fileSize: totalDownloaded, expectedSize };
				}
				try { fs.unlinkSync(destPath); } catch (_e) { /* */ }
				totalDownloaded = 0;
				alreadyDownloaded = 0;
			} finally {
				clearTimeout(timer);
			}
		} catch (err: any) {
			if (err.name === 'AbortError') continue;
		}
	}
	try { fs.unlinkSync(destPath); } catch (_e) { /* */ }
	return null;
}
