import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = resolve(process.cwd(), 'policy/templates/self-host/self-review-loop.yml');
const INSTANTIATED = resolve(process.cwd(), '.github/workflows/self-review-loop.yml');

describe('shipped self-host sandbox job boundary', () => {
  it.each([
    ['template', TEMPLATE, '{{SELFHOST_TOKEN}}', '{{SELFHOST_DRIVER_KEY}}'],
    ['instantiated', INSTANTIATED, 'GH_TOKEN', 'Z_AI_API_KEY'],
  ])(
    'keeps the token-bearing privileged job separate in the %s',
    (_name, path, token, driverKey) => {
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
      expect(privileged).toContain('permissions:\n      contents: write');
      expect(privileged).toContain(`GH_TOKEN: \${{ secrets.${token} }}`);
      expect(privileged).toContain(`ZAI_API_KEY: \${{ secrets.${driverKey} }}`);
      expect(privileged).toContain("if: github.ref == 'refs/heads/main'");
      expect(privileged).toContain('needs: self-review-worker');
      expect(privileged).toContain('timeout-minutes: 15');
      expect(privileged).toContain('ref: ${{ needs.self-review-worker.outputs.trusted-commit }}');
    },
  );
});
