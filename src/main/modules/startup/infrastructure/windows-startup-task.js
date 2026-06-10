import { spawn } from 'node:child_process';
import { AppError } from '../../../shared/errors/app-error.js';

const TASK_NAME = 'ScriptPilot';

export async function getStartupTaskStatus(exePath) {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      enabled: false,
      message: '当前系统不是 Windows，暂不支持开机启动任务。'
    };
  }

  const result = await runPowerShell(`
$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
if ($null -eq $task) {
  [PSCustomObject]@{
    supported = $true
    enabled = $false
    exists = $false
    message = '未启用开机启动'
  } | ConvertTo-Json -Compress
  exit 0
}
$action = $task.Actions | Select-Object -First 1
[PSCustomObject]@{
  supported = $true
  enabled = $true
  exists = $true
  state = $task.State.ToString()
  runLevel = $task.Principal.RunLevel.ToString()
  userId = $task.Principal.UserId
  execute = $action.Execute
  arguments = $action.Arguments
  expectedExecute = '${escapePowerShellSingleQuoted(exePath)}'
  message = '已启用开机启动'
} | ConvertTo-Json -Compress
`);

  return parsePowerShellJson(result.stdoutText);
}

export async function enableStartupTask(exePath) {
  if (process.platform !== 'win32') {
    throw new AppError('STARTUP_UNSUPPORTED', '当前系统不是 Windows，暂不支持开机启动任务');
  }

  const escapedExe = escapePowerShellSingleQuoted(exePath);
  const result = await runPowerShell(`
$action = New-ScheduledTaskAction -Execute '${escapedExe}' -Argument '--background'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'ScriptPilot 绿色版脚本调度器开机启动' -Force | Out-Null
[PSCustomObject]@{
  supported = $true
  enabled = $true
  exists = $true
  taskName = '${TASK_NAME}'
  runLevel = 'Highest'
  execute = '${escapedExe}'
  message = '已启用开机启动，并设置为最高权限运行'
} | ConvertTo-Json -Compress
`);

  return parsePowerShellJson(result.stdoutText);
}

export async function disableStartupTask() {
  if (process.platform !== 'win32') {
    throw new AppError('STARTUP_UNSUPPORTED', '当前系统不是 Windows，暂不支持开机启动任务');
  }

  const result = await runPowerShell(`
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
[PSCustomObject]@{
  supported = $true
  enabled = $false
  exists = $false
  taskName = '${TASK_NAME}'
  message = '已停用开机启动'
} | ConvertTo-Json -Compress
`);

  return parsePowerShellJson(result.stdoutText);
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`
    ], {
      windowsHide: true
    });
    let stdoutText = '';
    let stderrText = '';

    child.stdout.on('data', (chunk) => {
      stdoutText += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(new AppError('STARTUP_POWERSHELL_FAILED', '无法调用 PowerShell 管理开机启动', {
        message: error.message
      }));
    });

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve({ stdoutText, stderrText });
        return;
      }

      reject(new AppError('STARTUP_TASK_FAILED', '开机启动任务操作失败，请尝试以管理员身份运行 ScriptPilot', {
        exitCode,
        stdout: stdoutText,
        stderr: stderrText
      }));
    });
  });
}

function parsePowerShellJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new AppError('STARTUP_STATUS_PARSE_FAILED', '开机启动状态解析失败', {
      raw: text
    });
  }
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}
