import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { AcpSpawnFn, AcpSpawnOptions } from '../../src/driver/acp/process.js';
import type {
  ManagedChild,
  ProcessClose,
  SpawnOptions,
} from '../../src/driver/subprocess/process.js';
import type { SpawnFn } from '../../src/driver/subprocess/index.js';

export type JsonLineFrame = Record<string, unknown>;

export interface JsonLinePeer {
  send(frame: JsonLineFrame): void;
  stderr(line: string): void;
  finish(code?: number | null, signal?: NodeJS.Signals | null): void;
}

export type JsonLineScript = (frame: JsonLineFrame, peer: JsonLinePeer) => void;

/** A deterministic tool outcome used only by conformance scripts. */
export async function runFakeTool(
  cwd: string,
  tool: string,
  input: unknown,
): Promise<{ ok: boolean; text: string }> {
  const value = input as {
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
    command?: unknown;
  };
  if (tool === 'run' && typeof value.command === 'string') {
    const match = /^echo\s+(.+?)\s+>\s+(.+)$/.exec(value.command);
    if (match === null) return { ok: false, text: 'run refused: unsupported command' };
    const target = resolve(cwd, match[2] as string);
    if (isOutside(cwd, target)) return { ok: false, text: 'path escape: outside workspace' };
    await writeFile(target, `${match[1] as string}\n`, 'utf8');
    return { ok: true, text: 'command completed' };
  }
  if (tool === 'edit' && typeof value.path === 'string') {
    const target = resolve(cwd, value.path);
    if (isOutside(cwd, target)) return { ok: false, text: 'path escape: outside workspace' };
    const oldText = typeof value.oldText === 'string' ? value.oldText : '';
    const newText = typeof value.newText === 'string' ? value.newText : '';
    try {
      const current = await readFile(target, 'utf8');
      if (!current.includes(oldText))
        return { ok: false, text: 'edit refused: old text not found' };
      await writeFile(target, current.replace(oldText, newText), 'utf8');
      return { ok: true, text: 'edit completed' };
    } catch {
      return { ok: false, text: `file not found: ${value.path}` };
    }
  }
  if (tool === 'read' && typeof value.path === 'string') {
    const target = resolve(cwd, value.path);
    if (isOutside(cwd, target)) return { ok: false, text: 'path escape: outside workspace' };
    try {
      return { ok: true, text: await readFile(target, 'utf8') };
    } catch {
      return { ok: false, text: `file not found: ${value.path}` };
    }
  }
  return { ok: false, text: `tool refused: ${tool}` };
}

function isOutside(root: string, target: string): boolean {
  const path = relative(resolve(root), target);
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

interface PeerParts {
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly finish: (code?: number | null, signal?: NodeJS.Signals | null) => void;
}

function createLinePeer(
  script: JsonLineScript,
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void,
): PeerParts {
  let input = '';
  let closed = false;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const peer: JsonLinePeer = {
    send(frame) {
      if (!closed) stdout.write(`${JSON.stringify(frame)}\n`);
    },
    stderr(line) {
      if (!closed) stderr.write(`${line}\n`);
    },
    finish(code = 0, signal = null) {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      setImmediate(() => onClose(code, signal));
    },
  };
  const stdin = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      if (!closed) {
        input += chunk.toString();
        let newline = input.indexOf('\n');
        while (newline !== -1) {
          const line = input.slice(0, newline).trim();
          input = input.slice(newline + 1);
          if (line !== '') {
            try {
              script(JSON.parse(line) as JsonLineFrame, peer);
            } catch (error: unknown) {
              stderr.write(`fake transport script error: ${String(error)}\n`);
              peer.finish(1);
              break;
            }
          }
          newline = input.indexOf('\n');
        }
      }
      callback();
    },
  });
  return { stdin, stdout, stderr, finish: peer.finish };
}

export function fakeAcpSpawn(scriptFactory: (opts: AcpSpawnOptions) => JsonLineScript): AcpSpawnFn {
  return (opts) => {
    const child = new EventEmitter() as ChildProcess & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      pid: number;
      kill(signal?: NodeJS.Signals): boolean;
    };
    let closed = false;
    const parts = createLinePeer(scriptFactory(opts), (code, signal) => {
      closed = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('close', code, signal);
    });
    child.stdin = parts.stdin;
    child.stdout = parts.stdout;
    child.stderr = parts.stderr;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 4242;
    child.kill = (signal: NodeJS.Signals = 'SIGTERM'): boolean => {
      if (closed) return false;
      parts.finish(null, signal);
      return true;
    };
    return child;
  };
}

export function fakeManagedSpawn(scriptFactory: (opts: SpawnOptions) => JsonLineScript): SpawnFn {
  return (opts) => {
    const stdoutListeners: Array<(line: string) => void> = [];
    const stderrListeners: Array<(line: string) => void> = [];
    let stdoutText = '';
    let stderrText = '';
    let closed = false;
    let resolveClose!: (close: ProcessClose) => void;
    const close = new Promise<ProcessClose>((resolve) => {
      resolveClose = resolve;
    });
    const parts = createLinePeer(scriptFactory(opts), (code, signal) => {
      if (closed) return;
      closed = true;
      resolveClose({ code, signal, stdout: stdoutText, stderr: stderrText, droppedBytes: 0 });
    });
    parts.stdout.on('data', (chunk: Buffer | string) => {
      stdoutText += chunk.toString();
    });
    parts.stderr.on('data', (chunk: Buffer | string) => {
      stderrText += chunk.toString();
    });
    const emitLines = (stream: PassThrough, listeners: Array<(line: string) => void>): void => {
      let buffer = '';
      stream.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          for (const listener of listeners) listener(line);
          newline = buffer.indexOf('\n');
        }
      });
      stream.once('end', () => {
        if (buffer !== '') for (const listener of listeners) listener(buffer);
      });
    };
    emitLines(parts.stdout, stdoutListeners);
    emitLines(parts.stderr, stderrListeners);
    if (opts.stdin !== undefined) {
      queueMicrotask(() =>
        parts.stdin.write(`${JSON.stringify({ method: 'stdin', params: { data: opts.stdin } })}\n`),
      );
    }
    return {
      pid: 4242,
      close,
      get exited() {
        return closed;
      },
      onStdoutLine(listener) {
        stdoutListeners.push(listener);
      },
      onStderrLine(listener) {
        stderrListeners.push(listener);
      },
      writeStdin(chunk) {
        parts.stdin.write(chunk);
      },
      endStdin() {
        parts.stdin.end();
      },
      kill(signal) {
        if (closed) return false;
        parts.finish(null, signal);
        return true;
      },
    } satisfies ManagedChild;
  };
}
