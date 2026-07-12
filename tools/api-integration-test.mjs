// 临时集成测试：隔离 portableRoot 下验证 API server 主要链路。
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/main/app/create-app.js';
import { startApiServer } from '../src/electron/api-server.js';

const root = path.join(os.tmpdir(), `sp-api-test-${Date.now()}`);
const app = await createApp({ portableRoot: root });
const api = startApiServer(app, { port: 18790 });
await new Promise((resolve) => api.server.once('listening', resolve));
const base = api.url;
let failures = 0;

async function call(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json(), headers: response.headers };
}

function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`, detail ?? ''); }
}

const health = await call('GET', '/api/health');
check('health 200', health.status === 200 && health.json.ok);
check('无 CORS 头', !health.headers.get('access-control-allow-origin'));

const created = await call('POST', '/api/tasks', {
  name: '集成测试任务',
  scriptContent: 'console.log("integration ok", process.env.SCRIPTPILOT_TRIGGER)',
  cronExpression: '5 4 * * 7',
  timeoutMs: 30000
});
check('创建任务(cron 周7)', created.status === 200 && created.json.data.taskId, created.json);
const taskId = created.json.data?.taskId;

const listed = await call('GET', '/api/tasks');
check('任务列表', listed.json.data.items.some((t) => t.id === taskId));

const run = await call('POST', `/api/tasks/${taskId}/run`, {});
check('运行任务成功', run.status === 200 && run.json.data.run.status === 'success', JSON.stringify(run.json).slice(0, 400));
check('日志包含输出', String(run.json.data.log.text || '').includes('integration ok'));

const missing = await call('GET', '/api/runs/not-exist-id');
check('缺失运行返回 404', missing.status === 404, missing.status);

const badTask = await call('POST', '/api/tasks', { name: '' });
check('无效任务返回 400', badTask.status === 400, badTask.status);

const notFoundRoute = await call('GET', '/api/no-such-route');
check('未知路由 404', notFoundRoute.status === 404);

const env = await call('POST', '/api/ql/envs', { name: 'TEST_CK', value: 'abc123' });
check('保存环境变量', env.status === 200 && env.json.data.name === 'TEST_CK');
const envs = await call('GET', '/api/ql/envs');
check('环境变量列表', envs.json.data.items.length === 1);

const settings = await call('POST', '/api/settings', { logCleanup: { retentionDays: 15 } });
check('保存设置', settings.json.data.logCleanup.retentionDays === 15);

const scriptRun = await call('POST', '/api/scripts/run', {
  name: 'env-check',
  scriptContent: 'console.log("CK=" + (process.env.TEST_CK ? "present" : "missing"))'
});
check('脚本运行读到环境变量', String(scriptRun.json.data.log?.text || '').includes('CK=present'), JSON.stringify(scriptRun.json).slice(0, 400));

// 并发写入压力：并发切换任务启用状态 + 保存变量，验证无丢失更新
await Promise.all([
  ...Array.from({ length: 8 }, (_, i) => call('POST', '/api/ql/envs', { name: `VAR_${i}`, value: String(i) })),
  call('PATCH', `/api/tasks/${taskId}/enabled`, { enabled: false })
]);
const envsAfter = await call('GET', '/api/ql/envs');
check('并发保存变量不丢失', envsAfter.json.data.items.length === 9, envsAfter.json.data.items.length);
const tasksAfter = await call('GET', '/api/tasks');
check('并发下任务状态正确', tasksAfter.json.data.items.find((t) => t.id === taskId)?.enabled === false);

api.server.close();
await rm(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
