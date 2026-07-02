import os from 'os';
import path from 'path';

const HOME = os.homedir();

interface Config {
	readonly port: number;
	readonly downloadDir: string;
	readonly dbPath: string;
	readonly maxConcurrent: number;
	readonly chromePath: string;
}

const config: Config = {
	get port(): number { return parseInt(process.env.PORT || '', 10) || 5000; },
	get downloadDir(): string { return process.env.DOWNLOAD_DIR || path.join(HOME, 'fav-vault', 'downloads'); },
	get dbPath(): string { return process.env.DB_PATH || path.join(HOME, 'fav-vault', 'database'); },
	get maxConcurrent(): number { return parseInt(process.env.MAX_CONCURRENT || '', 10) || 2; },
	get chromePath(): string { return process.env.CHROME_PATH || ''; }
};

interface GlobalConfig {
	port: number;
	downloadDir: string;
	dbPath: string;
	maxConcurrent: number;
	chromePath: string;
}

function getGlobal(): GlobalConfig {
	return { port: config.port, downloadDir: config.downloadDir, dbPath: config.dbPath, maxConcurrent: config.maxConcurrent, chromePath: config.chromePath };
}

export { config, getGlobal, GlobalConfig };
