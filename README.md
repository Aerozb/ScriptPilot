# ScriptPilot

ScriptPilot 是一个 Windows 绿色便携版 NodeJS 脚本调度器。它不需要登录账号，也不需要额外安装 Node，解压后双击启动，就能在本机管理脚本、定时任务、订阅、环境变量、依赖和运行日志。

## 下载和启动

1. 在 GitHub Release 下载 `ScriptPilot-win-unpacked.zip`。
2. 解压到你想放置的位置，例如 `D:\Tools\ScriptPilot`。
3. 双击最外层的 `ScriptPilot.exe` 启动。

解压后的目录应类似：

```text
ScriptPilot.exe
app/
```

不要直接运行 `app/ScriptPilot.exe`。外层 `ScriptPilot.exe` 是便携启动器，会保证程序在正确目录下运行。

## 数据保存位置

ScriptPilot 的数据都保存在程序目录内：

```text
app/data/
```

常见目录：

```text
state/          任务、运行记录、设置、环境变量
scripts/        你保存的脚本和订阅拉取的脚本
configs/        配置文件
logs/           任务输出日志和应用日志
node_modules/   自动安装的脚本依赖
repo/           Git 仓库订阅缓存
raw/            Raw 单文件订阅缓存
cache/          npm 等缓存
tmp/            临时目录
```

迁移到新电脑时，保留整个解压目录即可。删除 `app/data` 会清空任务、脚本、变量和日志。

## 主要功能

### 定时任务

- 支持常规定时、手动运行、开机运行。
- 新建任务时可以选择已有脚本，也可以填写新脚本内容。
- 选择已有脚本时支持树型弹窗、多选脚本、批量创建任务。
- 任务日志用弹窗实时展示，运行后不用等待脚本结束。
- 任务可以启用、禁用、置顶、运行、停止、查看详情和复制 API。

### 脚本管理

- 所有脚本都保存在 `app/data/scripts`。
- 支持新建、编辑、保存、删除、运行脚本。
- 左侧脚本列表按目录树展示，适合管理订阅脚本和自写脚本。

### 订阅管理

订阅可以从 GitHub 仓库、GitHub Raw 或普通 HTTP 脚本拉取文件到本地。

支持的常见格式：

```text
https://github.com/owner/repo.git
owner/repo.git
git@github.com:owner/repo.git
ql repo https://github.com/owner/repo.git "keyword" "" "" ""
ql raw https://raw.githubusercontent.com/owner/repo/main/demo.js
```

如果勾选“拉取后按脚本 cron 自动创建任务”，ScriptPilot 会尝试读取脚本里的 cron 声明，并自动创建对应任务。没有 cron 声明或 cron 无效的脚本会跳过。

### 环境变量

- 用于保存脚本运行需要的变量，例如 `JD_COOKIE`。
- 同名变量会在运行时用 `&` 拼接，兼容常见青龙脚本习惯。
- 列表中变量值会遮罩显示，避免误操作时直接暴露完整内容。

### 依赖管理

- 脚本运行前会预检常见 `require/import` 依赖。
- 缺依赖时自动安装到 `app/data/node_modules`。
- 如果运行时仍报缺模块，会自动尝试安装并重试。

### 日志

- 任务、手动运行和订阅拉取都会生成日志。
- 运行中的日志会实时刷新并自动滚动到底部。
- 系统设置里可以配置日志保留天数，也可以手动立即清理。

## 本机 API

ScriptPilot 默认只监听本机地址：

```text
http://127.0.0.1:18760
```

示例：直接运行一段脚本。

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

## 常见问题

### 启动器图标还是空白

Windows 可能缓存旧图标。可以尝试重新解压、重建快捷方式，或重启资源管理器。

### 程序变慢

脚本运行、依赖安装、订阅拉取都会占用磁盘和网络。电脑很卡时，建议先关闭正在运行的重任务，再操作批量运行或批量订阅。

### 能不能放到移动硬盘

可以。只要保持 `ScriptPilot.exe` 和 `app/` 在同一目录即可。

### 会不会写入 AppData

正常使用不会。Electron 会话、缓存、日志、脚本依赖都重定向到 `app/data` 内。

## 注意

ScriptPilot 是本机工具，没有账号体系和权限隔离。不要把它暴露到公网，也不要运行来源不可信的脚本。
