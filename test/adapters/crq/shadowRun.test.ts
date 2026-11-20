import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifySample,
  compareArtefacts,
  freezeStateRoot,
  identical,
  liveUnchanged,
  summarize,
  type Artefacts,
} from '../../../src/adapters/crq/shadowRun.js';

const PIN = '2027-01-15T08:00:00Z';
const scratch = (): string => mkdtempSync(join(tmpdir(), 'shadow-'));

function root(files: Record<string, string>): string {
  const dir = scratch();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const art = (dir: string, calls: string[] = ['admit'], slot = ''): Artefacts => ({
  root: dir,
  phaseCalls: calls,
  slotDecision: slot,
});

describe('freezeStateRoot', () => {
  it('copies the files into two byte-identical scratch roots and leaves the source alone', () => {
    const live = root({ 'queue.json': '{"items":[]}', 'config.json': '{}' });
    const frozen = freezeStateRoot(live, scratch());
    for (const dir of [frozen.a, frozen.b]) {
      expect(readFileSync(join(dir, 'queue.json'), 'utf8')).toBe('{"items":[]}');
      expect(existsSync(join(dir, 'runner-disabled'))).toBe(false);
    }
    expect(frozen.liveDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(liveUnchanged(live, frozen)).toBe(true);
    expect(readFileSync(join(live, 'queue.json'), 'utf8')).toBe('{"items":[]}');
  });

  it('preserves absence when the destination scratch root retains a stale file', () => {
    const live = root({ 'queue.json': '{"items":[]}' });
    const stale = scratch();
    for (const side of ['a', 'b']) {
      mkdirSync(join(stale, side), { recursive: true });
      writeFileSync(join(stale, side, 'runner-disabled'), 'stale\n');
    }
    const frozen = freezeStateRoot(live, stale);
    for (const dir of [frozen.a, frozen.b]) {
      expect(existsSync(join(dir, 'runner-disabled'))).toBe(false);
      expect(readFileSync(join(dir, 'queue.json'), 'utf8')).toBe('{"items":[]}');
    }
  });

  it('rejects a scratch destination that overlaps the live root', () => {
    const parent = scratch();
    const live = join(parent, 'a');
    mkdirSync(live);
    writeFileSync(join(live, 'queue.json'), '{"items":[]}');
    // `join(scratch, 'a')` would resolve to the live root itself.
    expect(() => freezeStateRoot(live, parent)).toThrow(/overlaps the live root/);
    expect(() => freezeStateRoot(live, live)).toThrow(/overlaps the live root/);
    expect(() => freezeStateRoot(live, join(live, 'nested'))).toThrow(/overlaps the live root/);
    // The live queue was never rewritten, and nothing was written into the live root.
    expect(readFileSync(join(live, 'queue.json'), 'utf8')).toBe('{"items":[]}');
    expect(existsSync(join(live, 'a'))).toBe(false);
  });

  it('rejects a scratch destination that aliases the live root through .. or a symlink', () => {
    const parent = scratch();
    const live = join(parent, 'live');
    const elsewhere = join(parent, 'elsewhere');
    mkdirSync(live);
    mkdirSync(elsewhere);
    writeFileSync(join(live, 'queue.json'), '{"items":[]}');
    expect(() => freezeStateRoot(live, join(elsewhere, '..', 'live'))).toThrow(
      /overlaps the live root/,
    );
    const alias = join(elsewhere, 'alias');
    symlinkSync(live, alias);
    expect(() => freezeStateRoot(live, alias)).toThrow(/overlaps the live root/);
  });

  it('refuses a symlinked scratch destination file without writing through it', () => {
    const live = root({ 'queue.json': '{"items":[]}', 'config.json': '{"k":1}' });
    const stale = scratch();
    const outside = join(scratch(), 'victim.json');
    writeFileSync(outside, 'untouched');
    mkdirSync(join(stale, 'a'), { recursive: true });
    symlinkSync(outside, join(stale, 'a', 'config.json'));
    expect(() => freezeStateRoot(live, stale)).toThrow(/symbolic link/);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  });

  it('still accepts a sibling scratch root that merely shares a name prefix', () => {
    const parent = scratch();
    const live = join(parent, 'a');
    mkdirSync(live);
    writeFileSync(join(live, 'queue.json'), '{"items":[]}');
    const frozen = freezeStateRoot(live, join(parent, 'ab'));
    expect(readFileSync(join(frozen.a, 'queue.json'), 'utf8')).toBe('{"items":[]}');
  });

  it('notices a live queue change and treats an absent queue as stable', () => {
    const live = root({ 'queue.json': '{}' });
    const frozen = freezeStateRoot(live, scratch());
    writeFileSync(join(live, 'queue.json'), '{"x":1}');
    expect(liveUnchanged(live, frozen)).toBe(false);
    const empty = root({});
    expect(liveUnchanged(empty, freezeStateRoot(empty, scratch()))).toBe(true);
  });
});

describe('compareArtefacts', () => {
  it('ignores queue key order and 1 == 1.0', () => {
    const a = root({ 'queue.json': '{"a":1,"b":[2]}' });
    const b = root({ 'queue.json': '{"b":[2],"a":1.0}' });
    expect(compareArtefacts(art(a), art(b), PIN).queue).toBe('same');
  });

  it('flags a queue value difference and a missing side', () => {
    const a = root({ 'queue.json': '{"a":1}' });
    const b = root({ 'queue.json': '{"a":2}' });
    expect(compareArtefacts(art(a), art(b), PIN).queue).toBe('differs');
    expect(compareArtefacts(art(a), art(root({})), PIN).queue).toBe('missing-b');
    expect(compareArtefacts(art(root({})), art(b), PIN).queue).toBe('missing-a');
  });

  it('compares events after normalising the pinned clock', () => {
    const a = root({ 'events.jsonl': `{"at":"${PIN}","kind":"x"}\n` });
    const b = root({ 'events.jsonl': '{"kind":"x","at":"2027-01-15T08:00:00+00:00"}\n' });
    expect(compareArtefacts(art(a), art(b), PIN).events).toEqual({ verdict: 'same' });
  });

  it('reports the first differing event line and a length mismatch', () => {
    const a = root({ 'events.jsonl': '{"k":1}\n{"k":2}\n' });
    const b = root({ 'events.jsonl': '{"k":1}\n{"k":3}\n' });
    expect(compareArtefacts(art(a), art(b), PIN).events).toEqual({ verdict: 'differs', line: 2 });
    const c = root({ 'events.jsonl': '{"k":1}\n' });
    expect(compareArtefacts(art(a), art(c), PIN).events).toEqual({ verdict: 'differs', line: 2 });
  });

  it('keeps an unpinned drifting clock visible', () => {
    const a = root({ 'events.jsonl': `{"at":"${PIN}"}\n` });
    const b = root({ 'events.jsonl': '{"at":"2027-01-15T08:00:01Z"}\n' });
    expect(compareArtefacts(art(a), art(b), PIN).events.verdict).toBe('differs');
  });

  it('keeps sub-millisecond clock drift visible', () => {
    const a = root({ 'events.jsonl': `{"at":"${PIN}"}\n` });
    const b = root({ 'events.jsonl': '{"at":"2027-01-15T08:00:00.000001Z"}\n' });
    expect(compareArtefacts(art(a), art(b), PIN).events.verdict).toBe('differs');
  });

  it('compares the heartbeat by bytes, so key order matters', () => {
    const a = root({ 'heartbeat.json': '{"a":1,"b":2}' });
    const b = root({ 'heartbeat.json': '{"b":2,"a":1}' });
    expect(compareArtefacts(art(a), art(b), PIN).heartbeat).toBe('differs');
    expect(
      compareArtefacts(art(a), art(root({ 'heartbeat.json': '{"a":1,"b":2}' })), PIN).heartbeat,
    ).toBe('same');
  });

  it('compares phase-call order and the slot decision', () => {
    const d = root({});
    const e = root({});
    expect(compareArtefacts(art(d, ['a', 'b']), art(e, ['b', 'a']), PIN).phaseCalls).toBe(
      'differs',
    );
    expect(compareArtefacts(art(d, ['a']), art(e, ['a', 'b']), PIN).phaseCalls).toBe('differs');
    expect(compareArtefacts(art(d, [], 'x'), art(e, [], 'y'), PIN).slotDecision).toBe('differs');
    expect(identical(compareArtefacts(art(d), art(e), PIN))).toBe(true);
  });
});

describe('classifySample and summarize', () => {
  const same = compareArtefacts(art(root({})), art(root({})), PIN);
  const queueDiffers = { ...same, queue: 'differs' as const };

  it('classifies identical, explained, unexplained and aborted', () => {
    const allow = [{ id: 'migration', explains: (d: typeof same) => d.queue === 'differs' }];
    expect(classifySample('s1', same, true, allow).class).toBe('identical');
    const explained = classifySample('s2', queueDiffers, true, allow);
    expect(explained).toMatchObject({ class: 'explained', explainedBy: 'migration' });
    expect(classifySample('s3', queueDiffers, true, []).class).toBe('unexplained');
    expect(classifySample('s4', same, false, allow).class).toBe('aborted');
  });

  it('counts each class', () => {
    const reports = [
      classifySample('a', same, true, []),
      classifySample('b', queueDiffers, true, []),
      classifySample('c', queueDiffers, true, []),
      classifySample('d', same, false, []),
    ];
    expect(summarize(reports)).toEqual({ identical: 1, explained: 0, unexplained: 2, aborted: 1 });
  });
});
