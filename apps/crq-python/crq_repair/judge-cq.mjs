// Invocation-owned schema and fail-closed served-model assertion, toolkit seam v2.
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = dirname(request.cq_bin);
const {AiSdkDriver} = await import(pathToFileURL(join(root, 'driver/ai-sdk/index.js')));
const {withServedModelAssertion} = await import(pathToFileURL(join(root, 'driver/served-model.js')));
const driver = withServedModelAssertion(new AiSdkDriver(), {lane:'ai-sdk'});
const report = await driver.run({prompt:request.prompt, modelSpec:request.modelSpec,
  toolPolicy:{mode:'none',allow:[]}, sandboxPolicy:{level:'read-only'}, budget:request.budget,
  outputSchema:{name:'crq.judge/v1',schema:{type:'object',additionalProperties:false,
    properties:{verdict:{type:'string',enum:['valid','invalid','unsure']},reason:{type:'string'}},
    required:['verdict','reason']}}});
console.log(JSON.stringify({...report.structuredOutput,
  stop:report.stopReason === 'complete' ? 'ok' : report.errorClass === 'rate-limit' ? 'rate-limit' : report.stopReason,
  usage:report.usage,providerSignals:report.providerSignals,reason:report.structuredOutput?.reason ?? report.error}));
