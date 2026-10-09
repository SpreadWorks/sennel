// Opt-in experiment, not a Flow runner: node tests/agent/spec-writing-model-comparison.mjs <spec.json> <report-directory>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Agent } from '../../src/lib/agent.js';
import { ProviderRegistry } from '../../src/lib/provider.js';
import { Logger } from '../../src/lib/log.js';
import { ProviderOutputMeter } from './gate-quality-comparison.mjs';
import { createTmpDir, removeTmpDir } from '../support/builders/tmp-dir.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const [sourcePath, outputArgument, fixtureSelection = 'all', apiFixtureVersion = '2'] = process.argv.slice(2);
assert.ok(sourcePath && outputArgument, 'Provide a read-only source Spec and an experiment output directory.');
const outputRoot = path.resolve(outputArgument);
fs.mkdirSync(outputRoot, { recursive: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const chars = (text) => Array.from(text).length;
const saveJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function snapshot(directory) {
  const result = {};
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) result[full] = digest(fs.readFileSync(full));
    }
  }
  visit(directory);
  return result;
}

class WritingFixture {
  constructor({ id, provenance, preface, fields, rows }) {
    this.id = id;
    this.provenance = provenance;
    this.preface = preface;
    this.fields = fields;
    this.rows = rows;
    this.text = preface + '\n' + rows.map((row) => row.entity + ': ' + fields.map((field) => field + '=' + row[field]).join('; ')).join('\n');
    this.dictionary = Object.fromEntries(fields.map((field) => [field, [...new Set(rows.map((row) => row[field]))]]));
  }

  expectedIds(row) {
    return this.fields.map((field) => this.dictionary[field].indexOf(row[field]));
  }
}

const sourceBytes = fs.readFileSync(sourcePath);
const spec = JSON.parse(sourceBytes);
const actualRequirement = spec.requirements.find((requirement) => requirement.id === 'R4');
assert.ok(actualRequirement);
const [preface, ...lines] = actualRequirement.desc.split('\n');
const fields = ['positional', 'rest', 'flags', 'value', 'optionalValue', 'guard', 'help', 'usage', 'owner'];
const rows = lines.map((line) => {
  const split = line.indexOf(': ');
  const row = { entity: line.slice(0, split) };
  for (const pair of line.slice(split + 2).split('; ')) {
    const equal = pair.indexOf('=');
    row[pair.slice(0, equal)] = pair.slice(equal + 1);
  }
  assert.ok(fields.every((field) => typeof row[field] === 'string'));
  return row;
});
const realFixture = new WritingFixture({ id: 'actual-r4', provenance: 'Read-only copy of current Issue 521 R4; defects and omissions are intentionally preserved.', preface, fields, rows });
assert.equal(realFixture.text, actualRequirement.desc);

const apiFields = ['authentication', 'authorization', 'request', 'empty', 'limit', 'retry', 'audit', 'owner'];
const apiNames = ['GET /documents', 'GET /documents/{id}', 'POST /documents', 'PATCH /documents/{id}', 'DELETE /documents/{id}', 'POST /exports', 'GET /exports/{id}', 'DELETE /exports/{id}', 'GET /public/status', 'POST /webhooks', 'POST /imports', 'GET /imports/{id}'];
const apiRows = apiNames.map((entity, index) => {
  const row = { entity, authentication: '期限内のBearer tokenを必須とし、不正または期限切れは401', authorization: 'tokenのtenantと対象tenantの一致が必須。不一致は403', request: 'Content-Typeはapplication/json。UTF-8 JSON objectを受け付け、未知キーは400', empty: '必須文字列は空・空白だけを400で拒否。任意文字列の空は明示的な空として保持', limit: 'bodyは65536 bytes以下。超過は413、整数countは1〜100', retry: 'GETのみ同一条件で再試行可。POST/PATCH/DELETEの自動再試行は禁止', audit: '成功と拒否を記録。tokenと本文の個人情報は記録しない', owner: './api/handler-' + index + '.js' };
  if (index === 3) row.empty = 'PATCHの空文字列は明示的削除。省略は現状維持。nullは400';
  if (index === 5) row.retry = 'Idempotency-Key付きPOSTは24時間同一応答。キーなしPOSTは再試行禁止';
  if (index === 8) { row.authentication = '認証不要'; row.authorization = 'tenant照合不要'; row.request = 'bodyを受け付けない。送られたbodyは400'; row.empty = '入力文字列なし'; row.limit = 'bodyは0 bytes'; }
  if (index === 9) {
    row.authentication = 'Bearer tokenは使わず署名とtimestampを検証。不正は401';
    row.retry = 'event-id単位で7日間重複排除し、同一event-idは同一応答';
    if (apiFixtureVersion === '2') row.authorization = '署名に対応する送信元tenantと対象tenantの一致が必須。不一致は403';
  }
  if (index === 10) row.limit = 'bodyは1048576 bytes以下。超過は413、整数countは1〜1000';
  return row;
});
const apiFixture = new WritingFixture({ id: 'synthetic-api', provenance: 'Synthetic transfer fixture, not a project requirement or evidence of real API behavior.', preface: '検証専用の仮想API契約。次の12操作それぞれについて全条件を守る。認証・認可・入力検証・再試行の責務は各行のownerに属する。検証は正常応答、拒否時の副作用なし、重複処理なし、監査記録で行う。明示された例外は他の操作へ一般化しない。', fields: apiFields, rows: apiRows });
const fixtures = [realFixture, apiFixture].filter((fixture) => fixtureSelection === 'all' || fixtureSelection === fixture.id);
assert.ok(fixtures.length, 'Unknown fixture selection');

const baseline = `以下の既存の要件記述を、実装と検証に使える要件記述として整理してください。人が読む文章は日本語にしてください。技術識別子、値、対象、条件、例外、責務、検証方法を保持してください。原文にない仕様を作らず、原文の不明点を推測で埋めないでください。整理・抽象化し、原文の単なるコピーは避けてください。説明や作業報告を付けず、改稿した要件本文だけを最終回答として出してください。外部のファイルやツールを使用せず、以下の原文だけを使ってください。`;
const genericPolicy = `\n記述量の制御方針: 複数の対象に繰り返される条件は共通定義として一度だけ記載し、適用対象と適用範囲を明示してください。対象ごとの記述は共通定義への参照と、その対象だけの条件・差分・例外にしてください。共通定義への参照だけで各対象の条件を一意に復元できるようにし、省略が「なし」なのか共通値の継承なのかを明確にしてください。対象の列挙や必要な条件を削らず、例外を共通化してはいけません。名前から責務や値を推測してはいけません。修正では不足する条件だけを補い、解決済み条件や共通定義の全文を対象ごとに追記しないでください。`;
fs.writeFileSync(path.join(outputRoot, 'baseline-prompt.txt'), baseline + '\n');
fs.writeFileSync(path.join(outputRoot, 'generic-policy.txt'), genericPolicy.trim() + '\n');
for (const fixture of fixtures) {
  fs.writeFileSync(path.join(outputRoot, fixture.id + '.source.txt'), fixture.text);
  saveJson(path.join(outputRoot, fixture.id + '.expected.json'), { fields: fixture.fields, rows: fixture.rows, dictionary: fixture.dictionary, provenance: fixture.provenance });
}

const models = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'];
const verificationModel = 'gpt-6.1-sol';
const report = { purpose: 'Isolated AI writing experiment; never an executed Flow step, accepted Spec or Gate result.', startedAt: new Date().toISOString(), sourcePath: path.resolve(sourcePath), sourceSha256: digest(sourceBytes), fixtureSelection, apiFixtureVersion, runnerSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))), models, reasoningEffort: 'medium', verificationModel, repetitionsPerCell: 1, canonicalBefore: snapshot(path.dirname(sourcePath)), trials: [] };
const reportFile = path.join(outputRoot, 'results.json');
function persist() { saveJson(reportFile, report); }

async function invoke(model, prompt, prefix) {
  const runtimeRoot = createTmpDir('writing-model-runtime-', { parent: outputRoot });
  const config = { agent: { default: 'experiment', timeout: 360, retryCount: 0, providers: { experiment: { command: 'codex', args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-m', model, '-c', 'model_reasoning_effort="medium"', '{{PROMPT}}'], jsonOutputFlag: '--json' } } } };
  const agent = new Agent({ config, paths: { root: runtimeRoot, agentWorkDir: runtimeRoot }, registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: path.join(runtimeRoot, 'logs'), enabled: false }) });
  const meter = new ProviderOutputMeter();
  const stdoutPath = prefix + '.events.jsonl';
  const stderrPath = prefix + '.stderr.log';
  fs.writeFileSync(stdoutPath, ''); fs.writeFileSync(stderrPath, '');
  const started = performance.now();
  const measured = { model, startedAt: new Date().toISOString(), promptCharacters: chars(prompt), promptSha256: digest(prompt), stdoutPath, stderrPath };
  fs.writeFileSync(prefix + '.prompt.txt', prompt);
  try {
    measured.text = await agent.call(prompt, { commandId: 'experiment.spec-writing', provider: 'experiment', cacheMode: 'bypass', flowAttribution: 'none', executionWorkDir: runtimeRoot, retryCount: 0,
      onStdout(chunk) { fs.appendFileSync(stdoutPath, chunk); meter.add(chunk); },
      onStderr(chunk) { fs.appendFileSync(stderrPath, chunk); } });
    measured.status = 'complete';
    fs.writeFileSync(prefix + '.output.txt', measured.text);
  } catch (error) {
    measured.status = 'failed';
    measured.error = { code: error.code, message: error.message };
  } finally {
    measured.durationMs = Math.round(performance.now() - started);
    measured.usage = meter.usages;
    measured.observedThreads = meter.launches;
    removeTmpDir(runtimeRoot);
  }
  return measured;
}

function verificationPrompt(fixture, candidate) {
  return `You are an independent specification decoder. Do not use tools or files. Read ONLY the candidate text below and reconstruct each listed entity's fields using its explicit definitions and inheritance. The original assignments are intentionally withheld. The value dictionary is an unordered vocabulary, NOT evidence that a value applies to an entity. Never infer from an entity name, conventional behavior or a filename. Return null for a field that cannot be uniquely reconstructed or contains a changed/new value not in its dictionary. Field IDs are the zero-based indices in each dictionary. A field value must preserve all information including ordering in usage strings; options listed as sets may be reordered if the set is identical. Return all entities, each with a values array in exactly the field order provided. Also identify ambiguous scopes, extra restrictions, or unresolved references in issues. For globalClauses, return the preservation verdict for each numbered clause using only the candidate. Output JSON only: {"rows":[{"entity":"...","values":[0,null,...]}],"issues":["..."],"globalClauses":[true,false,...]}.\nFIELD ORDER: ${JSON.stringify(fixture.fields)}\nENTITIES (names only): ${JSON.stringify(fixture.rows.map((row) => row.entity))}\nDICTIONARY (values only, no entity assignments): ${JSON.stringify(fixture.dictionary)}\nGLOBAL CLAUSES: ${fixture.id === 'actual-r4' ? JSON.stringify(['exactly all 66 leaves are covered', 'positional/rest names and arity are determined from Usage', 'flag and help take no value, value takes required value, optionalValue takes optional value', 'argv syntax is owned by parseEntryInput and cli.parseArgs', 'requiredness, type, emptiness, limits and conditional combinations are owned by the recorded handler and existing R5/R6 domain owners', 'internal _rawArgs, resolved target and injected runtime state are excluded from public options', 'verification compares recursive registry traversal against each handler/public CLI input boundary']) : JSON.stringify(['exactly all 12 operations are covered', 'each recorded owner owns authentication, authorization, input validation and retry responsibilities', 'verification covers normal responses, no side effects on rejection, no duplicate handling and audit records', 'exceptions are not generalized to other operations'])}\nCANDIDATE TEXT:\n${candidate}`;
}

async function runTrial(fixture, model, variant) {
  const id = fixture.id + '--' + model + '--' + variant;
  const trial = { id, fixture: fixture.id, model, variant, originalCharacters: chars(fixture.text), originalBytes: Buffer.byteLength(fixture.text) };
  report.trials.push(trial); persist();
  process.stdout.write('START ' + id + '\n');
  const generation = await invoke(model, baseline + (variant === 'generic' ? genericPolicy : '') + '\n\n原文:\n' + fixture.text, path.join(outputRoot, id + '.writer'));
  const candidate = generation.text;
  delete generation.text;
  trial.generation = generation;
  if (candidate !== undefined) {
    trial.outputCharacters = chars(candidate);
    trial.outputBytes = Buffer.byteLength(candidate);
    trial.reductionPercent = 100 * (1 - trial.outputCharacters / trial.originalCharacters);
    persist();
    const verification = await invoke(verificationModel, verificationPrompt(fixture, candidate), path.join(outputRoot, id + '.decoder'));
    const raw = verification.text;
    delete verification.text;
    trial.verification = verification;
    if (raw !== undefined) {
      try {
        const decoded = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
        const mismatches = [];
        const entityCounts = new Map();
        for (const row of decoded.rows) entityCounts.set(row.entity, (entityCounts.get(row.entity) ?? 0) + 1);
        for (const expected of fixture.rows) {
          const actual = decoded.rows.find((row) => row.entity === expected.entity);
          fixture.fields.forEach((field, index) => {
            if (!actual || actual.values[index] !== fixture.expectedIds(expected)[index]) mismatches.push({ entity: expected.entity, field, expected: expected[field], decoded: actual?.values[index] == null ? null : fixture.dictionary[field][actual.values[index]] });
          });
        }
        const entityIssues = [...entityCounts].filter(([entity, count]) => count !== 1 || !fixture.rows.some((row) => row.entity === entity));
        trial.comparison = { totalFacts: fixture.rows.length * fixture.fields.length, mismatches, entityIssues, decoderIssues: decoded.issues, globalClauses: decoded.globalClauses, allFactsPreservedByDecoder: mismatches.length === 0 && entityIssues.length === 0, verificationMethod: 'Independent AI decoder (original entity-value assignments withheld), followed by deterministic comparison; an AI-assisted check, not a formal semantic proof.' };
      } catch (error) { trial.verification.parseError = error.message; }
    }
  }
  process.stdout.write('DONE ' + id + ': ' + JSON.stringify({ status: generation.status, chars: trial.outputCharacters, writerSeconds: generation.durationMs / 1000, mismatches: trial.comparison?.mismatches.length, clauses: trial.comparison?.globalClauses }) + '\n');
  persist();
}

const jobs = fixtures.flatMap((fixture) => models.flatMap((model) => ['generic', 'baseline'].map((variant) => ({ fixture, model, variant }))));
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++];
    await runTrial(job.fixture, job.model, job.variant);
  }
}));
report.finishedAt = new Date().toISOString();
report.canonicalAfter = snapshot(path.dirname(sourcePath));
report.canonicalUnchanged = JSON.stringify(report.canonicalBefore) === JSON.stringify(report.canonicalAfter);
persist();
assert.equal(report.canonicalUnchanged, true, 'Canonical Spec, state and evidence must stay byte-for-byte unchanged.');
process.stdout.write('REPORT ' + reportFile + '\n');
