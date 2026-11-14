/**
 * Unit coverage for `publisherSpool.ts`: the parser (`parsePublisherSpool`),
 * the ssh argv construction (`publisherSshArgv`) and the exact-reply gate
 * (`parseSignerReply`). The process spawn itself stays untested here (it is
 * `/usr/bin/ssh` against a real signer); the route tests cover the
 * `legacy_shell` refusal end to end.
 */
import { describe, expect, test } from 'vitest';
import {
  SpoolConfigError,
  parsePublisherSpool,
  parseSignerReply,
  publisherSshArgv,
  publisherSpoolPushCommit,
} from '../../../src/adapters/crq/publisherSpool.js';
import { LedgerTransportError } from '../../../src/adapters/crq/ledgerGit.js';
import { JsonObject, JsonNumber } from '../../../src/policy/crq/jsonValue.js';

describe('parsePublisherSpool', () => {
  test('an alias without any key refuses: there is no fallback transport', () => {
    expect(() => parsePublisherSpool(new JsonObject([['ssh_alias', 'crq@spool.invalid']]))).toThrow(
      SpoolConfigError,
    );
  });

  test('an empty ssh_key falls through to a valid key: Python `or` truthiness', () => {
    // backfill_runtime.settings(): key = spool.get("ssh_key") or spool.get("key").
    // bool("") is False, so the alias selects `key`; nullish coalescing would
    // select the empty string and refuse a configuration Python accepts.
    const config = parsePublisherSpool(
      new JsonObject([
        ['ssh_alias', 'crq@spool.invalid'],
        ['ssh_key', ''],
        ['key', '/keys/crq-signer'],
      ]),
    );
    expect(config).toEqual({ sshAlias: 'crq@spool.invalid', sshKey: '/keys/crq-signer' });
    // A truthy non-string ssh_key is selected and then refused by the
    // isinstance gate, exactly like Python.
    expect(() =>
      parsePublisherSpool(
        new JsonObject([
          ['ssh_alias', 'crq@spool.invalid'],
          ['ssh_key', JsonNumber.int(5)],
          ['key', '/keys/crq-signer'],
        ]),
      ),
    ).toThrow(SpoolConfigError);
    // Both keys empty refuses: the fallback is also falsy.
    expect(() =>
      parsePublisherSpool(
        new JsonObject([
          ['ssh_alias', 'crq@spool.invalid'],
          ['ssh_key', ''],
          ['key', ''],
        ]),
      ),
    ).toThrow(SpoolConfigError);
  });

  test('a well-formed spool document normalizes to alias plus key', () => {
    const config = parsePublisherSpool(
      new JsonObject([
        ['ssh_alias', 'crq@spool.invalid'],
        ['ssh_key', '/keys/crq-signer'],
      ]),
    );
    expect(config).toEqual({ sshAlias: 'crq@spool.invalid', sshKey: '/keys/crq-signer' });
    const aliasKey = parsePublisherSpool(
      new JsonObject([
        ['ssh_alias', 'ledger@signer.example.com'],
        ['key', '/keys/runbook-key'],
      ]),
    );
    expect(aliasKey).toEqual({
      sshAlias: 'ledger@signer.example.com',
      sshKey: '/keys/runbook-key',
    });
  });

  test('legacy_shell is refused, never ignored', () => {
    expect(() =>
      parsePublisherSpool(
        new JsonObject([
          ['ssh_alias', 'crq@spool.invalid'],
          ['ssh_key', '/keys/crq-signer'],
          ['legacy_shell', true],
        ]),
      ),
    ).toThrow(SpoolConfigError);
  });

  test('unknown keys refuse exactly like Python', () => {
    expect(() =>
      parsePublisherSpool(
        new JsonObject([
          ['ssh_alias', 'crq@spool.invalid'],
          ['ssh_key', '/keys/crq-signer'],
          ['extra', JsonNumber.int(1)],
        ]),
      ),
    ).toThrow(SpoolConfigError);
  });

  test('alias must be a literal user@host', () => {
    for (const alias of ['spool.invalid', 'crq@', '@spool.invalid', 'crq@-bad', '']) {
      expect(() =>
        parsePublisherSpool(
          new JsonObject([
            ['ssh_alias', alias],
            ['ssh_key', '/keys/crq-signer'],
          ]),
        ),
      ).toThrow(SpoolConfigError);
    }
  });

  test('blank or control-bearing keys refuse before any ssh runs', () => {
    for (const key of ['', '   ', '/keys/\nbad', '/keys/\rbad', '/keys/\0bad']) {
      expect(() =>
        parsePublisherSpool(
          new JsonObject([
            ['ssh_alias', 'crq@spool.invalid'],
            ['ssh_key', key],
          ]),
        ),
      ).toThrow(SpoolConfigError);
    }
    expect(() => parsePublisherSpool(undefined)).toThrow(SpoolConfigError);
  });
});

describe('publisherSshArgv', () => {
  test('pins -F none, the dedicated key, and the literal remote command', () => {
    const argv = publisherSshArgv(
      { sshAlias: 'crq@spool.invalid', sshKey: '/keys/crq-signer' },
      '/keys/crq-signer',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    // No shell, no ssh_config, no agent, no control master: the pinned key is
    // the only authentication candidate.
    expect(argv[0]).toBe('-F');
    expect(argv).toContain('none');
    expect(argv).toEqual([
      '-F',
      'none',
      '-i',
      '/keys/crq-signer',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      'crq@spool.invalid',
      `ledger-publish ${'a'.repeat(40)} ${'b'.repeat(40)}`,
    ]);
  });
});

describe('parseSignerReply', () => {
  const head = 'b'.repeat(40);

  test('accepts exactly the published acknowledgement', () => {
    expect(() => parseSignerReply(`{"published": "${head}"}\n`, head)).not.toThrow();
  });

  test('unreadable JSON is a transport defect', () => {
    expect(() => parseSignerReply('not json', head)).toThrow(LedgerTransportError);
    expect(() => parseSignerReply('not json', head)).toThrow(/reply unreadable/);
  });

  test('any other acknowledgement is a transport defect', () => {
    // Wrong head, extra keys, arrays, nulls, plain strings.
    expect(() => parseSignerReply(`{"published": "${'c'.repeat(40)}"}`, head)).toThrow(
      /did not acknowledge/,
    );
    expect(() => parseSignerReply(`{"published": "${head}", "extra": 1}`, head)).toThrow(
      /did not acknowledge/,
    );
    expect(() => parseSignerReply('["published"]', head)).toThrow(/did not acknowledge/);
    expect(() => parseSignerReply('null', head)).toThrow(/did not acknowledge/);
    expect(() => parseSignerReply(`"${head}"`, head)).toThrow(/did not acknowledge/);
    expect(() => parseSignerReply('', head)).toThrow(/reply unreadable/);
  });

  test('the push commit gate refuses malformed oids and bundle sizes', async () => {
    const push = publisherSpoolPushCommit({
      sshAlias: 'crq@spool.invalid',
      sshKey: '/keys/crq-signer',
    });
    await expect(push('short', 'b'.repeat(40), new Uint8Array(1))).rejects.toThrow(
      /dedicated signer transport/,
    );
    await expect(push('a'.repeat(40), 'b'.repeat(40), new Uint8Array(0))).rejects.toThrow(
      /invalid ledger bundle size/,
    );
  });

  test('a missing signer key refuses before ssh runs', async () => {
    // OpenSSH ignores an inaccessible -i file and still offers default
    // identities, so a nonexistent key must refuse the transport (owner D4:
    // no fallback) instead of reaching ssh with a fallback path.
    const push = publisherSpoolPushCommit({
      sshAlias: 'crq@spool.invalid',
      sshKey: '/keys/crq-signer-does-not-exist',
    });
    await expect(push('a'.repeat(40), 'b'.repeat(40), new Uint8Array(8))).rejects.toThrow(
      /signer key unavailable/,
    );
  });
});
