import { describe, expect, test } from 'vitest';
import {
  renderServiceText,
  UNIT_COMMANDS,
  unitCommand,
  validateUnitTemplate,
  ValueError,
} from '../../../../src/ops/crq/deploy/unitRender.js';

const SHA = 'a'.repeat(40);

describe('validateUnitTemplate', () => {
  test('requires the placeholder in .service and .path only', () => {
    expect(() => validateUnitTemplate('a.service', 'x')).toThrow(
      'unit lacks monorepo root placeholder: a.service',
    );
    expect(() => validateUnitTemplate('dir/a.path', 'x')).toThrow(ValueError);
    expect(() => validateUnitTemplate('a.service', '@CRQ_ROOT@')).not.toThrow();
    expect(() => validateUnitTemplate('a.path', 'x @CRQ_ROOT@ y')).not.toThrow();
  });
  test.each(['a.timer', 'a.service.bak', '.service', 'service', 'a.Service', 'a.service/..'])(
    'ignores %s',
    (n) => {
      expect(() => validateUnitTemplate(n, 'x')).not.toThrow();
    },
  );
  test('uses the last path component and pathlib suffix rules', () => {
    expect(() => validateUnitTemplate('a.b.service', 'x')).toThrow(ValueError);
    expect(() => validateUnitTemplate('x..service', 'x')).toThrow(ValueError);
    expect(() => validateUnitTemplate('d.service/', 'x')).toThrow(ValueError);
    expect(() => validateUnitTemplate('d.service/sub', 'x')).not.toThrow();
  });
});

describe('unitCommand', () => {
  test('python keeps the committed ExecStart', () => {
    for (const unit of Object.keys(UNIT_COMMANDS))
      expect(unitCommand(unit, 'python', '/home/u')).toBeNull();
  });
  test('each known unit maps to its subcommand', () => {
    expect(UNIT_COMMANDS).toEqual({
      'crq-tick.service': 'tick',
      'crq-slot.service': 'slot',
      'crq-repair.service': 'repair',
      'crq-publisher.service': 'publish',
      'crq-backfill.service': 'backfill inventory',
      'crq-watchdog.service': 'watchdog',
    });
    for (const [unit, cmd] of Object.entries(UNIT_COMMANDS))
      expect(unitCommand(unit, `node:${SHA}`, '/home/u')).toBe(
        `/usr/bin/env node /home/u/.local/opt/crq-${SHA}/dist/queue-runner/crq.js ${cmd}`,
      );
  });
  test('unknown unit is refused before the runtime is inspected', () => {
    for (const u of ['crq-other.service', '', 'toString', '__proto__', 'constructor'])
      expect(() => unitCommand(u, 'python', '/h')).toThrow('unknown runtime unit');
    expect(() => unitCommand('nope', 'bad', '/h')).toThrow('unknown runtime unit');
  });
  test.each([
    'Python',
    'node:' + 'a'.repeat(39),
    'node:' + 'a'.repeat(41),
    'node:' + 'A'.repeat(40),
    'node:' + 'g'.repeat(40),
    'node:' + SHA + '\n',
    `xnode:${SHA}`,
    'node',
    '',
    null,
    5,
  ])('refuses runtime %j', (rt) => {
    expect(() => unitCommand('crq-tick.service', rt, '/h')).toThrow(
      'runtime must be python or node:<full SHA>',
    );
  });
  test('home is normalised like pathlib and must be a host path', () => {
    const run = (h: string): string | null => unitCommand('crq-tick.service', `node:${SHA}`, h);
    expect(run('/home//u/./')).toContain(' /home/u/.local/opt/crq-');
    expect(run('/')).toContain(' /.local/opt/crq-');
    expect(run('//x')).toContain(' //x/.local/opt/crq-');
    expect(run('///x')).toContain(' /x/.local/opt/crq-');
    for (const bad of ['', '.', 'rel', '/home/a b', '/home/../x', '/home/$x', '/hom%e'])
      expect(() => run(bad)).toThrow(ValueError);
    expect(() => run('/home/a\nb')).toThrow('host paths must be absolute');
    expect(() => run('/h/../x')).toThrow('parent traversal is not a host path');
    expect(() => run('/h/é')).toThrow(ValueError);
  });
});

describe('renderServiceText', () => {
  const tpl = '[Service]\nWorkingDirectory=@CRQ_ROOT@/a\nExecStart=/old\nRestart=no\n';
  test('substitutes every placeholder', () => {
    expect(renderServiceText('t.service', '@CRQ_ROOT@ and @CRQ_ROOT@', '/r')).toBe('/r and /r');
  });
  test('refuses a non-string template and a runner root that reintroduces the placeholder', () => {
    expect(() => renderServiceText('t', 5, '/r')).toThrow('template text must be a string');
    expect(() => renderServiceText('t', 'x', '/r')).not.toThrow();
    expect(() => renderServiceText('t', '@CRQ_ROOT@', '/a/@CRQ_ROOT@')).toThrow(
      'unexpanded runner root',
    );
  });
  test('replacement text is literal, not a $-pattern', () => {
    expect(renderServiceText('t', '@CRQ_ROOT@', "/r/$&/$'")).toBe("/r/$&/$'");
  });
  test('without a command the ExecStart is untouched', () => {
    expect(renderServiceText('t.service', tpl, '/r')).toBe(tpl.replace('@CRQ_ROOT@', '/r'));
    expect(renderServiceText('t.service', 'no execstart', '/r')).toBe('no execstart');
  });
  test('a command replaces the single ExecStart line and ends it with a newline', () => {
    expect(renderServiceText('t.service', tpl, '/r', '/bin/new x')).toBe(
      '[Service]\nWorkingDirectory=/r/a\nExecStart=/bin/new x\nRestart=no\n',
    );
    expect(renderServiceText('t', 'ExecStart=/old', '/r', 'c')).toBe('ExecStart=c\n');
    expect(renderServiceText('t', 'a\r\nExecStart=/old\r\nb', '/r', 'c')).toBe(
      'a\r\nExecStart=c\nb',
    );
    expect(renderServiceText('t', 'ExecStart=/old', '/r', '')).toBe('ExecStart=\n');
  });
  test('refuses zero or several ExecStart lines', () => {
    expect(() => renderServiceText('t.service', 'x\n', '/r', 'c')).toThrow(
      'unit must have exactly one ExecStart: t.service',
    );
    expect(() => renderServiceText('t', 'ExecStart=a\nExecStart=b\n', '/r', 'c')).toThrow(
      ValueError,
    );
    expect(() => renderServiceText('t', ' ExecStart=a\n', '/r', 'c')).toThrow(ValueError);
    expect(() => renderServiceText('t', '#ExecStart=a\n', '/r', 'c')).toThrow(ValueError);
    expect(() => renderServiceText('t', 'ExecStartPre=a\n', '/r', 'c')).toThrow(ValueError);
  });
  test('line splitting follows every Python line boundary', () => {
    for (const sep of ['\r', '\v', '\f', '\u001c', '\u001d', '\u001e', '\u0085', ' ', ' '])
      expect(() => renderServiceText('t', `ExecStart=a${sep}ExecStart=b`, '/r', 'c')).toThrow(
        ValueError,
      );
    expect(renderServiceText('t', 'a ExecStart=x b', '/r', 'c')).toBe('a ExecStart=c\nb');
    // "\r\n" is one boundary, not two empty lines.
    expect(renderServiceText('t', 'ExecStart=a\r\n\r\nExecStart', '/r', 'c')).toBe(
      'ExecStart=c\n\r\nExecStart',
    );
  });
});
