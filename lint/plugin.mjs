import cli from './rules/no-cli-beyond-registry-kernel.mjs';
import harnessDriver from './rules/no-driver-import-in-harness.mjs';
import vendor from './rules/no-vendor-sdk-in-kernel.mjs';

export default {
  meta: { name: 'cq' },
  rules: {
    'no-cli-beyond-registry-kernel': cli,
    'no-driver-import-in-harness': harnessDriver,
    'no-vendor-sdk-in-kernel': vendor,
  },
};
