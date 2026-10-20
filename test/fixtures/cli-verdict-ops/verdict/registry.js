// Verdict-contract fixture family (Lane E): ops whose ok results carry (or
// lack) a `verdict` in their value, plus the throw/garbage error probes.
// Pure data + zod only — no src/ or dist/ imports. Inline op fns (no sibling
// modules) keep the family one file.
import { z } from 'zod';
const empty = () => z.object({}).strict();
const ok = (value) => async () => async () => ({ status: 'ok', value });
export const registry = [
  { name: 'verdictfail', inputSchema: empty(), importer: ok({ verdict: 'fail', n: 1 }) },
  { name: 'verdictpass', inputSchema: empty(), importer: ok({ verdict: 'pass' }) },
  { name: 'verdictnone', inputSchema: empty(), importer: ok({ n: 1 }) },
  // Not the exact string 'fail' / not an object value: both stay exit 0.
  { name: 'verdictcase', inputSchema: empty(), importer: ok({ verdict: 'FAIL' }) },
  { name: 'verdictscalar', inputSchema: empty(), importer: ok('fail') },
  { name: 'verdictnested', inputSchema: empty(), importer: ok({ inner: { verdict: 'fail' } }) },
  // A non-ok status keeps its own mapping with or without the flag.
  {
    name: 'failedverdict',
    inputSchema: empty(),
    importer: async () => async () => ({ status: 'failed', error: 'deliberate' }),
  },
  // Error probes for the --json error artifacts.
  {
    name: 'throwop',
    inputSchema: empty(),
    importer: async () => async () => {
      throw new Error('deliberate op throw');
    },
  },
  {
    name: 'garbage',
    inputSchema: empty(),
    importer: async () => async () => ({ status: 'nope' }),
  },
];
