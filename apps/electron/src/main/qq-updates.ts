/** Notice-only releases: never download or install an App in the background. */
export const QQ_RELEASES_URL = 'https://github.com/Rz017/craft-agents-oss/releases'
export const QQ_RELEASES_API = 'https://api.github.com/repos/Rz017/craft-agents-oss/releases?per_page=30'
export interface QQRelease { version: string; url: string }

function versionParts(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)-qq\.(\d+)$/.exec(value)
  return match ? match.slice(1).map(Number) : null
}
export function compareQQVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b)
  if (!left || !right) throw new Error('Invalid QQ release version')
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return 0
}

export function selectQQRelease(data: unknown, currentVersion: string): QQRelease | null {
  if (!Array.isArray(data) || !versionParts(currentVersion)) throw new Error('Invalid GitHub release response')
  let latest: QQRelease | null = null
  for (const item of data) {
    if (!item || item.draft || item.prerelease || typeof item.tag_name !== 'string' || !item.tag_name.startsWith('qq-v')) continue
    const version = item.tag_name.slice(4)
    if (!versionParts(version) || compareQQVersions(version, currentVersion) <= 0) continue
    // Ignore incomplete releases and all upstream artifacts/tags in this fork.
    if (!Array.isArray(item.assets) || !item.assets.some((asset: { name?: string }) => asset.name === `Craft-Agents-QQ-${version}-arm64.zip`)) continue
    if (!latest || compareQQVersions(version, latest.version) > 0) {
      latest = { version, url: `${QQ_RELEASES_URL}/tag/${encodeURIComponent(item.tag_name)}` }
    }
  }
  return latest
}

export async function checkQQRelease(currentVersion: string, fetcher: typeof fetch = fetch): Promise<QQRelease | null> {
  const response = await fetcher(QQ_RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}）`)
  return selectQQRelease(await response.json(), currentVersion)
}
