# ScriptPilot

ScriptPilot 是一个 Windows 绿色便携版 NodeJS 脚本调度器，定位是“本机无账号版青龙面板”：直接打开 EXE，管理定时任务、脚本、订阅、环境变量、配置文件、依赖和运行日志。

## 特性

- 绿色便携：发布目录根部只保留 `ScriptPilot.exe` 和 `app/`。
- 数据不外溢：任务、日志、缓存、依赖、Electron 会话数据都写入 `app/data`。
- 内置 Node：无需用户额外安装 Node/npm。
- 青龙式订阅：支持 GitHub 仓库、`owner/repo.git`、`ql repo`、`ql raw`。
- 自动依赖：脚本变更后预检依赖；运行时报缺模块时自动安装并重试。
- 实时日志：运行后立刻打开日志页，前端 1 秒轮询一次日志，边执行边显示。
- 本机 API：默认监听 `http://127.0.0.1:18760`，可通过 API 携带参数运行脚本。
- 无账号权限：没有登录、角色、权限校验，仅面向本机使用。

## 下载使用

从 GitHub Release 下载绿色版发布包，解压后目录应为：

```text
ScriptPilot.exe
app/
```

双击外层 `ScriptPilot.exe` 启动。不要直接运行 `app/ScriptPilot.exe`，外层启动器会保证绿色目录结构和运行路径正确。

## 数据目录

所有程序产生的数据都在：

```text
app/data/
```

常见子目录：

```text
state/          任务、运行记录、设置、环境变量
scripts/        用户脚本和订阅脚本
configs/        配置文件
logs/           stdout/stderr 和应用日志
node_modules/   自动安装的脚本依赖
repo/           Git 仓库订阅缓存
raw/            Raw 单文件订阅缓存
cache/          npm 等缓存
tmp/            临时目录
```

首次启动会自动生成 `app/data/README.md`，里面也有每个目录用途说明。

## 实时日志机制

ScriptPilot 参考青龙面板的做法：后端运行脚本时持续追加日志文件，前端日志页轮询读取日志。

- 青龙定时任务日志弹窗约每 2 秒请求一次日志接口。
- ScriptPilot 当前每 1 秒刷新一次当前运行日志。
- 点击运行后 UI 不再等待脚本结束，而是马上获得 `runId` 并打开日志页。
- 日志列表按脚本分组，组内按运行时间倒序。

## 本机 API 示例

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

更多接口见 [docs/README.md](docs/README.md)。

## 开发

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

项目不生成安装包；`dist:zip` 已禁用。发布压缩包请在 release 目录外另行打包干净产物。

## 验收

```powershell
node tools\human-acceptance.mjs
```

验收脚本覆盖中文 UI、脚本运行、定时任务、订阅、依赖自动安装、本机 API、日志清理和绿色目录约束。
