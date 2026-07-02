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
	const resolved = template
		.replace(/\{type\}/g, normalizeFilename(vars.type))
		.replace(/\{user\}/g, normalizeFilename(vars.user))
		.replace(/\{id\}/g, normalizeFilename(vars.id))
		.replace(/\{author\}/g, normalizeFilename(vars.author))
		.replace(/\{author_id\}/g, normalizeFilename(vars.author_id));
	return path.join(downloadDir, resolved);
}

export { DEFAULT_PATH_TEMPLATE };
