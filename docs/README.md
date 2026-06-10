# ScriptPilot 维护说明

ScriptPilot 是一个 Windows 绿色版 Electron 应用，用来本机执行和调度 NodeJS 脚本。当前目标是目录版 EXE，不做安装包，不做压缩包。

## 产物

最终可运行目录：

```text
release/win-unpacked/
  ScriptPilot.exe          外层启动器，用户只需要双击这个
  app/                     实际程序文件、内置 Node、data 数据目录
    ScriptPilot.exe
    runtime/node/active/node.exe
    runtime/node/active/npm.cmd
    data/
```

直接运行：

```powershell
.\release\win-unpacked\ScriptPilot.exe
```

目录整理目标：

```text
release/win-unpacked/ 根目录只保留 2 个项目
  ScriptPilot.exe
  app/
```

构建目录版：

```powershell
npm run dist:dir
```

`npm run dist` 当前也指向目录版构建。`dist:zip` 已禁用，后续不要生成 zip、7z、rar、tar、gz。

## 数据目录

应用自身产生的数据必须在绿色版目录内，当前都位于 `app/data`：

```text
release/win-unpacked/app/data/
```

关键路径：

```text
app/data/README.md           绿色数据目录说明，会在启动时自动生成/刷新
app/data/state/              任务、运行记录、设置、环境变量
app/data/scripts/            用户脚本和订阅脚本
app/data/logs/               运行日志和应用日志
app/data/state/log-cleanup-state.json 最近一次日志清理结果
app/data/cache/npm/          npm 缓存
app/data/node_modules/       自动安装的脚本依赖
app/data/tmp/                临时目录
app/data/profile/            APPDATA/LOCALAPPDATA 重定向
app/data/home/               HOME/USERPROFILE 重定向
```

代码入口在 `src/main/bootstrap/portable-paths.js`。脚本路径、工作目录、日志路径会校验必须位于安装目录内。脚本子进程的 `TEMP/TMP/HOME/APPDATA/LOCALAPPDATA/npm_config_cache/NODE_PATH` 会重定向到 `data`。

配置文件页提供“打开目录/打开所在目录”，对应 `app/data/configs`。脚本管理页提供“打开目录/打开所在目录”，对应 `app/data/scripts` 或当前脚本所在目录。打开目录由主进程统一校验，只允许打开安装目录内路径。

日志清理默认启用，每 3 天检查一次，清理超过 30 天的运行日志；系统设置里修改后会自动保存并实时生效，无需点击保存。也可点击“立即清理”或调用 `POST /api/logs/cleanup` 手动执行。清理会删除过期运行记录和对应 `data/logs/tasks` 下的 stdout/stderr 文件，不会清理正在运行的日志。

限制：如果用户脚本主动写入外部绝对路径，例如 `C:\xxx`，Windows 不会自动拦截。要阻止恶意脚本越界写入，需要另做低权限沙箱或 ACL 隔离，这和“最高权限运行”冲突。

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

运行脚本示例：

```powershell
$body = @{
  name = '接口运行'
  scriptContent = 'console.log(process.argv.slice(2)); console.log(process.env.SCRIPTPILOT_PARAMS)'
  args = @('参数1')
  params = @{ 来源 = 'API' }
  cwd = 'data'
  timeoutMs = 30000
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:18760/api/scripts/run' `
  -Method Post `
  -ContentType 'application/json; charset=utf-8' `
  -Body $body
```

## 验收

目录版构建后运行：

```powershell
node tools\human-acceptance.mjs
```

验收覆盖：

- 中文 UI。
- 首屏进入定时任务。
- 脚本保存、运行、查看日志。
- 任务创建、批量运行、更多菜单、详情、视图、删除。
- 本机 HTTP 订阅拉取并真实执行。完整验收默认不依赖 GitHub，避免外网波动导致误报。
- 本机 API 携带 args/params 运行脚本。
- 环境变量 API。
- 缺失依赖自动安装，脚本未变更时跳过预检。
- 日志清理默认配置、保存配置、手动清理过期日志并保留新日志。
- 绿色路径环境变量。
- 外部绝对脚本路径和工作目录拒绝。

GitHub 订阅功能已用真实网络单独复测通过：

```text
source: https://github.com/nodejs/examples/tree/main/cli/yargs/countEntriesInDirectory
pulledFileCount: 6
scriptPath: data/scripts/subscriptions/.../bin/cli.js
dependencySpecs.yargs: ^15.3.1
output: 4
```

EXE smoke：

```powershell
$env:SCRIPTPILOT_SMOKE_RUN_DEMO='1'
.\release\win-unpacked\app\ScriptPilot.exe --smoke-run-demo
```

## 保留目录说明

```text
src/            源码
runtime/        构建时打包进 release 的内置 Node
tools/          构建后修正 runtime、完整验收
release/win-unpacked/ 当前目录版便携产物，主目录只保留启动器和 app 目录
node_modules/   开发依赖，构建和验收需要
```

`vendor/qinglong`、`ui-mockups`、根目录 `data`、测试生成的外部路径文件都不是当前运行或构建必需内容，已清理。
