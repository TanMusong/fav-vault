import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config/manager';
import type { Task, DownloadData, DownloadRecord, DownloadFile } from '../../types';

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let rootDb: Database.Database;
const taskDbs = new Map<string, Database.Database>();

interface DbRow {
	id: string;
	name: string;
	user_id: string;
	site: string;
	paused: number;
	interval: number;
	cookies: string;
	custom_config_json: string;
	next_run: string | null;
	last_state: number;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function init(): void {
	ensureDir(config.dbPath);
	const rootDbPath = path.join(config.dbPath, 'tasks.db');
	rootDb = new Database(rootDbPath);
	rootDb.pragma('journal_mode = WAL');
	rootDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT DEFAULT '',
      site TEXT NOT NULL,
      paused INTEGER DEFAULT 0,
      interval INTEGER DEFAULT 1800,
      cookies TEXT DEFAULT '',
      custom_config_json TEXT DEFAULT '{}',
      next_run TEXT,
      last_state INTEGER DEFAULT 0
    );
  `);

	rootDb.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL DEFAULT 'error',
      time TEXT DEFAULT (datetime('now')),
      task_id TEXT DEFAULT '',
      message TEXT NOT NULL
    );
  `);

	// Migration: drop old columns if they exist
	const cols = (rootDb.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
	if (cols.includes('enabled')) rootDb.exec('ALTER TABLE tasks DROP COLUMN enabled');
	if (cols.includes('created_at')) rootDb.exec('ALTER TABLE tasks DROP COLUMN created_at');
	if (cols.includes('last_run')) rootDb.exec('ALTER TABLE tasks DROP COLUMN last_run');
	if (cols.includes('last_result')) rootDb.exec('ALTER TABLE tasks DROP COLUMN last_result');
	if (!cols.includes('user_id')) rootDb.exec("ALTER TABLE tasks ADD COLUMN user_id TEXT DEFAULT ''");
}

function getTaskDb(taskId: string): Database.Database {
	if (!taskDbs.has(taskId)) {
		const dbDir = path.join(config.dbPath, taskId);
		ensureDir(dbDir);
		const dbFilePath = path.join(dbDir, 'downloads.db');
	const db = new Database(dbFilePath);
	db.pragma('journal_mode = WAL');
	db.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT,
        author TEXT,
        author_id TEXT,
        desc TEXT,
        state INTEGER DEFAULT 0,
        state_message TEXT DEFAULT '',
        files_json TEXT DEFAULT '[]',
        data_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
	// Migration: old table used id TEXT PRIMARY KEY (post_id as key)
	const cols = (db.prepare("PRAGMA table_info(downloads)").all() as Array<{ name: string }>).map(c => c.name);
	if (cols.includes('id') && !cols.includes('post_id')) {
		db.exec('ALTER TABLE downloads RENAME TO downloads_old');
		db.exec(`
      CREATE TABLE downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id TEXT,
        author TEXT,
        author_id TEXT,
        desc TEXT,
        state INTEGER DEFAULT 0,
        state_message TEXT DEFAULT '',
        files_json TEXT DEFAULT '[]',
        data_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
		db.exec('INSERT INTO downloads (post_id, author, author_id, desc, state, state_message, files_json, data_json, created_at) SELECT id, author, author_id, desc, state, state_message, files_json, data_json, created_at FROM downloads_old');
		db.exec('DROP TABLE downloads_old');
	}
	taskDbs.set(taskId, db);
	}
	return taskDbs.get(taskId)!;
}

function closeTaskDb(taskId: string): void {
	const db = taskDbs.get(taskId);
	if (db) {
		db.close();
		taskDbs.delete(taskId);
	}
}

function mapRowToTask(row: DbRow, downloadCount?: number): Task {
	return {
		id: row.id,
		name: row.name,
		userId: row.user_id || '',
		site: row.site,
		paused: !!row.paused,
		interval: row.interval,
		cookies: row.cookies,
		customConfigJson: safeJsonParse<Record<string, unknown>>(row.custom_config_json, {}),
		next_run: row.next_run,
		last_state: row.last_state,
		nextRun: row.next_run,
		downloadCount
	};
}

function getTasks(): Task[] {
	const rows = rootDb.prepare('SELECT * FROM tasks ORDER BY next_run DESC').all() as DbRow[];
	return rows.map(row => {
		const db = getTaskDb(row.id);
		const countRow = db.prepare('SELECT COUNT(*) as c FROM downloads').get() as Record<string, unknown>;
		return mapRowToTask(row, countRow.c as number);
	});
}

function getTask(id: string): Task | null {
	const row = rootDb.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as DbRow | undefined;
	if (!row) return null;
	const db = getTaskDb(id);
	const countRow = db.prepare('SELECT COUNT(*) as c FROM downloads').get() as Record<string, unknown>;
	return mapRowToTask(row, countRow.c as number);
}

function addTask(data: { name: string; site: string; interval?: number; cookies: string; customConfigJson?: Record<string, unknown>; userId?: string }): Task {
	const id = crypto.randomUUID();
	rootDb.prepare('INSERT INTO tasks (id, name, user_id, site, interval, cookies, custom_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, data.name || 'Unnamed', data.userId || '', data.site, data.interval || 1800, data.cookies || '', JSON.stringify(data.customConfigJson || {}));
	return getTask(id)!;
}

function updateTask(id: string, data: Partial<{ name: string; userId: string; interval: number; cookies: string; customConfigJson: Record<string, unknown> }>): Task | null {
	const fields: string[] = [];
	const values: unknown[] = [];
	if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
	if (data.userId !== undefined) { fields.push('user_id = ?'); values.push(data.userId); }
	if (data.interval !== undefined) { fields.push('interval = ?'); values.push(data.interval); }
	if (data.cookies !== undefined) { fields.push('cookies = ?'); values.push(data.cookies); }
	if (data.customConfigJson !== undefined) { fields.push('custom_config_json = ?'); values.push(JSON.stringify(data.customConfigJson)); }
	if (fields.length === 0) return getTask(id);
	values.push(id);
	rootDb.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
	return getTask(id);
}

function setTaskRunState(id: string, state: { last_state?: number; nextRun?: string | null }): void {
	const fields: string[] = [];
	const values: unknown[] = [];
	if (state.last_state !== undefined) { fields.push('last_state = ?'); values.push(state.last_state); }
	if ('nextRun' in state) { fields.push('next_run = ?'); values.push(state.nextRun); }
	if (fields.length === 0) return;
	values.push(id);
	rootDb.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function deleteTask(id: string): void {
	closeTaskDb(id);
	const dbDir = path.join(config.dbPath, id);
	if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
	rootDb.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

function addDownload(taskId: string, data: DownloadData): void {
	const db = getTaskDb(taskId);
	db.prepare('INSERT INTO downloads (post_id, author, author_id, desc, state, state_message, files_json, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(data.id, data.author, data.authorId, data.desc, data.state, data.stateMessage, JSON.stringify(data.files || []), JSON.stringify(data.dataJson || {}));
}

function updateDownload(taskId: string, postId: string, data: { state?: number; stateMessage?: string; files?: DownloadFile[] }): void {
	const db = getTaskDb(taskId);
	const fields: string[] = [];
	const values: unknown[] = [];
	if (data.state !== undefined) { fields.push('state = ?'); values.push(data.state); }
	if (data.stateMessage !== undefined) { fields.push('state_message = ?'); values.push(data.stateMessage); }
	if (data.files !== undefined) { fields.push('files_json = ?'); values.push(JSON.stringify(data.files)); }
	if (fields.length === 0) return;
	values.push(postId);
	db.prepare(`UPDATE downloads SET ${fields.join(', ')} WHERE post_id = ? AND id = (SELECT id FROM downloads WHERE post_id = ? ORDER BY id DESC LIMIT 1)`).run(...values, postId);
}

function fixStaleDownloading(taskId: string): number {
	const db = getTaskDb(taskId);
	const result = db.prepare('UPDATE downloads SET state = 2, state_message = ? WHERE state = 3').run('status.interrupted');
	return result.changes;
}

interface DownloadDbRow {
	id: number;
	post_id: string;
	author: string;
	author_id: string;
	desc: string;
	state: number;
	state_message: string;
	files_json: string;
	data_json: string;
	created_at: string;
}

function getDownloads(taskId: string): DownloadRecord[] {
	const db = getTaskDb(taskId);
	return db.prepare('SELECT * FROM downloads ORDER BY created_at DESC').all().map((row) => {
		const r = row as DownloadDbRow;
		return {
			id: r.id,
			post_id: r.post_id,
			author: r.author,
			author_id: r.author_id,
			desc: r.desc,
			state: r.state,
			state_message: r.state_message,
			files: safeJsonParse<DownloadFile[]>(r.files_json, []),
			data_json: safeJsonParse<Record<string, unknown>>(r.data_json, {}),
			created_at: r.created_at
		};
	});
}

function clearDownloads(taskId: string): void {
	const db = getTaskDb(taskId);
	db.prepare('DELETE FROM downloads').run();
}

function hasPostDownload(taskId: string, postId: string): boolean {
	if (!postId) return false;
	const db = getTaskDb(taskId);
	const row = db.prepare('SELECT 1 FROM downloads WHERE post_id = ? LIMIT 1').get(postId);
	return !!row;
}

function hasSuccessfulDownload(taskId: string, postId: string): boolean {
	if (!postId) return false;
	const db = getTaskDb(taskId);
	const row = db.prepare('SELECT 1 FROM downloads WHERE post_id = ? AND state = ? LIMIT 1').get(postId, 1);
	return !!row;
}

function toggleTaskPause(taskId: string): boolean {
	const task = getTask(taskId);
	if (!task) return false;
	const newPaused = task.paused ? 0 : 1;
	rootDb.prepare('UPDATE tasks SET paused = ? WHERE id = ?').run(newPaused, taskId);
	return !!newPaused;
}

function getAllLogs(limit = 50, offset = 0, level?: string): { total: number; items: Array<{ id: number; level: string; time: string; message: string; taskName: string }> } {
	const whereClause = level ? ' WHERE l.level = ?' : '';
	const countSql = 'SELECT COUNT(*) as c FROM logs l' + whereClause;
	const querySql = 'SELECT l.id, l.level, l.time, l.message, t.name as taskName FROM logs l LEFT JOIN tasks t ON l.task_id = t.id' + whereClause + ' ORDER BY l.id DESC LIMIT ? OFFSET ?';
	const total = level
		? (rootDb.prepare(countSql).get(level) as Record<string, number>).c
		: (rootDb.prepare(countSql).get() as Record<string, number>).c;
	const rows = level
		? rootDb.prepare(querySql).all(level, limit, offset) as Array<{ id: number; level: string; time: string; message: string; taskName: string | null }>
		: rootDb.prepare(querySql).all(limit, offset) as Array<{ id: number; level: string; time: string; message: string; taskName: string | null }>;
	return { total, items: rows.map(r => ({ ...r, taskName: r.taskName || '' })) };
}

function addLog(taskId: string, level: string, message: string): void {
	rootDb.prepare('INSERT INTO logs (level, task_id, message) VALUES (?, ?, ?)').run(level, taskId, message);
}

function getLogs(taskId: string, limit = 100, offset = 0): { total: number; items: Array<{ id: number; level: string; time: string; message: string }> } {
	const total = (rootDb.prepare('SELECT COUNT(*) as c FROM logs WHERE task_id = ?').get(taskId) as Record<string, number>).c;
	const items = rootDb.prepare('SELECT * FROM logs WHERE task_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(taskId, limit, offset) as Array<{ id: number; level: string; time: string; message: string }>;
	return { total, items };
}

function clearLogs(): void {
	rootDb.prepare('DELETE FROM logs').run();
}

export type { Task, DownloadData, DownloadRecord, DownloadFile };
export { init, getTasks, getTask, addTask, updateTask, setTaskRunState, deleteTask, addDownload, updateDownload, fixStaleDownloading, getDownloads, clearDownloads, hasPostDownload, hasSuccessfulDownload, toggleTaskPause, addLog, getLogs, getAllLogs, clearLogs };
