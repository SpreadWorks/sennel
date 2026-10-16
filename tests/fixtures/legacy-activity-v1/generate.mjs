import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// Run with: node generate.mjs <exported historical source root> <new output root>
const source = path.resolve(process.argv[2]);
const root = path.resolve(process.argv[3]);
const { CurrentFlowDefinition, CurrentFlowVersionStore, FlowActivity } = await import(pathToFileURL(path.join(source, 'src/flow/lib/current-flow-state.js')));
const { FlowVersionLocation, FlowVersionAuthorityScope } = await import(pathToFileURL(path.join(source, 'src/lib/flow-version.js')));
const definition = new CurrentFlowDefinition(JSON.parse(fs.readFileSync(new URL('./definition.json', import.meta.url), 'utf8')));
fs.mkdirSync(root, { recursive: true });
const specId='001-legacy-activity';
const location=new FlowVersionLocation({repositoryRoot:root,authorityScope:FlowVersionAuthorityScope.canonical(),specRoot:'specs',specId,version:1});
const store=new CurrentFlowVersionStore({location,definition});
let state=store.createFresh({flowId:'legacy-producer-flow',flowVersionId:'legacy-producer-version',runId:'legacy-producer-run',request:'Retain the confirmed preparation boundary.',specRecord:{id:specId,title:'Historical writer seed',tasks:[]}});
const timestamp='2026-08-29T00:00:00.000Z';
const node=state.findNode('branch');
const attempt={id:'legacy-branch-attempt',nodeId:'branch',sequence:1,startedAt:timestamp,consumption:{semantic:0,tooling:0},failure:null,blocker:null,incomplete:[],operationClaims:[{operation:'execute',resources:[...definition.contractFor('branch',state.root).resourceContract.required]}]};
function activity(operation,type,result,status,attemptValue){return new FlowActivity({id:`legacy-${operation}`,nodeId:'branch',nodeKey:node.key,attemptId:attempt.id,sequence:1,confirmationOrder:state.confirmationOrder+1,type,transition:{operation,nodeId:'branch',task:null,attempt:attemptValue,status,policy:null,outbox:null,approval:null,nonblocking:null,finalizeSteps:null,gateTaskLifecycle:null,stepConnectionReceipt:null},result,timing:{startedAt:timestamp,finishedAt:timestamp,durationMs:0},failure:null,provider:null,model:null,effort:null,usage:null,references:{evaluations:[],findings:[],repairs:[],artifacts:[]},metric:null,note:null});}
state=store.apply({activity:activity('start_attempt','attempt_started',null,null,attempt)});
state=store.apply({activity:activity('confirm_attempt','result_confirmed',{outcome:'passed',summary:'Preparation confirmed by the historical producer.',confirmedAt:timestamp,artifactRefs:[]},'done',null)});
if (state.nextAction().nodeId !== 'prepare-spec') throw new Error('historical producer frontier changed');
