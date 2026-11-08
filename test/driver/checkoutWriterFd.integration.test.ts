import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { runReviewLoop } from '../../src/plans/review-loop.js';
import { slotFixture } from '../ops/review/slotOwnership.helpers.js';

const fixturePath = fileURLToPath(import.meta.resolve('./fixtures/checkout-writer-owner.ts'));
const loader = resolve('test/helpers/ts-source-loader.mjs');
test.each(['gh', 'managed', 'acp', 'argv', 'shell', 'effects', 'terminal', 'bulk'] as const)(
  'parent SIGKILL retains slot until controlled child closes: %s (mutation: omit boundary descriptor append; SIGSTOP regression)',
  async (boundary) => {
    const f = await slotFixture();
    const socketPath = join(f.root, 'fd.sock');
    let connection: Socket | undefined;
    const server = createServer();
    server.listen(socketPath);
    await once(server, 'listening');
    const probe = join(f.root, 'probe.cjs');
    await writeFile(
      probe,
      `const fs=require('node:fs'),net=require('node:net');
      const fds=[];for(let fd=3;fd<16;fd++){try{const s=fs.fstatSync(fd);if(s.isFile())fds.push([fd,s.dev,s.ino]);}catch{}}
      const socket=net.createConnection(process.argv[2],()=>socket.write(JSON.stringify({pid:process.pid,fds})+'\\n'));
      socket.once('data',()=>{for(const [fd] of fds)fs.closeSync(fd);socket.end('released');process.exitCode=0;});`,
    );
    const env = { ...process.env };
    if (boundary === 'bulk') {
      const bin = join(f.root, 'bin');
      await mkdir(bin);
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const wrapper = join(bin, 'git');
      await writeFile(
        wrapper,
        `#!${process.execPath}\nconst cp=require('node:child_process');
        if(process.argv.slice(2).includes('clone')){process.argv=[process.execPath,${JSON.stringify(probe)},${JSON.stringify(socketPath)}];require(${JSON.stringify(probe)});}
        else{const r=cp.spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);}`,
      );
      await chmod(wrapper, 0o755);
      env.PATH = bin + ':' + env.PATH;
    }
    if (boundary === 'terminal') await f.resolve(f.prs[0]);
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        loader,
        fixturePath,
        f.repo.root,
        f.common,
        f.worktreeRoot,
        boundary,
        probe,
        socketPath,
        f.prs[0].headRefOid,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (s: Buffer) => {
      errors += s.toString();
    });
    const closed = once(child, 'close');
    let orphanPid: number | undefined;
    try {
      const connected = await Promise.race([
        once(server, 'connection'),
        closed.then(() => {
          throw new Error('owner exited: ' + errors);
        }),
      ]);
      connection = connected[0] as Socket;
      const data: unknown = (await once(connection, 'data'))[0];
      const ready = JSON.parse(String(data)) as {
        pid: number;
        fds: Array<[number, number, number]>;
      };
      orphanPid = ready.pid;
      const directory = join(f.common, 'cq-review/slots');
      const held = await Promise.all(
        (await readdir(directory))
          .filter((n) => n.endsWith('.lock'))
          .map(async (n) => {
            const s = await stat(join(directory, n));
            return [s.dev, s.ino];
          }),
      );
      expect(ready.fds.map(([, dev, ino]) => [dev, ino]).sort()).toEqual(held.sort());
      // Suspension is never a reclaim signal, even while a real writer is paused.
      child.kill('SIGSTOP');
      try {
        await expect(runReviewLoop(f.opts())).rejects.toThrow(/busy/i);
      } finally {
        child.kill('SIGCONT');
      }
      child.kill('SIGKILL');
      await closed;
      await expect(runReviewLoop(f.opts())).rejects.toThrow(/busy/i);
      const released = once(connection, 'data');
      connection.write('release');
      await released;
      await expect(runReviewLoop(f.opts())).rejects.toThrow(/incomplete/i);
    } finally {
      child.kill('SIGKILL');
      await closed;
      if (orphanPid) {
        try {
          process.kill(orphanPid, 'SIGKILL');
        } catch {
          /* The exact owned child already exited. */
        }
      }
      connection?.destroy();
      server.close();
      await f.repo.cleanup();
    }
  },
);
