# AGENTS 维护入口

本文是 ScriptPilot 的唯一完整 AI 维护入口。Claude、Codex 或其他 AI 助手都只引用本文，不再维护多份规则。

## 读取顺序

1. 先读本文。
2. 普通用户说明只看 [README.md](README.md)。
3. 人类开发维护说明看 [docs/development.md](docs/development.md)。
4. 需要执行代码改动、构建、发布或规范判断时，按需读取仓库内 skill：
   - [ScriptPilot 维护 Skill](docs/ai/skills/scriptpilot-maintenance/SKILL.md)
   - [项目规范](docs/ai/skills/scriptpilot-maintenance/references/project-standards.md)
   - [代码生成规范](docs/ai/skills/scriptpilot-maintenance/references/code-generation.md)
   - [产物发布规范](docs/ai/skills/scriptpilot-maintenance/references/release-artifacts.md)

## 文档边界

- `README.md` 只写给最终用户，不放开发、验收、AI、内部架构细节。
- `docs/development.md` 写给维护者，可以包含架构、构建、验收和路径约束。
- `AGENTS.md` 是唯一 AI 维护入口。
- `CLAUDE.md` 只引用 `AGENTS.md`。
- `docs/ai/skills/scriptpilot-maintenance/` 存放可复用 AI skill 和细分规范。

## 项目事实

- 产品是 Windows 绿色便携版 Electron 应用。
- 最终用户只运行 `release/win-unpacked/ScriptPilot.exe`。
- 应用数据必须写入 `release/win-unpacked/app/data/`。
- 源码仓库不提交 `release/`、`node_modules/`、`.tools/`、本地 `data/`。
- GitHub Release 附件必须排除 `app/data/`。
- 默认本机 API 只监听 `http://127.0.0.1:18760`。

## 工作规则

- 修改文件前先读相关上下文，不凭记忆改。
- 手工编辑文件必须用 `apply_patch`。
- 不要删除或覆盖 `release/win-unpacked/app/data/`。
- 不要把 CK、日志、本地数据、缓存、测试临时目录提交或打包发布。
- UI 改动要同步到 `release/win-unpacked/app/resources/app/` 对应源码文件。
- 当前 EXE 正在运行时，不要强杀进程；如需改内层 EXE 资源，提示用户先关闭程序。
- 推送 GitHub 或发 Release 前，先确认产物不包含 `app/data/`。
- GitHub Release 页面说明只写中文更新说明和修复内容；不要写“发布产物”“校验信息”、SHA256 或 `.sha256` 文件名；不要生成或上传 `.sha256` 附件。

## 验证基线

按改动范围选择验证，不做无意义全量测试：

- JS 语法：`node --check <file>`
- 后端服务路径：用隔离 `portableRoot` 创建临时 app 做集成测试。
- Electron UI：用 Playwright `_electron` 和隔离 `cwd`，设置独立 `SCRIPTPILOT_API_PORT`。
- release 副本：同步后对 `release/win-unpacked/app/resources/app/...` 再做语法检查。
- 打包产物：检查 zip 内不含 `app/data/`。

## 常见改动入口

- Electron 主进程：`src/electron/main.js`
- Preload API：`src/electron/preload.cjs`
- Renderer UI：`src/electron/renderer/`
- 本机 API：`src/electron/api-server.js`
- 任务：`src/main/modules/tasks/`
- 运行和日志：`src/main/modules/runs/`
- 青龙式脚本、订阅、环境、配置：`src/main/modules/qinglong/`
- 绿色路径：`src/main/bootstrap/portable-paths.js`
- 构建/产物：`package.json`、`tools/create-portable-layout.mjs`、`tools/fix-portable-runtime.mjs`

## 交付习惯

- 优先完成端到端改动：源码、release 资源、验证、说明。
- 最终回复只说用户需要知道的结果、验证和风险。
- 如果需要发布到 GitHub，源码走 Git commit/push，便携产物走 GitHub Release 附件，不把 release zip 提交进仓库。
