// Split provenance: test/api-report.test.mjs was split into test/api-report.<subject>.test.mjs files.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixture(exports) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cq-api-report-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', exports }));
  await mkdir(path.join(root, 'dist'), { recursive: true });
  return root;
}
