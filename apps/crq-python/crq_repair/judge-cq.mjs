// Invocation-owned schema and fail-closed served-model assertion, toolkit seam v2.
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = dirname(request.cq_bin);
const {AiSdkDriver} = await import(pathToFileURL(join(root, 'driver/ai-sdk/index.js')));
const {withServedModelAssertion} = await import(pathToFileURL(join(root, 'driver/served-model.js')));
// Triage packs bounded contract/source/history evidence, beyond the generic 20k default.
// Keep a finite caller-prompt cap; token/context and wall-clock budgets still apply.
const driverOptions = {};
if (request.schema === 'crq.triage/v1') {
  const {defaultHarnessConfig} = await import(pathToFileURL(join(root, 'harness/config.js')));
  driverOptions.harnessConfig = {...defaultHarnessConfig,
    promptBudget:{...defaultHarnessConfig.promptBudget,maxSystemPromptChars:128000}};
}
const driver = withServedModelAssertion(new AiSdkDriver(driverOptions), {lane:'ai-sdk'});
const triageSchema = {type:'object',additionalProperties:false,
  properties:{verdict:{type:'string',enum:['valid','fixed','superseded','invalid','duplicate-of','unsure']},
    reason:{type:'string'},fixing_commit:{type:['string','null']},current_path:{type:['string','null']},
    current_lines:{type:'array',items:{type:'array',items:{type:'integer'},minItems:2,maxItems:2}},
    quoted_text:{type:['string','null']},canonical_of:{type:['string','null']}},
  required:['verdict','reason','fixing_commit','current_path','current_lines','quoted_text','canonical_of']};
const report = await driver.run({prompt:request.prompt, modelSpec:request.modelSpec,
  toolPolicy:{mode:'none',allow:[]}, sandboxPolicy:{level:'read-only'}, budget:request.budget,
  outputSchema:request.schema === 'crq.triage/v1' ? {name:request.schema,schema:triageSchema} : {name:'crq.judge/v1',schema:{type:'object',additionalProperties:false,
    properties:{verdict:{type:'string',enum:['valid','invalid','unsure']},reason:{type:'string'}},
    required:['verdict','reason']}}});
console.log(JSON.stringify({...report.structuredOutput,
  stop:report.stopReason === 'complete' ? 'ok' : ['rate-limit','quota'].includes(report.errorClass) ? 'rate-limit' : report.stopReason,
  usage:report.usage,errorClass:report.errorClass,providerSignals:report.providerSignals,reason:report.structuredOutput?.reason ?? report.error}));
