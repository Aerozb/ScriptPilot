# 开发维护说明

本文给维护者看，不面向普通用户。用户说明只维护根目录 [README.md](../README.md)。

## 项目定位

ScriptPilot 是 Windows 绿色便携版 Electron 应用，用来在本机执行和调度 NodeJS 脚本。当前只发布目录版便携产物，不做安装包。

## 目录结构

```text
src/            源码
runtime/        构建时打包进 release 的内置 Node
tools/          图标生成、便携布局修正、完整验收
build/          图标等构建资源
docs/           开发维护和 AI 协作文档
release/        构建输出，不提交源码仓库
node_modules/   开发依赖，不提交源码仓库
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
src/main/modules/qinglong/ 本地青龙式脚本、环境、配置、订阅、依赖服务
src/main/modules/startup/ Windows 任务计划开机启动
src/main/modules/settings/ 设置持久化
src/electron/             Electron main、preload、本机 API、renderer
```

数据当前使用 JSON 文件持久化，不使用 SQLite。

## 重构和性能底线

- 内部模块可以直接重构，不为旧内部接口保留兼容层；但用户数据不能无故丢失。
- 业务规则只保留一个事实来源，重复到第 3 次必须抽函数或模块。
- Renderer 新增能力优先拆成纯计算函数和小渲染函数，避免继续扩大单个大函数。
- 列表和树型 UI 必须避免重复 DOM 写入；树节点统计在构建树时完成。
- 批量操作必须走批量接口，避免多次 IPC 和多次 JSON 写入。
- 隐藏页面不持续重绘，日志轮询只服务当前日志页或打开的弹窗。

## 绿色目录约束

应用自身产生的数据必须留在便携目录内：

```text
release/win-unpacked/app/data/
```

关键路径：

```text
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

路径约束入口在 `src/main/bootstrap/portable-paths.js`。脚本子进程的 `TEMP/TMP/HOME/APPDATA/LOCALAPPDATA/npm_config_cache/NODE_PATH` 会重定向到 `data`。

限制：如果用户脚本主动写入外部绝对路径，Windows 不会自动拦截。要阻止恶意脚本越界写入，需要低权限沙箱或 ACL 隔离，这和“最高权限运行”冲突。

## 构建

```powershell
npm install
npm run dist:dir
```

构建产物：

```text
release/win-unpacked/
  ScriptPilot.exe
  app/
```

`npm run dist` 当前也指向目录版构建。`dist:zip` 已禁用。GitHub Release 附件需要单独从干净的 `release/win-unpacked` 打包，并排除 `app/data/`。

## 图标

图标源文件和生成脚本：

```text
build/icon.svg
build/icon.ico
tools/generate-icon.mjs
```

`npm run dist:dir` 会先运行 `npm run icon:generate`。外层启动器由 `tools/create-portable-layout.mjs` 编译，并通过 `/win32icon:build/icon.ico` 嵌入图标。

## 实时日志

ScriptPilot 的实时日志采用轮询：

1. 主进程创建运行记录后立即返回 `runId`。
2. 后台继续执行依赖预检、脚本运行、缺依赖自愈重试和最终状态落库。
3. 渲染层通过 `getRun` 和 `getRunLog` 每秒刷新当前运行日志。
4. 任务和订阅日志优先使用弹窗展示；日志页只在用户进入时渲染运行记录列表。

相关文件：

```text
src/main/modules/runs/application/commands/run-task-now.handler.js
src/main/modules/runs/application/commands/run-script-once.handler.js
src/main/shared/infrastructure/process/process-runner.js
src/electron/renderer/renderer.js
```

## 订阅

订阅支持 GitHub 仓库、GitHub Raw、普通 HTTP 脚本、`ql repo` 和 `ql raw`。订阅名称优先作为本地目录名，例如订阅名称 `faker3` 会拉取到 `data/scripts/faker3`。

勾选自动建任务时，会解析脚本中的 cron 声明。没有 cron 或 cron 无效的脚本跳过，不强行创建任务。自动创建的任务名称优先取脚本里的 `new Env('任务名')`，没有时再取 cron tag，最后取脚本文件名。

## 依赖

依赖处理逻辑：

1. 脚本或相对 helper 文件内容变化后才做预检。
2. 预检扫描 `require/import`，自动安装缺失包到 `data/node_modules`。
3. 运行时报 `Cannot find module` 时自动安装并重试，最多 5 轮。
4. npm 缓存、prefix、临时目录都在 `app/data` 下。

## 验收

目录版构建后运行：

```powershell
node tools\human-acceptance.mjs
```

重点覆盖中文 UI、脚本保存运行、实时日志、定时任务、订阅、环境变量、本机 API、依赖自愈、日志清理和绿色目录约束。

## AI 协作规范

AI 维护入口不要写在本文里。统一看：

```text
AGENTS.md
CLAUDE.md
docs/ai/skills/scriptpilot-maintenance/SKILL.md
```
