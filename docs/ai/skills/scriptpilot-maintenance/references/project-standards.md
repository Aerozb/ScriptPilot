# 项目规范

## 产品边界

- ScriptPilot 是本机使用的 Windows 绿色便携版 Electron 应用。
- 不做账号体系、角色体系或公网服务。
- 目标体验参考青龙面板，但数据和运行时留在本机目录。

## 数据目录

所有应用数据必须在便携目录内：

```text
release/win-unpacked/app/data/
```

关键约束：

- 不把用户数据写到 AppData。
- 不覆盖 `release/win-unpacked/app/data/`。
- 不把 `app/data/` 打进 GitHub Release 附件。
- 测试必须使用隔离 `portableRoot` 或隔离 Electron `cwd`。

## 架构分层

```text
src/electron/             Electron main、preload、本机 API、renderer
src/main/bootstrap/       绿色路径和目录约束
src/main/app/             应用装配
src/main/shared/          CommandBus、QueryBus、错误和通用基础设施
src/main/modules/tasks/   任务聚合、命令、查询、JSON repository
src/main/modules/runs/    运行记录、脚本执行、日志读取
src/main/modules/qinglong/ 环境、配置、脚本、订阅、依赖服务
```

Renderer 是普通 HTML/CSS/JS，不使用 React。后端是 ESM Node 模块。

## UI 行为

- 任务日志和订阅日志优先用弹窗展示。
- 任务选择脚本使用树型弹窗，复用脚本管理页的树型心理模型。
- 选择已有脚本时不要展示脚本内容输入框。
- 表格内高频操作使用事件委托，避免每次渲染重新绑定大量节点事件。
- 启用、禁用、置顶等轻量操作优先做乐观更新，失败再回滚。
- 长列表或输入搜索要节流或避免不必要的全量刷新。

## 运行和日志

- `waitForCompletion: false` 时尽快返回 `runId`。
- 前端通过 `getRun` 和 `getRunLog` 轮询实时日志。
- 不在隐藏页面里反复重绘大型列表。
- 日志清理不得删除正在运行的日志。

## 订阅

- 支持 GitHub 仓库、GitHub Raw、普通 HTTP、`ql repo`、`ql raw`。
- 订阅名称优先作为本地脚本目录名。
- 自动建任务只基于明确可解析的 cron 声明，不猜测。
- 没有 cron、cron 无效、已存在同脚本任务时跳过。

## 环境变量

- 同名环境变量运行时用 `&` 拼接。
- UI 列表遮罩变量值。
- 测试 CK 只能验证存在性，不能输出完整值到日志或最终回复。
