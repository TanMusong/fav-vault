import { getGlobal } from './core/config/manager';
import * as store from './core/db/store';
import './core/browser/registry';
import express from 'express';
import { setupRoutes } from './web/routes';
import { startAll } from './core/scheduler/scheduler';
import { init as initRegistry } from './core/browser/registry';

store.init();
initRegistry();

// Fix stale downloading records on startup
const tasks = store.getTasks();
for (const t of tasks) {
	const fixed = store.fixStaleDownloading(t.id);
	if (fixed > 0) console.log(`[startup] Fixed ${fixed} stale downloading record(s) for task "${t.name}"`);
}

const app = express();
const PORT = getGlobal().port;

setupRoutes(app);

startAll();
app.listen(PORT, () => {
	console.log(`fav-vault running at http://localhost:${PORT}`);
});
