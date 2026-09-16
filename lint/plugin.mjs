import cli from './rules/no-cli-beyond-registry-kernel.mjs';
import vendor from './rules/no-vendor-sdk-in-kernel.mjs';

export default {
  meta: { name: 'cq' },
  rules: {
    'no-cli-beyond-registry-kernel': cli,
    'no-vendor-sdk-in-kernel': vendor,
  },
};
