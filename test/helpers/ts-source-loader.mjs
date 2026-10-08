// Test-only Node loader: lets a CHILD `node` process run the TypeScript
// sources directly (Node's built-in type stripping), by resolving the
// sources' `./x.js` import specifiers to the sibling `./x.ts` when no `.js`
// exists. Used as `node --import <this file> src/harness/mcp/bin.ts …` so
// process-level tests exercise the server from source without a build.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const js = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(js))) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}
`),
);
