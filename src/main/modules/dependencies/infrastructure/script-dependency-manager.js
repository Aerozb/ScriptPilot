import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../../../shared/errors/app-error.js';
import { createPortableProcessEnv, resolvePortablePath, toPortablePath } from '../../../bootstrap/portable-paths.js';

const CACHE_FILE_NAME = 'dependency-checks.json';
const LOCAL_SCRIPT_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.json'];
const SCANNABLE_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const MAX_LOCAL_DEPENDENCY_FILES = 120;
const COMMONJS_COMPATIBLE_DEPENDENCY_SPECS = {
  'crypto-js': '4.2.0',
  dotenv: '16.4.7',
  'global-agent': '3.0.0',
  got: '11.8.6',
  'tough-cookie': '4.1.4',
  tunnel: '0.0.6'
};
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => name.replace(/^node:/, ''))
]);

export async function ensureScriptDependencies(input) {
  const scriptText = await readScriptDependencyText(input);
  const declaredSpecs = input.scriptContent ? {} : await readNearestPackageDependencySpecs(input.paths, input.scriptPath);
  const requestedSpecs = parseRequestedDependencySpecs(input.requestedDependencies);
  const requestedDependencies = normalizeDependencies(input.requestedDependencies || []);
  const dependencies = normalizeDependencies([
    ...extractPackageDependencies(scriptText),
    ...requestedDependencies
  ]);
  const dependencySpecs = createDependencyInstallSpecs(dependencies, declaredSpecs, requestedSpecs);
  const scriptHash = createScriptHash(scriptText, dependencies, dependencySpecs);
  const cacheKey = input.scriptContent ? `inline:${scriptHash}` : toPortablePath(input.paths, input.scriptPath);
  const cache = await readDependencyCache(input.paths);
  const cached = cache[cacheKey];

  if (!input.forceCheck && cached?.scriptHash === scriptHash && cached?.status === 'ok') {
    return {
      status: '已跳过',
      reason: '脚本和依赖没有变化，未重复预检',
      dependencies,
      dependencySpecs,
      missing: [],
      installed: [],
      checkedAt: cached.checkedAt
    };
  }

  if (!dependencies.length) {
    cache[cacheKey] = createCacheRecord(scriptHash, dependencies, dependencySpecs, [], 'ok');
    await writeDependencyCache(input.paths, cache);
    return {
      status: '无需安装',
      reason: '没有识别到第三方依赖',
      dependencies,
      dependencySpecs,
      missing: [],
      installed: [],
      checkedAt: cache[cacheKey].checkedAt
    };
  }

  await ensurePortablePackageJson(input.paths);
  const missing = [];
  for (const dependency of dependencies) {
    if (!await dependencyRequirementSatisfied(input.paths, dependency, dependencySpecs[dependency])) {
      missing.push(dependency);
    }
  }
  const installSpecs = missing.map((dependency) => toInstallSpec(dependency, dependencySpecs[dependency]));

  if (missing.length && input.autoInstall === false) {
    throw new AppError('DEPENDENCY_MISSING', `脚本缺少依赖: ${missing.join(', ')}`, {
      dependencies,
      dependencySpecs,
      missing,
      installDirectory: toPortablePath(input.paths, path.join(input.paths.dataRoot, 'node_modules'))
    });
  }

  if (missing.length) {
    await installDependencies({
      paths: input.paths,
      runtime: input.runtime,
      dependencies: installSpecs
    });
  }

  cache[cacheKey] = createCacheRecord(scriptHash, dependencies, dependencySpecs, installSpecs, 'ok');
  await writeDependencyCache(input.paths, cache);

  return {
    status: missing.length ? '已自动安装' : '已通过',
    reason: missing.length ? '已把缺失依赖安装到绿色目录 data/node_modules' : '依赖已存在',
    dependencies,
    dependencySpecs,
    missing,
    installed: installSpecs,
    checkedAt: cache[cacheKey].checkedAt
  };
}

export function createNodePathEnv(paths) {
  return path.join(paths.dataRoot, 'node_modules');
}

export function createRuntimeDependencyRequest(moduleName) {
  const dependency = normalizeDependencies([moduleName])[0];
  if (!dependency) return undefined;
  return toInstallSpec(dependency, COMMONJS_COMPATIBLE_DEPENDENCY_SPECS[dependency]);
}

function extractPackageDependencies(scriptText) {
  const dependencies = [];
  for (const specifier of extractDependencySpecifiers(scriptText)) {
    const packageName = toPackageName(specifier);
    if (packageName) dependencies.push(packageName);
  }

  return dependencies;
}

function extractLocalDependencySpecifiers(scriptText) {
  return extractDependencySpecifiers(scriptText)
    .filter((specifier) => specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\'));
}

function extractDependencySpecifiers(scriptText) {
  const text = stripComments(String(scriptText || ''));
  const specifiers = [];
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+(?:[^'"]+\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]+\s+from\s*['"]([^'"]+)['"]/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

function stripComments(scriptText) {
  return scriptText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function toPackageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('\\')) {
    return undefined;
  }

  const normalized = specifier.replace(/^node:/, '');
  if (BUILTIN_MODULES.has(normalized) || BUILTIN_MODULES.has(normalized.split('/')[0])) {
    return undefined;
  }

  const parts = normalized.split('/');
  if (normalized.startsWith('@')) {
    const packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
    return isLikelyRegistryPackageName(packageName) ? packageName : undefined;
  }

  return isLikelyRegistryPackageName(parts[0]) ? parts[0] : undefined;
}

function isLikelyRegistryPackageName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 214 || name.includes('..')) return false;
  if (/^@redacted\//i.test(name)) return false;
  if (name.startsWith('@')) {
    return /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/i.test(name);
  }
  return /^[a-z0-9][a-z0-9._~-]*$/i.test(name);
}

function toDependencyName(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (raw.startsWith('@')) {
    const parts = raw.split('/');
    if (parts.length < 2) return undefined;
    const packagePart = parts[1].split('@')[0];
    return packagePart ? `${parts[0]}/${packagePart}` : undefined;
  }
  return raw.split('@')[0] || undefined;
}

function normalizeDependencies(values) {
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map(toDependencyName)
    .map(toPackageName)
    .filter(Boolean))].sort();
}

function createScriptHash(scriptText, dependencies, dependencySpecs) {
  return createHash('sha256')
    .update(String(scriptText || ''))
    .update('\n---dependencies---\n')
    .update(JSON.stringify(dependencies))
    .update('\n---dependency-specs---\n')
    .update(JSON.stringify(dependencySpecs || {}))
    .digest('hex');
}

function createCacheRecord(scriptHash, dependencies, dependencySpecs, installed, status) {
  return {
    scriptHash,
    dependencies,
    dependencySpecs,
    installed,
    status,
    checkedAt: new Date().toISOString()
  };
}

async function dependencyRequirementSatisfied(paths, dependency, versionRange) {
  if (!await dependencyExists(paths, dependency)) return false;
  if (!versionRange) return true;

  const installedVersion = await readInstalledDependencyVersion(paths, dependency);
  return installedVersion ? versionSatisfies(installedVersion, versionRange) : false;
}

async function dependencyExists(paths, dependency) {
  const dependencyRoot = path.join(paths.dataRoot, 'node_modules', ...dependency.split('/'));
  try {
    await access(dependencyRoot, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readInstalledDependencyVersion(paths, dependency) {
  try {
    const packageJsonPath = path.join(paths.dataRoot, 'node_modules', ...dependency.split('/'), 'package.json');
    const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

async function readNearestPackageDependencySpecs(paths, scriptPath) {
  const resolvedScriptPath = resolvePortablePath(paths, scriptPath, { label: '脚本路径' });
  if (!resolvedScriptPath) return {};

  let current = path.dirname(resolvedScriptPath);
  const dataRoot = path.resolve(paths.dataRoot);
  while (current.startsWith(dataRoot)) {
    const packageJsonPath = path.join(current, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
      return {
        ...(pkg.dependencies || {}),
        ...(pkg.optionalDependencies || {})
      };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return {};
}

async function readScriptDependencyText(input) {
  if (input.scriptContent !== undefined) return String(input.scriptContent || '');

  const entryPath = resolvePortablePath(input.paths, input.scriptPath, { label: '脚本路径' });
  if (!entryPath) return '';

  const visited = new Set();
  const queue = [entryPath];
  const chunks = [];

  while (queue.length && visited.size < MAX_LOCAL_DEPENDENCY_FILES) {
    const filePath = queue.shift();
    const resolvedFilePath = await resolveLocalScriptFile(filePath);
    if (!resolvedFilePath) continue;

    const normalized = path.resolve(resolvedFilePath);
    if (visited.has(normalized)) continue;
    if (!isInsidePath(input.paths.dataRoot, normalized)) continue;
    if (isInsidePath(path.join(input.paths.dataRoot, 'node_modules'), normalized)) continue;

    visited.add(normalized);
    if (!SCANNABLE_SCRIPT_EXTENSIONS.has(path.extname(normalized).toLowerCase())) continue;

    const text = await readOptionalText(input.paths, normalized);
    chunks.push(`\n/* file:${toPortablePath(input.paths, normalized)} */\n${text}`);

    for (const specifier of extractLocalDependencySpecifiers(text)) {
      const localPath = resolveLocalSpecifierPath(input.paths, normalized, specifier);
      if (localPath && !visited.has(path.resolve(localPath))) queue.push(localPath);
    }
  }

  return chunks.join('\n');
}

async function resolveLocalScriptFile(filePath) {
  for (const candidate of expandLocalScriptCandidates(filePath)) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next Node-compatible local module candidate.
    }
  }

  return undefined;
}

function expandLocalScriptCandidates(filePath) {
  const candidates = [];
  const parsed = path.parse(filePath);
  const hasExtension = Boolean(parsed.ext);

  if (hasExtension) {
    candidates.push(filePath);
  } else {
    for (const extension of LOCAL_SCRIPT_EXTENSIONS) {
      candidates.push(`${filePath}${extension}`);
    }
  }

  candidates.push(path.join(filePath, 'index.js'));
  candidates.push(path.join(filePath, 'index.mjs'));
  candidates.push(path.join(filePath, 'index.cjs'));

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolveLocalSpecifierPath(paths, importerPath, specifier) {
  try {
    const base = specifier.startsWith('.')
      ? path.resolve(path.dirname(importerPath), specifier)
      : resolvePortablePath(paths, specifier, { label: '本地依赖路径' });
    return base && isInsidePath(paths.dataRoot, base) ? base : undefined;
  } catch {
    return undefined;
  }
}

function isInsidePath(root, targetPath) {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseRequestedDependencySpecs(values) {
  const specs = {};
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value || '').trim();
    const name = toDependencyName(raw);
    if (!name) continue;
    const range = parseVersionRange(raw, name);
    if (range) specs[name] = range;
  }
  return specs;
}

function createDependencyInstallSpecs(dependencies, declaredSpecs, requestedSpecs) {
  const specs = {};
  for (const dependency of dependencies) {
    const range = requestedSpecs[dependency] ||
      declaredSpecs[dependency] ||
      COMMONJS_COMPATIBLE_DEPENDENCY_SPECS[dependency];
    if (range && isRegistryVersionRange(range)) specs[dependency] = range;
  }
  return specs;
}

function toInstallSpec(dependency, range) {
  return range ? `${dependency}@${range}` : dependency;
}

function parseVersionRange(raw, packageName) {
  if (raw === packageName) return undefined;
  if (packageName.startsWith('@')) {
    return raw.startsWith(`${packageName}@`) ? raw.slice(packageName.length + 1).trim() : undefined;
  }
  const index = raw.indexOf('@', 1);
  return index > 0 ? raw.slice(index + 1).trim() : undefined;
}

function isRegistryVersionRange(value) {
  const range = String(value || '').trim();
  return Boolean(range) && !/^(file:|link:|workspace:|git\+|https?:)/i.test(range);
}

function versionSatisfies(version, range) {
  const normalizedRange = String(range || '').trim();
  if (!normalizedRange || normalizedRange === '*' || normalizedRange.toLowerCase() === 'latest') return true;
  if (normalizedRange.includes('||')) {
    return normalizedRange.split('||').some((part) => versionSatisfies(version, part.trim()));
  }
  return normalizedRange
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => versionSatisfiesComparator(version, part));
}

function versionSatisfiesComparator(version, comparator) {
  const normalized = comparator.trim();
  if (!normalized || normalized === '*') return true;

  if (normalized.startsWith('^')) return versionSatisfiesCaret(version, normalized.slice(1));
  if (normalized.startsWith('~')) return versionSatisfiesTilde(version, normalized.slice(1));
  if (normalized.startsWith('>=')) return compareVersions(version, normalized.slice(2)) >= 0;
  if (normalized.startsWith('>')) return compareVersions(version, normalized.slice(1)) > 0;
  if (normalized.startsWith('<=')) return compareVersions(version, normalized.slice(2)) <= 0;
  if (normalized.startsWith('<')) return compareVersions(version, normalized.slice(1)) < 0;
  if (/^[0-9]+(?:\.[0-9x*]+){0,2}$/i.test(normalized)) {
    return versionMatchesLoose(version, normalized);
  }
  return false;
}

function versionSatisfiesCaret(version, range) {
  const min = parseVersion(range);
  if (!min) return false;
  const max = min.major > 0
    ? { major: min.major + 1, minor: 0, patch: 0 }
    : min.minor > 0
      ? { major: 0, minor: min.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: min.patch + 1 };
  return compareVersions(version, formatVersion(min)) >= 0 && compareParsedVersions(parseVersion(version), max) < 0;
}

function versionSatisfiesTilde(version, range) {
  const min = parseVersion(range);
  if (!min) return false;
  const max = { major: min.major, minor: min.minor + 1, patch: 0 };
  return compareVersions(version, formatVersion(min)) >= 0 && compareParsedVersions(parseVersion(version), max) < 0;
}

function versionMatchesLoose(version, range) {
  const versionParts = version.split('.').map((part) => Number.parseInt(part, 10));
  const rangeParts = range.split('.');
  for (let index = 0; index < rangeParts.length; index += 1) {
    const part = rangeParts[index].toLowerCase();
    if (part === '*' || part === 'x') continue;
    if (versionParts[index] !== Number.parseInt(part, 10)) return false;
  }
  return true;
}

function compareVersions(left, right) {
  return compareParsedVersions(parseVersion(left), parseVersion(right));
}

function compareParsedVersions(left, right) {
  if (!left || !right) return -1;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  return 0;
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return undefined;
  return {
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0)
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

async function installDependencies(input) {
  const npmCliPath = resolveNpmCliPath(input.runtime.nodePath);
  try {
    await access(npmCliPath, constants.R_OK);
  } catch {
    throw new AppError('NPM_NOT_FOUND', '内置 npm 不存在，无法自动安装依赖', {
      npmCliPath
    });
  }

  await mkdir(path.join(input.paths.cacheRoot, 'npm'), { recursive: true });

  const result = await runNpmInstall({
    nodePath: input.runtime.nodePath,
    npmCliPath,
    paths: input.paths,
    dependencies: input.dependencies
  });

  if (result.exitCode !== 0) {
    throw new AppError('DEPENDENCY_INSTALL_FAILED', '自动安装依赖失败', {
      dependencies: input.dependencies,
      exitCode: result.exitCode,
      stdout: result.stdoutText,
      stderr: result.stderrText
    });
  }
}

function resolveNpmCliPath(nodePath) {
  return path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function runNpmInstall(input) {
  return new Promise((resolve, reject) => {
    const args = [
      'install',
      '--prefix',
      input.paths.dataRoot,
      '--cache',
      path.join(input.paths.cacheRoot, 'npm'),
      '--no-audit',
      '--no-fund',
      '--save-prod',
      ...input.dependencies
    ];

    const child = spawn(input.nodePath, [input.npmCliPath, ...args], {
      cwd: input.paths.dataRoot,
      env: createPortableProcessEnv(input.paths),
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

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdoutText, stderrText });
    });
  });
}

async function ensurePortablePackageJson(paths) {
  const packageJsonPath = path.join(paths.dataRoot, 'package.json');
  try {
    await access(packageJsonPath, constants.R_OK);
  } catch {
    await writeFile(packageJsonPath, `${JSON.stringify({
      name: 'scriptpilot-user-dependencies',
      private: true,
      description: 'ScriptPilot 自动安装的脚本依赖，只保存在绿色目录 data 内。'
    }, null, 2)}\n`, 'utf8');
  }
}

async function readDependencyCache(paths) {
  try {
    return JSON.parse(await readFile(path.join(paths.appStateRoot, CACHE_FILE_NAME), 'utf8'));
  } catch {
    return {};
  }
}

async function writeDependencyCache(paths, cache) {
  await writeFile(path.join(paths.appStateRoot, CACHE_FILE_NAME), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function readOptionalText(paths, filePath) {
  try {
    return await readFile(resolvePortablePath(paths, filePath, { label: '脚本路径' }) || filePath, 'utf8');
  } catch {
    return '';
  }
}
