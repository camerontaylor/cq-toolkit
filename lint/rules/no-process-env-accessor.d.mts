// Match the rule accepted by the pinned Oxlint RuleTester.
import type { RuleTester } from 'oxlint/plugins-dev';

declare const noProcessEnvAccessor: Parameters<RuleTester['run']>[1];
export default noProcessEnvAccessor;
