import fs from 'fs';
import path from 'path';

const REGISTRY_PATH = path.join(__dirname, 'sites');
const sites = new Map<string, import('./sites/base').default>();

function register(site: import('./sites/base').default): void {
	sites.set(site.name, site);
}

function getSite(name: string): import('./sites/base').default | undefined {
	return sites.get(name);
}

function getAllSites(): Array<{ name: string; label: string; icon: string; color: string; enabled: boolean; cookieField: { label: string; placeholder: string; required: boolean } }> {
	const result: Array<{ name: string; label: string; icon: string; color: string; enabled: boolean; cookieField: { label: string; placeholder: string; required: boolean } }> = [];
	sites.forEach(s => {
		result.push({
			name: s.name,
			label: s.meta.label,
			icon: s.meta.icon,
			color: s.meta.color,
			enabled: s.enabled,
			cookieField: s.getCookieField()
		});
	});
	return result;
}

function init(): void {
	const entries = fs.readdirSync(REGISTRY_PATH, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory() && entry.name !== '__pycache__') {
			const indexFile = path.join(REGISTRY_PATH, entry.name, 'index.js');
			if (fs.existsSync(indexFile)) {
				const site = require(indexFile).default;
				register(site);
			}
		}
	}
	const names: string[] = [];
	sites.forEach((_, k) => names.push(k));
	console.log(`Registered sites: ${names.join(', ')}`);
}

export { init, register, getSite, getAllSites };
