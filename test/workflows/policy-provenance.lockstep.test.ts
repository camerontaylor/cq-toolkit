// Split from policy-provenance.test.ts: the template ↔ generated lockstep
// pin. Shared helpers live in policy-provenance.helpers.ts.
import { describe, expect, it } from 'vitest';
import { FILES, generated, template } from './policy-provenance.helpers.js';

describe('policy workflows: template ↔ generated lockstep', () => {
  it.each(FILES)('%s is its template plus the provenance header', (name) => {
    expect(generated(name)).toBe(
      `# instantiated from policy/templates/${name} — edit the template, not this file\n${template(name)}`,
    );
  });
});
