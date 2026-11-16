import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getCurrentPath } from '../../lib/utils/helpers';

const __dirname = getCurrentPath(import.meta.url);
const repoRoot = path.join(__dirname, '../..');

const allowedOutsideLib: ReadonlySet<string> = new Set(['test/twitter-client-transaction-id.test.ts']);

export const findOrphanFiles = async (root: string = repoRoot): Promise<string[]> => {
    const folders = ['lib', 'spec', 'specs', 'test', 'tests'].filter((folder) => existsSync(path.join(root, folder)));
    const entries = (await Promise.all(folders.map((folder) => fs.readdir(path.join(root, folder), { recursive: true, withFileTypes: true })))).flat();
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));

    const candidates = entries
        .filter((entry) => entry.isFile() && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name))
        .map((entry) => {
            const absolute = path.join(entry.parentPath, entry.name);
            return { absolute, relative: path.relative(root, absolute).replaceAll('\\', '/') };
        })
        .filter(({ relative }) => relative.startsWith('lib/') && relative !== 'lib/setup.test.ts');

    const orphans = candidates
        .map(({ absolute, relative }) => {
            if (relative.startsWith('lib/routes/')) {
                return relative;
            }
            const dir = path.dirname(absolute);
            const base = path.basename(absolute).replace(/(?:\.worker)?\.(?:spec|test)\.[cm]?[jt]sx?$/, '');
            const exists = entries.some((entry) => entry.parentPath === dir && entry.isFile() && new RegExp(`^${base.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?:\\.worker)?\\.[cm]?[jt]sx?$`).test(entry.name));
            return exists ? null : relative;
        })
        .filter((relative) => relative !== null);

    const deprecated = files.filter((relative) => (!relative.startsWith('lib/') && !allowedOutsideLib.has(relative)) || relative.startsWith('lib/routes-deprecated/'));

    return [...orphans, ...deprecated];
};
