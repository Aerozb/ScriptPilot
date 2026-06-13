# ScriptPilot 文档索引

这里放开发、维护和 AI 协作相关文档。普通用户只需要看根目录的 [README.md](../README.md)。

## 用户文档

- [用户说明](../README.md)：下载、启动、功能说明、数据目录和常见问题。

## 开发维护

- [开发维护说明](development.md)：架构、数据目录、构建、验收和维护注意事项。

## AI 协作

- [AGENTS 入口](../AGENTS.md)：唯一完整 AI 维护入口。
- [Claude 入口](../CLAUDE.md)：只引用 AGENTS 入口，不重复维护规范。
- [ScriptPilot 维护 Skill](ai/skills/scriptpilot-maintenance/SKILL.md)：仓库内 skill 结构，按需读取代码规范、项目规范和产物规范。

## 发布产物

构建输出位于 `release/win-unpacked/`，源码仓库不提交 `release/`。发布 GitHub Release 时，产物压缩包必须排除 `app/data/`。
