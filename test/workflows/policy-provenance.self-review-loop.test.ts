// Split from policy-provenance.test.ts: self-review-loop peak-aware model
// selection (D11). Shared helpers live in policy-provenance.helpers.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './policy-provenance.helpers.js';

describe('self-review-loop peak-aware model selection (D11)', () => {
  it('template and instantiation switch models instead of excluding the peak', () => {
    for (const file of [
      'policy/templates/self-host/self-review-loop.yml',
      '.github/workflows/self-review-loop.yml',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      // Dispatch-only (development posture, 2026-10-20): no cron at all, and
      // the old start-exclusion guard (and its weekday clock read) is gone.
      // The model switches per run instead.
      expect(text, `${file}: no cron`).not.toMatch(/^\s*- cron:/m);
      expect(text, `${file}: no start-exclusion guard`).not.toContain(
        'refusing to initiate operations',
      );
      expect(text, `${file}: no weekday guard read`).not.toContain('date -u +%u');
      // Both provider keys are exported unconditionally …
      expect(text, `${file}: off-peak key declaration`).toContain('ZAI_API_KEY: ${{ secrets.');
      expect(text, `${file}: peak key declaration`).toContain('OPENCODE_GO_API_KEY: ${{ secrets.');
      expect(text, `${file}: peak base URL declaration`).toContain(
        'OPENCODE_GO_BASE_URL: ${{ vars.OPENCODE_GO_BASE_URL }}',
      );
      // … and the required one is derived from the toolkit's ONE decision
      // point, so no window arithmetic lives in the YAML. The step also PINS
      // one run instant so the handshake process and the run cannot straddle
      // a selection boundary.
      expect(text, `${file}: key-name handshake`).toContain('--print-driver-key-env');
      expect(text, `${file}: one pinned run instant`).toContain(
        'export CQ_SELFHOST_NOW_MS="$(date -u +%s000)"',
      );
      expect(text, `${file}: the pin feeds both processes`).toMatch(
        /export CQ_SELFHOST_NOW_MS=.*\n[\s\S]*--print-driver-key-env/,
      );
    }
  });
});
