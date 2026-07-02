export interface Task {
	id: string;
	name: string;
	userId: string;
	site: string;
	paused: boolean;
	interval: number;
	cookies: string;
	customConfigJson: Record<string, unknown>;
	next_run: string | null;
	last_state: number;
	nextRun: string | null;
	downloadCount?: number;
}

export interface TaskResult {
	state: number;
	message: string;
	downloaded: number;
	failed: number;
	total: number;
	duration: number;
}

export interface DownloadFile {
	type: string;
	filename: string;
	url: string;
	fileSize: number;
	fileExpectedSize: number;
	fileStatus: string;
}

export enum DownloadStatus {
	Success = 1,
	Failed = 2,
	Downloading = 3,
}

export interface DownloadData {
	id: string;
	author: string;
	authorId: string;
	desc: string;
	state: DownloadStatus;
	stateMessage: string;
	files: DownloadFile[];
	dataJson: Record<string, unknown>;
}

export interface DownloadRecord {
	id: number;
	post_id: string;
	author: string;
	author_id: string;
	desc: string;
	state: number;
	state_message: string;
	files: DownloadFile[];
	data_json: Record<string, unknown>;
	created_at: string;
}

export interface SiteMeta {
	label: string;
	icon: string;
	color: string;
	enabled?: boolean;
}

export interface SiteInfo {
	name: string;
	label: string;
	icon: string;
	color: string;
	enabled: boolean;
	cookieField: CookieField;
}

export interface CookieField {
	label: string;
	placeholder: string;
	required: boolean;
}

export interface FetchItem {
	id: string;
	type: number;
	desc: string;
	author: string;
	author_id: number;
	[key: string]: unknown;
}

export interface GlobalConfig {
	port: number;
	downloadDir: string;
	dbPath: string;
	maxConcurrent: number;
	chromePath: string;
}
