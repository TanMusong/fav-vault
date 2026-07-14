import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import * as store from '../core/db/store';
import { getAllSites } from '../core/browser/registry';
import { scheduleTask, clearTask, rescheduleTask } from '../core/scheduler/scheduler';
import { verifyCredentials, isRunning } from '../core/browser/runner';
import { events } from '../core/events';
import { config, getGlobal } from '../core/config/manager';
import { resolveDownloadDir, DEFAULT_PATH_TEMPLATE } from '../core/downloader/path';

const TAG_URLS = [
	'https://gh-proxy.org/https://api.github.com/repos/TanMusong/fav-vault/tags?per_page=1',
	'https://v4.gh-proxy.org/https://api.github.com/repos/TanMusong/fav-vault/tags?per_page=1',
	'https://v6.gh-proxy.org/https://api.github.com/repos/TanMusong/fav-vault/tags?per_page=1',
	'https://cdn.gh-proxy.org/https://api.github.com/repos/TanMusong/fav-vault/tags?per_page=1',
	'https://api.github.com/repos/TanMusong/fav-vault/tags?per_page=1'
];

function compareSemver(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na > nb) return 1;
		if (na < nb) return -1;
	}
	return 0;
}

interface VersionCache { latest: string; checkedAt: number; }
let versionCache: VersionCache | null = null;
const VERSION_CACHE_TTL = 3600000;

function getLocalVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
		return pkg.version || '0.0.0';
	} catch { return '0.0.0'; }
}

async function fetchLatestTag(): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const results = await Promise.allSettled(TAG_URLS.map(url =>
			fetch(url, { signal: controller.signal }).then(r => {
				if (!r.ok) throw new Error('not ok');
				return r.json();
			})
		));
		clearTimeout(timer);
		for (const r of results) {
			if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
				const latest = r.value[0]?.name?.replace(/^v/, '');
				if (latest) return latest;
			}
		}
	} catch { clearTimeout(timer); }
	return null;
}

function getId(req: Request): string {
  return Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
}

function validateDownloadPathTemplate(template: string): void {
  resolveDownloadDir(config.downloadDir, template || DEFAULT_PATH_TEMPLATE, {
    type: 'site',
    user: 'user',
    id: 'id',
    author: 'author',
    author_id: 'author_id'
  });
}

function parseTaskInterval(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 600) return null;
  return Math.floor(interval);
}

const templatesDir = path.join(__dirname, 'templates');

export function setupRoutes(app: express.Application): void {
  app.set('view engine', 'ejs');
  app.set('views', templatesDir);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/locales', express.static(path.join(__dirname, 'locales')));

  // --- SSR Pages ---

  app.get('/', (_req: Request, res: Response) => {
    const tasks = store.getTasks();
    const sites = getAllSites();
    const localVersion = getLocalVersion();
    res.render('index', { tasks, sites, localVersion });
  });

  app.get('/detail/:id', (req: Request, res: Response) => {
    const taskId = req.params.id as string;
    const task = store.getTask(taskId);
    if (!task) { res.redirect('/'); return; }
    const sites = getAllSites();
    const site = sites.find(s => s.name === task.site);
    const siteColor = site?.color || '#888';
    const siteLabel = site?.label || task.site;
    const downloads = store.getDownloads(taskId).slice(0, 20);
    const downloadsTotal = store.getDownloads(taskId).length;
    res.render('detail', { task, sites, siteColor, siteLabel, downloads, downloadsTotal });
  });

  // --- API Routes ---

  app.get('/import', (req: Request, res: Response) => {
    const cookie = typeof req.query.cookie === 'string' ? req.query.cookie : '';
    res.redirect('/?cookie=' + encodeURIComponent(cookie));
  });

  app.get('/api/sites', (_req: Request, res: Response) => {
    res.json(getAllSites());
  });

  app.get('/api/tasks', (_req: Request, res: Response) => {
    const tasks = store.getTasks().map(t => ({ ...t, cookies: t.cookies ? '***' : '' }));
    res.json(tasks);
  });

  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    const task = store.getTask(getId(req));
    if (!task) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ...task, cookies: task.cookies ? '***' : '' });
  });

  app.post('/api/tasks', async (req: Request, res: Response) => {
    const body = req.body as { site?: string; interval?: number; cookies?: string; customConfigJson?: Record<string, unknown> };
    if (!body.site) { res.status(400).json({ error: 'site required' }); return; }
    if (!body.cookies) { res.status(400).json({ error: 'cookies required' }); return; }
    const interval = parseTaskInterval(body.interval, 1800);
    if (interval === null) { res.status(400).json({ error: 'interval must be at least 600 seconds' }); return; }
    try {
      validateDownloadPathTemplate(body.customConfigJson?.downloadPath as string || DEFAULT_PATH_TEMPLATE);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const { username, userId } = await verifyCredentials(body.site, body.cookies);
      const task = store.addTask({ name: username, site: body.site, interval, cookies: body.cookies, customConfigJson: body.customConfigJson, userId });
      scheduleTask(store.getTask(task.id)!);
      store.addLog(task.id, 'info', `Task created: ${username} (${body.site})`);
      res.json(store.getTask(task.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/tasks/:id', async (req: Request, res: Response) => {
    const body = req.body as { interval?: number; cookies?: string; customConfigJson?: Record<string, unknown> };
    if (body.interval !== undefined) {
      const interval = parseTaskInterval(body.interval, 1800);
      if (interval === null) { res.status(400).json({ error: 'interval must be at least 600 seconds' }); return; }
      body.interval = interval;
    }
    if (body.customConfigJson?.downloadPath !== undefined) {
      try {
        validateDownloadPathTemplate(body.customConfigJson.downloadPath as string);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }
    if (body.cookies) {
      const task = store.getTask(getId(req));
      if (!task) { res.status(404).json({ error: 'error.not_found' }); return; }
      try {
        await verifyCredentials(task.site, body.cookies);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }
    const updated = store.updateTask(getId(req), body);
    if (!updated) { res.status(404).json({ error: 'error.not_found' }); return; }
    store.addLog(getId(req), 'info', 'Task config updated');
    rescheduleTask(updated.id);
    res.json(updated);
  });

  app.delete('/api/tasks/:id', (req: Request, res: Response) => {
    const taskId = getId(req);
    store.addLog(taskId, 'info', 'Task deleted');
    clearTask(taskId);
    store.deleteTask(taskId);
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/run', async (req: Request, res: Response) => {
    const taskId = getId(req);
    if (isRunning(taskId)) {
      store.addLog(taskId, 'warn', 'Duplicate run ignored, task already running');
      res.status(409).json({ error: 'error.task_running' }); return;
    }
    store.addLog(taskId, 'info', 'Manual run triggered');
    store.setTaskRunState(taskId, { nextRun: new Date().toISOString() });
    rescheduleTask(taskId, true);
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/pause', (req: Request, res: Response) => {
    const taskId = getId(req);
    const paused = store.toggleTaskPause(taskId);
    if (paused) {
      clearTask(taskId);
      store.setTaskRunState(taskId, { nextRun: null });
    } else {
      rescheduleTask(taskId);
    }
    store.addLog(taskId, 'info', paused ? 'Task paused' : 'Task resumed');
    events.emitTaskPaused(taskId, paused);
    res.json({ ok: true, paused });
  });

  app.post('/api/verify', async (req: Request, res: Response) => {
    const { site, cookies } = req.body as { site?: string; cookies?: string };
    if (!site || !cookies) { res.status(400).json({ ok: false, error: 'site and cookies required' }); return; }
    try {
      const { username, userId } = await verifyCredentials(site, cookies);
      res.json({ ok: true, username, userId });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/tasks/:id/downloads', (req: Request, res: Response) => {
    const offset = parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0', 10) || 0;
    const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '20', 10) || 20;
    const all = store.getDownloads(getId(req));
    res.json({ total: all.length, items: all.slice(offset, offset + limit) });
  });

  app.delete('/api/tasks/:id/downloads', (req: Request, res: Response) => {
    store.clearDownloads(getId(req));
    res.json({ ok: true });
  });

  app.get('/api/tasks/:id/logs', (req: Request, res: Response) => {
    const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10) || 50;
    const offset = parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0', 10) || 0;
    res.json(store.getLogs(getId(req), limit, offset));
  });

  app.get('/api/logs', (req: Request, res: Response) => {
    const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10) || 50;
    const offset = parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0', 10) || 0;
    const level = typeof req.query.level === 'string' && ['error', 'warn', 'info'].includes(req.query.level) ? req.query.level : undefined;
    res.json(store.getAllLogs(limit, offset, level));
  });

  app.delete('/api/logs', (_req: Request, res: Response) => {
    store.clearLogs();
    res.json({ ok: true });
  });

  app.get('/api/tasks/:id/preview/:postId/:filename', (req: Request, res: Response) => {
    const taskId = getId(req);
    const postId = req.params.postId as string;
    const filename = req.params.filename as string;
    const task = store.getTask(taskId);
    if (!task) { res.status(404).json({ error: 'task not found' }); return; }
    const downloads = store.getDownloads(taskId);
    const dl = downloads.find(d => d.post_id === postId);
    if (!dl) { res.status(404).json({ error: 'download not found' }); return; }
    const file = dl.files.find(f => f.filename === filename && f.fileStatus === 'success');
    if (!file) { res.status(404).json({ error: 'file not found' }); return; }
    const site = getAllSites().find(s => s.name === task.site);
    const pathTemplate = (task.customConfigJson as Record<string, unknown>)?.downloadPath as string || DEFAULT_PATH_TEMPLATE;
    const userDir = resolveDownloadDir(config.downloadDir, pathTemplate, {
      type: site ? site.label : task.site,
      user: task.name,
      id: task.userId || '',
      author: dl.author || 'unknown',
      author_id: dl.author_id || 'unknown'
    });
    const filePath = path.resolve(userDir, file.filename);
    const relative = path.relative(path.resolve(userDir), filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.status(400).json({ error: 'invalid filename' }); return; }
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'file not found' }); return; }
    const ext = path.extname(file.filename).toLowerCase();
    const mimeMap: Record<string, string> = { '.mp4': 'video/mp4', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/global', (_req: Request, res: Response) => {
    res.json(getGlobal());
  });

  app.get('/api/version', async (_req: Request, res: Response) => {
    const local = getLocalVersion();
    const now = Date.now();
    if (!versionCache || now - versionCache.checkedAt > VERSION_CACHE_TTL) {
      const latest = await fetchLatestTag();
      if (latest) versionCache = { latest, checkedAt: now };
    }
    const latest = versionCache?.latest || null;
    const hasUpdate = !!(latest && compareSemver(latest, local) > 0);
    res.json({ local, latest, hasUpdate });
  });

  app.get('/api/events', (req: Request, res: Response) => {
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    const eventNames = ['task:started', 'task:completed', 'task:failed', 'download:added', 'download:progress', 'scheduler:updated', 'task:paused'];

    const listeners: Array<{ event: string; handler: (data: unknown) => void }> = [];
    for (const eventName of eventNames) {
      const handler = (data: unknown) => {
        const event = data as Record<string, unknown>;
        if (taskId && event.taskId !== taskId) return;
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      listeners.push({ event: eventName, handler });
      events.on(eventName, handler);
    }

    req.on('close', () => {
      clearInterval(heartbeat);
      for (const { event, handler } of listeners) {
        events.off(event, handler);
      }
    });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[express] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
}
