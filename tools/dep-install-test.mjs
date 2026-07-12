// 依赖自动安装回归：脚本 require 缺失的 npm 包，应自动装到 data/node_modules 并重试成功。
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/main/app/create-app.js';
import { runScriptOnceCommand } from '../src/main/modules/runs/application/commands/run-script-once.command.js';
import { getRunQuery } from '../src/main/modules/runs/application/queries/get-run.query.js';
import { getRunLogQuery } from '../src/main/modules/runs/application/queries/get-run-log.query.js';

const root = path.join(os.tmpdir(), `sp-dep-test-${Date.now()}`);
const app = await createApp({ portableRoot: root });

const result = await app.commandBus.execute(runScriptOnceCommand({
  name: 'dep-test',
  scriptContent: 'const ms = require("ms"); console.log("ms-result:", ms("2h"));',
  timeoutMs: 180000
}));
const run = await app.queryBus.execute(getRunQuery({ runId: result.data.runId }));
const log = await app.queryBus.execute(getRunLogQuery({ runId: result.data.runId, stream: 'combined' }));
console.log('status:', run.status);
console.log('dependencyCheck:', JSON.stringify(run.dependencyCheck?.status));
console.log(log.text.slice(0, 600));
const ok = run.status === 'success' && log.text.includes('ms-result: 7200000');
console.log(ok ? 'PASS 依赖自动安装' : 'FAIL 依赖自动安装');
await rm(root, { recursive: true, force: true }).catch(() => undefined);
process.exit(ok ? 0 : 1);
