import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("authorized self-edit keeps the actual Review child on parent bytes while an independent CLI captures the edit", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-self-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["src", "tests/support"]) {
    fs.cpSync(path.join(repository, directory), path.join(root, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(repository, "package.json"), path.join(root, "package.json"));
  const reviewPath = path.join(root, "src/flow/commands/review.js");
  // Observe actual child resource reads without replacing the child or provider boundary.
  const marker = `  console.error("CHILD_RUNTIME=" + JSON.stringify({ revision: currentRuntimePackage().revision,
    prompt: crypto.createHash("sha256").update(readRuntimeResource(new URL("../prompts/plan/spec.md", import.meta.url))).digest("hex"),
    schema: crypto.createHash("sha256").update(readRuntimeResource(new URL("../schemas/spec.schema.json", import.meta.url))).digest("hex") }));\n`;
  fs.writeFileSync(reviewPath, fs.readFileSync(reviewPath, "utf8").replace("  initContainer();", marker + "  initContainer();"));
  fs.writeFileSync(path.join(root, "scenario.mjs"), `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import crypto from 'node:crypto';
    import path from 'node:path';
    import { spawnSync } from 'node:child_process';
    import { currentRuntimePackage, readRuntimeResource } from './src/lib/runtime-package.js';
    import { TaskLifecycleFixture, makeFlowManager } from './tests/support/infrastructure/flow-setup.js';
    import { initGitRepo, commitAll } from './tests/support/infrastructure/git-repo.js';
    import { completeCanonicalSourceHandoff } from './tests/support/builders/source-handoff-scenario.js';
    import { writeStubAgentScript, stubAgentConfig } from './tests/support/fakes/stub-agent.js';
    import { initContainer, container } from './src/lib/container.js';
    import RunReviewCommand from './src/flow/lib/run-review.js';
    import { runCmd } from './src/lib/process.js';
    import { FLOW_COMMANDS } from './src/flow/registry.js';
    const root = process.cwd();
    const specId = 'self-runtime';
    const taskId = 'T-1';
    const stub = writeStubAgentScript(root, 'provider.cjs', JSON.stringify({blockingFindings:[], nonBlockingImprovements:[]}));
    const agent=stubAgentConfig(stub);
    Object.assign(agent.providers['stub-agent'], {jsonSchemaFlag:'--schema',jsonSchemaMode:'inline'});
    fs.mkdirSync('.sennel', {recursive:true});
    fs.writeFileSync('.sennel/config.json', JSON.stringify({type:'base', lang:'en', docs:{languages:['en'],defaultLanguage:'en'}, agent}));
    initGitRepo(root); commitAll(root, 'self runtime baseline');
    initContainer({ root });
    const manager = makeFlowManager(root);
    new TaskLifecycleFixture({ flowManager:manager, specId, runId:'self-runtime-run', taskId, targetStep:'task-impl',
      specRecord:{requirements:[{id:'R-1',desc:'Preserve runtime during source editing.',task_ids:[taskId]}],overview:{modules:[],data_flow:[],decisions:[]}},
      taskDocuments:[{id:taskId,title:'Runtime',goal:'Preserve runtime.',parent:null,origin:'plan',added_round:0,status:'pending'}]
    }).create();
    const runtime = currentRuntimePackage();
    const prompt = crypto.createHash('sha256').update(readRuntimeResource('./src/flow/prompts/plan/spec.md')).digest('hex');
    const schema = crypto.createHash('sha256').update(readRuntimeResource('./src/flow/schemas/spec.schema.json')).digest('hex');
    completeCanonicalSourceHandoff({root,manager,specId,stepId:'task-impl',taskId,
      mutate() {
        fs.writeFileSync('./src/flow/commands/review.js', 'throw new Error("edited Review code must not run in the active child");');
        fs.writeFileSync('./src/flow/prompts/plan/spec.md', 'edited runtime prompt');
        fs.writeFileSync('./src/flow/schemas/spec.schema.json', '{}');
        fs.writeFileSync('./src/lib/runtime-child-bootstrap.js', 'throw new Error("mutable child bootstrap must not execute");');
        fs.writeFileSync('./src/lib/runtime-bootstrap-loader.js', 'throw new Error("mutable transport loader must not execute");');
        fs.appendFileSync('./src/sennel.js', '\\n// Edited bootstrap version.\\n');
        fs.appendFileSync('./src/lib/runtime-loader.js', '\\n// Edited loader version.\\n');
      }, effect:{version:1,stepId:'task-impl',completionStatus:'done',issues:[],overview:{modules:[],data_flow:[],decisions:[]},triage:null,repair:null,noChangeReason:null}
    });
    manager.updateStepStatus({stepId:'T-1-review',requestedStatus:'in_progress'},{specId});
    const ctx={root,mainRoot:root,executionRoot:root,specId,flowManager:manager,flowState:manager.loadReadOnly(specId),config:container.get('config'),skipConfirm:true};
    let childResult;
    const review = new RunReviewCommand({resolveTreeSha:()=> 'a'.repeat(40),resolveTargetStateDigest:()=> 'b'.repeat(64),
      runCommand(_command,args,options) { childResult=runCmd(process.execPath,args,options); return childResult; }});
    const result=await review.execute(ctx);
    assert.notEqual(result.ok,false,JSON.stringify({result,childResult}));
    await FLOW_COMMANDS.run.review.post(ctx,result);
    assert.equal(manager.canonicalState(specId).current.at(-1),'T-1-gate');
    const diagnostic=childResult.stderr.split('\\n').find(line=>line.startsWith('CHILD_RUNTIME='));
    assert.ok(diagnostic,childResult.stderr);
    const child=JSON.parse(diagnostic.slice('CHILD_RUNTIME='.length));
    assert.equal(child.revision,runtime.revision); assert.equal(child.prompt,prompt); assert.equal(child.schema,schema);
    const fresh=spawnSync(process.execPath,['--import','./src/sennel.js','--input-type=module','-e',
      'import {currentRuntimePackage} from "./src/lib/runtime-package.js";console.log(currentRuntimePackage().revision)'],{encoding:'utf8'});
    assert.equal(fresh.status,0,fresh.stderr); assert.notEqual(fresh.stdout.trim(),runtime.revision);
    console.log('SELF_EDIT_RESULT='+JSON.stringify({child:child.revision,parent:runtime.revision,fresh:fresh.stdout.trim()}));
  `);
  const result = spawnSync(process.execPath, ["--import", "./src/sennel.js", "scenario.mjs"], {
    cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SELF_EDIT_RESULT=/);
});
