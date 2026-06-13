export function normalizeAcceleratorBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function createAcceleratedUrl(targetUrl, acceleratorBaseUrl, options = {}) {
  const url = String(targetUrl || '').trim();
  const baseUrl = normalizeAcceleratorBaseUrl(acceleratorBaseUrl);
  if (!url || !baseUrl || url.startsWith(baseUrl)) return url;
  if (options.githubOnly !== false && !isGitHubDownloadUrl(url)) return url;
  return `${baseUrl}${url}`;
}

export function isValidAcceleratorBaseUrl(value) {
  return Boolean(normalizeAcceleratorBaseUrl(value));
}

function isGitHubDownloadUrl(url) {
  return /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\//i.test(url);
}
