# ScriptPilot 维护说明

ScriptPilot 是 Windows 绿色便携版 Electron 应用，用来本机执行和调度 NodeJS 脚本。当前目标是目录版 EXE，不做安装包。

## 产物结构

最终可运行目录：

```text
release/win-unpacked/
  ScriptPilot.exe          外层启动器，用户只需要双击这个
  app/                     实际程序文件、内置 Node、运行时资源
```

直接运行：

```powershell
.\release\win-unpacked\ScriptPilot.exe
```

构建目录版：

```powershell
npm run dist:dir
```

`npm run dist` 当前也指向目录版构建。`dist:zip` 已禁用，日常构建不要生成 zip、7z、rar、tar、gz。需要 GitHub Release 附件时，在源码目录外对干净产物单独打包。

## 数据目录

应用自身产生的数据必须在绿色版目录内：

```text
release/win-unpacked/app/data/
```

关键路径：

```text
app/data/README.md           绿色数据目录说明，启动时自动生成/刷新
app/data/state/              任务、运行记录、设置、环境变量
app/data/scripts/            用户脚本和订阅脚本
app/data/configs/            配置文件
app/data/logs/               运行日志和应用日志
app/data/cache/npm/          npm 缓存
app/data/node_modules/       自动安装的脚本依赖
app/data/repo/               Git 仓库订阅缓存
app/data/raw/                Raw 单文件订阅缓存
app/data/tmp/                临时目录
app/data/profile/            APPDATA/LOCALAPPDATA 重定向
app/data/home/               HOME/USERPROFILE 重定向
```

代码入口在 `src/main/bootstrap/portable-paths.js`。脚本路径、工作目录、日志路径会校验必须位于安装目录内。脚本子进程的 `TEMP/TMP/HOME/APPDATA/LOCALAPPDATA/npm_config_cache/NODE_PATH` 会重定向到 `data`。

限制：如果用户脚本主动写入外部绝对路径，例如 `C:\xxx`，Windows 不会自动拦截。要阻止恶意脚本越界写入，需要低权限沙箱或 ACL 隔离，这和“最高权限运行”冲突。

## 默认外观

默认外观必须保持亮色绿色：

```json
{
  "theme": "light",
  "accent": "emerald",
  "density": "comfortable",
  "fontScale": 100,
  "radius": 18
}
```

自动验收脚本不得修改外观设置。

## 实时日志

青龙面板的定时任务日志弹窗不是 WebSocket 推送，而是：

1. 后端运行脚本时持续追加日志文件。
2. 前端弹窗周期性请求日志接口。
3. 前端判断日志未结束就继续请求并自动滚动到底部。

ScriptPilot 按同一思路实现：

1. `waitForCompletion: false` 时，主进程创建运行记录后立即返回 `runId`。
2. 后台继续执行依赖预检、脚本运行、缺依赖自愈重试和最终状态落库。
3. 渲染层拿到 `runId` 后马上进入日志页。
4. 当前运行状态为 `running` 时，每 1 秒调用 `getRun` + `getRunLog` 刷新。
5. 日志列表按脚本分组，组内按 `startedAt` 倒序。

相关文件：

```text
src/main/modules/runs/application/commands/run-task-now.handler.js
src/main/modules/runs/application/commands/run-script-once.handler.js
src/main/shared/infrastructure/process/process-runner.js
src/electron/renderer/renderer.js
```

## 架构

当前采用模块化单体，接近 DDD-lite + CQRS-lite：

```text
src/main/bootstrap/       绿色路径和启动目录
src/main/app/             应用装配
src/main/shared/          CommandBus、QueryBus、错误、通用基础设施
src/main/modules/tasks/   任务聚合、命令、查询、JSON repository
src/main/modules/runs/    运行记录、执行脚本、日志读取
src/main/modules/logs/    定期日志清理
src/main/modules/scheduler/ Cron 调度
src/main/modules/runtime/ 内置 Node 运行时解析
src/main/modules/dependencies/ 脚本依赖检测和 npm 自动安装
src/main/modules/qinglong/ 本地青龙式脚本/环境/配置/订阅/依赖服务
src/main/modules/startup/ Windows 任务计划开机启动
src/main/modules/settings/ 设置持久化
src/electron/             Electron main、preload、本机 API、renderer
```

数据当前使用 JSON 文件持久化，不使用 SQLite。

## 本机 API

默认监听：

```text
http://127.0.0.1:18760
```

无账号、无权限校验，只监听本机地址。

常用接口：

```text
GET  /api/health
POST /api/scripts/run
GET  /api/tasks
POST /api/tasks
POST /api/tasks/{id}/run
GET  /api/runs
GET  /api/runs/{id}/log
GET  /api/settings
POST /api/settings
POST /api/logs/cleanup
GET  /api/ql/envs
POST /api/ql/envs
GET  /api/ql/scripts
POST /api/ql/scripts
GET  /api/ql/subscriptions
POST /api/ql/subscriptions
GET  /api/ql/dependencies
POST /api/ql/dependencies
GET  /api/startup
POST /api/startup/enable
POST /api/startup/disable
```

`POST /api/scripts/run` 默认等待脚本执行完成并返回 `{ run, log }`。如果传入：

```json
{ "waitForCompletion": false }
```

则立即返回 `{ "runId": "...", "started": true }`，调用方可继续轮询 `GET /api/runs/{id}` 和 `GET /api/runs/{id}/log`。

## 订阅

订阅支持：

```text
https://github.com/shufflewzc/faker2.git
shufflewzc/faker2.git
git@github.com:shufflewzc/faker2.git
ql repo https://github.com/shufflewzc/faker2.git "USER_AGENTS|function/common" "" "" ""
ql raw https://raw.githubusercontent.com/owner/repo/main/demo.js
```

订阅脚本目录优先使用“订阅名称”。例如订阅名称填 `faker3`、地址填 `https://github.com/shufflewzc/faker3.git`，拉取后脚本目录就是 `data/scripts/faker3`，仓库缓存目录是 `data/repo/faker3`。

## 依赖

依赖处理逻辑：

1. 脚本或相对 helper 文件内容变化后才做预检。
2. 预检扫描 `require/import`，自动安装缺失包到 `data/node_modules`。
3. 运行时报 `Cannot find module` 时自动安装并重试，最多 5 轮。
4. npm 缓存、prefix、临时目录都在 `app/data` 下。

## 日志清理

日志清理默认启用：

```text
检查周期：3 天
保留天数：30 天
```

系统设置里修改后自动保存并实时生效，无需点击保存。也可点击“立即清理”或调用 `POST /api/logs/cleanup`。清理会删除过期运行记录和对应 `data/logs/tasks` 下的 stdout/stderr 文件，不会清理正在运行的日志。

## 验收

目录版构建后运行：

```powershell
node tools\human-acceptance.mjs
```

重点覆盖：

- 中文 UI。
- 首屏进入定时任务。
- 脚本保存、运行、实时日志。
- 任务创建、批量运行、更多菜单、详情、视图、删除。
- 本机 HTTP 订阅拉取并执行。
- 本机 API 携带 args/params 运行脚本。
- 环境变量 API。
- 缺失依赖自动安装，脚本未变更时跳过预检。
- 日志清理默认配置、保存配置、手动清理过期日志并保留新日志。
- 绿色路径环境变量。
- 外部绝对脚本路径和工作目录拒绝。

## 保留目录说明

```text
src/            源码
runtime/        构建时打包进 release 的内置 Node
tools/          构建后修正 runtime、完整验收
node_modules/   开发依赖，本地构建和验收需要，不提交
release/        构建输出，不提交源码仓库
```

`vendor/qinglong`、`ui-mockups`、根目录 `data`、测试生成的外部路径文件都不是当前运行或构建必需内容，应清理。
