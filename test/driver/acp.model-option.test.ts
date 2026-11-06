import { describe, expect, test } from 'vitest';
import { modelOptionValueFrom } from '../../src/driver/acp/protocol.js';

describe('modelOptionValueFrom', () => {
  test('an id:model entry wins over an earlier category:model entry', () => {
    const options = [
      { id: 'draft_model', category: 'model', currentValue: 'draft' },
      { id: 'model', currentValue: 'primary' },
    ] as unknown as Parameters<typeof modelOptionValueFrom>[0];
    expect(modelOptionValueFrom(options)).toBe('primary');
  });

  test('the category fallback applies when no entry has id model', () => {
    const options = [
      { id: 'other', category: 'model', currentValue: 'fallback' },
    ] as unknown as Parameters<typeof modelOptionValueFrom>[0];
    expect(modelOptionValueFrom(options)).toBe('fallback');
  });
});
