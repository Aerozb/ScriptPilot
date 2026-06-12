import { createRuntimeDependencyRequest } from '../../dependencies/infrastructure/script-dependency-manager.js';

const MAX_RETRY_ERROR_PREVIEW = 4000;
const MAX_RUNTIME_DEPENDENCY_RETRIES = 5;

export async function runNodeScriptWithDependencyRetry(input) {
  let result = await input.runNodeScript(input.runInput);
  let dependencyCheck = input.dependencyCheck;
  const runtimeAttempts = [];
  const discoveredDependencies = [];

  for (let attempt = 0; attempt < MAX_RUNTIME_DEPENDENCY_RETRIES; attempt += 1) {
    const missingModule = input.autoInstall === false ? undefined : detectMissingModule(result);
    if (!missingModule || discoveredDependencies.includes(missingModule)) break;

    const dependencyRequest = createRuntimeDependencyRequest(missingModule);
    if (!dependencyRequest) break;

    discoveredDependencies.push(missingModule);
    runtimeAttempts.push({
      missingDependency: missingModule,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stderrPreview: String(result.stderrText || '').slice(0, MAX_RETRY_ERROR_PREVIEW)
    });

    dependencyCheck = await input.ensureScriptDependencies({
      paths: input.paths,
      runtime: input.runtime,
      scriptPath: input.scriptPath,
      scriptContent: input.scriptContent,
      requestedDependencies: [...(input.requestedDependencies || []), ...discoveredDependencies.map(createRuntimeDependencyRequest)],
      autoInstall: true,
      forceCheck: true
    });

    result = await input.runNodeScript(input.runInput);
  }

  if (!runtimeAttempts.length) {
    return {
      result,
      dependencyCheck
    };
  }

  return {
    result,
    dependencyCheck: {
      ...dependencyCheck,
      status: dependencyCheck.installed?.length ? '已自动安装并重试' : '已补齐并重试',
      reason: `运行时发现缺失依赖 ${discoveredDependencies.join(', ')}，已自动补装到 data/node_modules 后重试`,
      runtimeMissingDependency: discoveredDependencies.at(-1),
      runtimeMissingDependencies: discoveredDependencies,
      runtimeAttempts
    }
  };
}

function detectMissingModule(result) {
  if (!result || result.timedOut || result.exitCode === 0) return undefined;
  const text = `${result.stderrText || ''}\n${result.stdoutText || ''}`;
  const match = text.match(/Cannot find module ['"]([^'"]+)['"]/);
  return match?.[1];
}
