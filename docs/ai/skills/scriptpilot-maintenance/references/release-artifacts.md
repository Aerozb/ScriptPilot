# 产物发布规范

## 构建入口

```powershell
npm install
npm run dist:dir
```

当前发布的是目录版便携产物：

```text
release/win-unpacked/
  ScriptPilot.exe
  app/
```

## 便携目录

- 最终用户运行 `release/win-unpacked/ScriptPilot.exe`。
- 用户数据只允许留在 `release/win-unpacked/app/data/`。
- 更新源码或 release resource 时，不得删除、覆盖或打包 `app/data/`。
- 当前源码仓库不提交 `release/`，GitHub Release 附件单独上传产物压缩包。

## Release Resource 同步

当需要让现有便携 EXE 重启后直接看到改动时，把对应源码同步到：

```text
release/win-unpacked/app/resources/app/
```

常见同步对象：

- `src/electron/renderer/`
- `src/electron/preload.cjs`
- `src/electron/main.js`
- `src/electron/api-server.js`
- `src/main/`

同步后对 release 副本也运行必要语法检查。

## 图标

- 图标源文件：`build/icon.svg`
- ICO 输出：`build/icon.ico`
- 生成脚本：`tools/generate-icon.mjs`
- 外层启动器由 `tools/create-portable-layout.mjs` 生成，并嵌入 `build/icon.ico`。

图标异常时先检查 `build/icon.ico` 是否存在，再重新运行构建。

## 打包规则

发布压缩包必须从干净的 `release/win-unpacked/` 生成，并排除：

```text
app/data/
```

不得包含：

- CK、环境变量明文、日志、缓存、临时目录。
- `.tools/`、`node_modules/`、本地测试数据。
- 任何用户机器生成的私有状态。

## GitHub

- 每次发布 GitHub Release 必须递增版本号，例如 `v0.1.0` -> `v0.1.1`。
- 只要上传新的便携产物，就必须新建递增 tag；禁止复用旧 tag 覆盖新功能产物。
- 禁止把新功能覆盖发布到旧 tag；旧版本只在补传同一版本校验文件时才允许覆盖附件。
- 发布前必须同步修改 `package.json` 和 `package-lock.json` 的版本号。
- 发布压缩包命名必须带当前版本号，例如 `ScriptPilot-v0.1.1-portable.zip`。
- Release 说明必须写清楚本版本新增功能、验收结果和 SHA256。
- 源码通过 Git commit/push 上传。
- 便携产物通过 GitHub Release 附件上传，不提交进源码仓库。
- 上传前先检查压缩包内容，确认没有 `app/data/`。
- 发布完成后再次检查 `git status`，只能剩下被忽略的 `release/`、`node_modules/` 或运行时目录。
