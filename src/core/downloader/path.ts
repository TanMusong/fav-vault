import { normalizeFilename } from './downloader';
import path from 'path';

const DEFAULT_PATH_TEMPLATE = '{type}/{user}/{author_id}_{author}';

interface PathVars {
	type: string;
	user: string;
	id: string;
	author: string;
	author_id: string;
}

export function resolveDownloadDir(downloadDir: string, template: string, vars: PathVars): string {
	if (path.isAbsolute(template) || /^[A-Za-z]:[\\/]/.test(template)) {
		throw new Error('downloadPath must be relative');
	}
	const resolved = template
		.replace(/\{type\}/g, normalizeFilename(vars.type))
		.replace(/\{user\}/g, normalizeFilename(vars.user))
		.replace(/\{id\}/g, normalizeFilename(vars.id))
		.replace(/\{author\}/g, normalizeFilename(vars.author))
		.replace(/\{author_id\}/g, normalizeFilename(vars.author_id));
	const segments = resolved.split(/[\\/]+/).filter(Boolean).map(segment => {
		if (segment === '..') throw new Error('downloadPath must not contain parent directory segments');
		return normalizeFilename(segment);
	}).filter(Boolean);
	const root = path.resolve(downloadDir);
	const target = path.resolve(root, ...segments);
	const relative = path.relative(root, target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('downloadPath must stay inside DOWNLOAD_DIR');
	}
	return target;
}

export { DEFAULT_PATH_TEMPLATE };
