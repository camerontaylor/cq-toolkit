// Match the rule accepted by the pinned Oxlint RuleTester.
import type { RuleTester } from 'oxlint/plugins-dev';

declare const noCliBeyondRegistryKernel: Parameters<RuleTester['run']>[1];
export default noCliBeyondRegistryKernel;
