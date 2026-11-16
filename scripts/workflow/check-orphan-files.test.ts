import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findOrphanFiles } from './check-orphan-files';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(files: string[]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsshub-orphans-'));
    roots.push(root);
    await Promise.all(
        files.map(async (file) => {
            await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
            await fs.writeFile(path.join(root, file), '');
        })
    );
    return root;
}

describe('findOrphanFiles', () => {
    it('accepts the real repository including the discovered root Twitter test', async () => {
        expect(await findOrphanFiles()).toEqual([]);
    });
    it('exempts exactly the existing root Twitter test', async () => {
        const root = await fixture(['test/twitter-client-transaction-id.test.ts', 'test/other.test.ts', 'tests/file.ts', 'spec/file.ts', 'specs/file.ts']);
        expect((await findOrphanFiles(root)).sort()).toEqual(['spec/file.ts', 'specs/file.ts', 'test/other.test.ts', 'tests/file.ts']);
    });
    it('preserves source, route, deprecated and setup rules', async () => {
        const root = await fixture([
            'lib/a.ts',
            'lib/a.test.ts',
            'lib/b.worker.ts',
            'lib/b.worker.test.ts',
            'lib/setup.test.ts',
            'lib/orphan.test.ts',
            'lib/routes/example/index.ts',
            'lib/routes/example/index.test.ts',
            'lib/routes-deprecated/old.ts',
        ]);
        expect((await findOrphanFiles(root)).sort()).toEqual(['lib/orphan.test.ts', 'lib/routes-deprecated/old.ts', 'lib/routes/example/index.test.ts']);
    });
});
