import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEMPLATE = resolve(process.cwd(), 'policy/templates/self-host/self-review-loop.yml');

describe('shipped self-host sandbox job boundary', () => {
  it('keeps the token-bearing privileged job separate from the tokenless worker job', () => {
    const yaml = readFileSync(TEMPLATE, 'utf8');
    const worker = yaml.slice(
      yaml.indexOf('  self-review-worker:'),
      yaml.indexOf('  self-review-privileged:'),
    );
    const privileged = yaml.slice(yaml.indexOf('  self-review-privileged:'));
    expect(worker).toContain('permissions:\n      contents: read');
    expect(worker).not.toContain('secrets.');
    expect(privileged).toContain('permissions:\n      contents: write');
    expect(privileged).toContain('GH_TOKEN: ${{ secrets.{{SELFHOST_TOKEN}} }}');
    expect(privileged).toContain('ZAI_API_KEY: ${{ secrets.{{SELFHOST_DRIVER_KEY}} }}');
    expect(privileged).toContain('needs: self-review-worker');
  });
});
