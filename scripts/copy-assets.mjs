import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairs = [
	['src/web/templates', 'dst/web/templates'],
	['src/web/public', 'dst/web/public'],
	['src/web/locales', 'dst/web/locales']
];

for (const [from, to] of pairs) {
	const source = path.join(root, from);
	const target = path.join(root, to);
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(source, target, { recursive: true });
}
