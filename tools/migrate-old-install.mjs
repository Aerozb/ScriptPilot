// 一次性迁移：把桌面旧安装(嵌套 data\data)的任务/订阅/脚本合并到当前 release 安装。
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const oldRoot = 'C:/Users/Administrator/Desktop/ScriptPilot/release/win-unpacked/app/data/data';
const curData = 'release/win-unpacked/app/data';
const backupDir = path.join(curData, 'backup-old-install-20260711');

const readJson = async (p, fallback) => {
  try { return JSON.parse((await readFile(p, 'utf8')).replace(/^﻿/, '')); } catch { return fallback; }
};
const writeJson = (p, v) => writeFile(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');

// 1. 整体备份旧数据到当前安装内
await mkdir(backupDir, { recursive: true });
await cp(oldRoot, path.join(backupDir, 'data'), { recursive: true });
console.log('已备份旧数据到', backupDir);

// 2. 复制 faker3 脚本目录（不覆盖已存在文件）
await cp(path.join(oldRoot, 'scripts', 'faker3'), path.join(curData, 'scripts', 'faker3'), { recursive: true, force: false }).catch(async (e) => {
  if (e.code !== 'ERR_FS_CP_EEXIST') throw e;
});
console.log('已合并 scripts/faker3');

// 3. 合并任务（按名称去重，旧任务补进来）
const oldTasks = await readJson(path.join(oldRoot, 'state', 'tasks.json'), []);
const curTasks = await readJson(path.join(curData, 'state', 'tasks.json'), []);
const curNames = new Set(curTasks.map((t) => t.name));
const added = oldTasks.filter((t) => !curNames.has(t.name));
await writeJson(path.join(curData, 'state', 'tasks.json'), [...curTasks, ...added]);
console.log(`任务合并：原有 ${curTasks.length}，迁入 ${added.length}，共 ${curTasks.length + added.length}`);

// 4. 合并订阅（按 id 去重，其次按名称）
const oldSubs = await readJson(path.join(oldRoot, 'state', 'subscriptions.json'), []);
const curSubs = await readJson(path.join(curData, 'state', 'subscriptions.json'), []);
const curSubKeys = new Set(curSubs.flatMap((s) => [s.id, s.name]));
const addedSubs = oldSubs.filter((s) => !curSubKeys.has(s.id) && !curSubKeys.has(s.name));
await writeJson(path.join(curData, 'state', 'subscriptions.json'), [...curSubs, ...addedSubs]);
console.log(`订阅合并：原有 ${curSubs.length}，迁入 ${addedSubs.length}`);

// 5. 合并环境变量（旧的为空则跳过）
const oldEnvs = await readJson(path.join(oldRoot, 'state', 'envs.json'), []);
if (oldEnvs.length) {
  const curEnvs = await readJson(path.join(curData, 'state', 'envs.json'), []);
  const curEnvKeys = new Set(curEnvs.map((e) => `${e.name}=${e.value}`));
  const addedEnvs = oldEnvs.filter((e) => !curEnvKeys.has(`${e.name}=${e.value}`));
  await writeJson(path.join(curData, 'state', 'envs.json'), [...curEnvs, ...addedEnvs]);
  console.log(`变量合并：迁入 ${addedEnvs.length}`);
} else {
  console.log('旧环境变量为空，保留现有变量');
}

// 6. 合并配置文件（仅复制旧安装里非空且当前不存在的）
for (const name of ['config.sh', 'extra.sh', 'notify.js']) {
  const src = path.join(oldRoot, 'configs', name);
  const dst = path.join(curData, 'configs', name);
  try {
    await access(dst);
  } catch {
    await cp(src, dst).catch(() => undefined);
    console.log(`配置迁入: ${name}`);
  }
}

// 7. 校验脚本文件都存在
const finalTasks = await readJson(path.join(curData, 'state', 'tasks.json'), []);
let missing = 0;
for (const t of finalTasks) {
  try { await access(path.join('release/win-unpacked/app', t.scriptPath)); } catch { missing += 1; console.log('缺脚本:', t.name, t.scriptPath); }
}
console.log(missing ? `${missing} 个任务缺脚本文件` : '全部任务脚本文件就位');
