// Read-only judgement through cq's AI SDK driver; toolPolicy none means no tools.
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = dirname(request.cq_bin);
const require = createRequire(pathToFileURL(join(root, '../package.json')));
const {z} = require('zod');
const {AiSdkDriver} = await import(pathToFileURL(join(root, 'driver/ai-sdk/index.js')));
const driver = new AiSdkDriver({outputSchema: z.object({verdict:z.enum(['valid','invalid','unsure']),reason:z.string()}).strict()});
const report = await driver.run({prompt: request.prompt,modelSpec:request.modelSpec,
  toolPolicy:{mode:'none',allow:[]},sandboxPolicy:{level:'read-only'},budget:request.budget});
console.log(JSON.stringify({...report.structuredOutput,stop:report.stopReason,usage:report.usage,providerSignals:report.providerSignals}));
