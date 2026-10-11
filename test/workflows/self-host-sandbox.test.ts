import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = resolve(process.cwd(), 'policy/templates/self-host/self-review-loop.yml');
const INSTANTIATED = resolve(process.cwd(), '.github/workflows/self-review-loop.yml');
const MINT_PIN = 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1';

describe('shipped self-host sandbox job boundary', () => {
  it.each([
    ['template', TEMPLATE, '{{SELFHOST_DRIVER_KEY}}', '{{SELFHOST_PEAK_DRIVER_KEY}}'],
    ['instantiated', INSTANTIATED, 'Z_AI_API_KEY', 'DEEPSEEK_API_KEY'],
  ])(
    'keeps the token-bearing privileged job separate in the %s',
    (_name, path, driverKey, peakDriverKey) => {
      const yaml = readFileSync(path, 'utf8');
      const worker = yaml.slice(
        yaml.indexOf('  self-review-worker:'),
        yaml.indexOf('  self-review-privileged:'),
      );
      const privileged = yaml.slice(yaml.indexOf('  self-review-privileged:'));
      expect(worker).toContain('timeout-minutes: 5');
      expect(worker).toContain('trusted-commit: ${{ steps.trusted-commit.outputs.commit }}');
      expect(worker).toContain('permissions:\n      contents: read');
      expect(worker).not.toContain('secrets.');
      expect(worker).not.toContain('create-github-app-token');
      expect(privileged).toContain('permissions:\n      contents: write');
      // The review loop mints its GitHub token per run (no SELFHOST_TOKEN
      // secret): the mint step holds the App key and client id, and the loop
      // step consumes only the minted output.
      expect(privileged).toContain(`uses: ${MINT_PIN}`);
      expect(privileged).toContain('client-id: ${{ vars.CQ_AUTOMATION_APP_CLIENT_ID }}');
      expect(privileged).toContain('private-key: ${{ secrets.CQ_AUTOMATION_APP_KEY }}');
      expect(privileged).toContain('GH_TOKEN: ${{ steps.self-review-app.outputs.token }}');
      // BOTH provider keys ride the loop step (off-peak + peak); each
      // provider factory reads its own at dispatch time.
      expect(privileged).toContain(`ZAI_API_KEY: \${{ secrets.${driverKey} }}`);
      expect(privileged).toContain(`DEEPSEEK_API_KEY: \${{ secrets.${peakDriverKey} }}`);
      expect(privileged).toContain("if: github.ref == 'refs/heads/main'");
      expect(privileged).toContain('needs: self-review-worker');
      expect(privileged).toContain('timeout-minutes: 15');
      expect(privileged).toContain('ref: ${{ needs.self-review-worker.outputs.trusted-commit }}');
    },
  );

  it('fails closed on an unminted token instead of skipping', () => {
    const yaml = readFileSync(TEMPLATE, 'utf8');
    // The old optional-automation skip is gone: a missing credential refuses.
    expect(yaml).not.toContain('skipping optional self-host automation');
    expect(yaml).toMatch(
      /test -n "\$GH_TOKEN" \|\| \{ echo '[^']*CQ_AUTOMATION_APP_CLIENT_ID[^']*CQ_AUTOMATION_APP_KEY[^']*'[^}]*exit 1; \}/,
    );
    // No PAT fallback identity: the token comes only from the mint step.
    expect(yaml).not.toContain('{{SELFHOST_TOKEN}}');
    expect(yaml).not.toContain('secrets.GH_TOKEN');
  });
});
