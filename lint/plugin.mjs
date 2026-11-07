import cli from './rules/no-cli-beyond-registry-kernel.mjs';
import noProcessEnvAccessor from './rules/no-process-env-accessor.mjs';
import noProcessEnv from './rules/no-process-env.mjs';
import harnessDriver from './rules/no-driver-import-in-harness.mjs';
import vendor from './rules/no-vendor-sdk-in-kernel.mjs';

export default {
  meta: { name: 'cq' },
  rules: {
    'no-cli-beyond-registry-kernel': cli,
    'no-driver-import-in-harness': harnessDriver,
    'no-process-env': noProcessEnv,
    'no-process-env-accessor': noProcessEnvAccessor,
    'no-vendor-sdk-in-kernel': vendor,
  },
};
