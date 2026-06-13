import { createAcceleratedUrl } from '../../../shared/network/url-accelerator.js';

const DEFAULT_UPDATE_ACCELERATOR_URL = 'https://ghfast.top/';
const RELEASE_API_URL = 'https://api.github.com/repos/Aerozb/ScriptPilot/releases/latest';

export async function checkGitHubReleaseUpdate(input = {}) {
  const currentVersion = normalizeVersion(input.currentVersion);
  const fetchImpl = input.fetchImpl || fetch;
  const release = await fetchLatestRelease(fetchImpl);
  const latestVersion = normalizeVersion(release.tag_name || release.name);
  const asset = findPortableZipAsset(release.assets || []);
  const downloadUrl = asset?.browser_download_url || '';
  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
    tagName: release.tag_name || '',
    name: release.name || release.tag_name || '',
    body: release.body || '',
    publishedAt: release.published_at || '',
    releaseUrl: release.html_url || '',
    assetName: asset?.name || '',
    downloadUrl,
    acceleratedDownloadUrl: createUpdateDownloadUrl(downloadUrl)
  };
}

export function createUpdateDownloadUrl(downloadUrl) {
  return createAcceleratedUrl(downloadUrl, DEFAULT_UPDATE_ACCELERATOR_URL);
}

export function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split('.').map(toVersionNumber);
  const rightParts = normalizeVersion(right).split('.').map(toVersionNumber);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function normalizeVersion(value) {
  return String(value || '0.0.0').trim().replace(/^v/i, '').split(/[+-]/)[0] || '0.0.0';
}

function toVersionNumber(value) {
  const number = Number.parseInt(String(value || '0').replace(/\D.*$/, ''), 10);
  return Number.isFinite(number) ? number : 0;
}

async function fetchLatestRelease(fetchImpl) {
  const response = await fetchImpl(RELEASE_API_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ScriptPilot'
    }
  });
  if (!response.ok) {
    throw new Error(`检查更新失败：GitHub 返回 HTTP ${response.status}`);
  }
  return response.json();
}

function findPortableZipAsset(assets) {
  return assets.find((asset) => /ScriptPilot-v.+-portable\.zip$/i.test(asset.name || '')) ||
    assets.find((asset) => /portable\.zip$/i.test(asset.name || '')) ||
    assets.find((asset) => /\.zip$/i.test(asset.name || ''));
}
