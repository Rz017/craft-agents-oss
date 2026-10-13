import { describe, expect, it } from 'bun:test'
import { checkQQRelease, compareQQVersions, selectQQRelease } from '../qq-updates'

function release(version: string, extra = {}) {
  return { tag_name: `qq-v${version}`, assets: [{ name: `Craft-Agents-QQ-${version}-arm64.zip` }], ...extra }
}
describe('QQ notice-only GitHub releases', () => {
  it('compares independent QQ versions numerically', () => {
    expect(compareQQVersions('0.15.0-qq.10', '0.15.0-qq.2')).toBeGreaterThan(0)
    expect(compareQQVersions('0.16.0-qq.1', '0.15.0-qq.10')).toBeGreaterThan(0)
    expect(compareQQVersions('0.15.0-qq.1', '0.15.0-qq.1')).toBe(0)
  })
  it('ignores official, draft, preview and incomplete releases, choosing newest QQ build', () => {
    const result = selectQQRelease([
      { tag_name: 'v99.0.0', assets: [] }, release('0.15.0-qq.3', { draft: true }),
      release('0.15.0-qq.4', { prerelease: true }), release('0.15.0-qq.5', { assets: [] }),
      release('0.15.0-qq.2'), release('0.15.0-qq.10'),
    ], '0.15.0-qq.1')
    expect(result?.version).toBe('0.15.0-qq.10')
    expect(result?.url).toBe('https://github.com/Rz017/craft-agents-oss/releases/tag/qq-v0.15.0-qq.10')
    expect(selectQQRelease([release('0.15.0-qq.1')], '0.15.0-qq.1')).toBeNull()
  })
  it('surfaces network failure rather than reporting up to date', async () => {
    await expect(checkQQRelease('0.15.0-qq.1', (async () => new Response('', { status: 403 })) as unknown as typeof fetch)).rejects.toThrow('HTTP 403')
  })
})
