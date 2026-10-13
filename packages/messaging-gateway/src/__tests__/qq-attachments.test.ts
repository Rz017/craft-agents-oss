import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadQQAttachment, QQ_MAX_FILE_BYTES, qqAttachmentName, validateQQAttachmentUrl } from '../adapters/qq/attachments'
import { readQQReplyFiles, stripQQFileLinks } from '../qq-reply-files'

const dirs: string[] = []
function tempDir() { const dir = mkdtempSync(join(tmpdir(), 'qq-files-test-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('QQ attachment download boundaries', () => {
  it('accepts QQ CDN URLs, normalizes missing filenames, and rejects non-QQ/local URLs', () => {
    expect(validateQQAttachmentUrl('//multimedia.nt.qq.com.cn/a').protocol).toBe('https:')
    for (const url of ['http://gchat.qpic.cn/a', 'https://127.0.0.1/a', 'https://qq.com.evil.test/a', 'file:///tmp/a', 'https://user:pass@gchat.qpic.cn/a']) {
      expect(() => validateQQAttachmentUrl(url)).toThrow()
    }
    expect(qqAttachmentName({ content_type: 'application/pdf', url: '' }, 0)).toBe('attachment-1.pdf')
    expect(qqAttachmentName({ content_type: 'text/plain', filename: '../report.txt', url: '' }, 0)).toBe('report.txt')
  })
  it('refuses oversized bodies even without Content-Length and unsafe redirects', async () => {
    const a = { content_type: 'text/plain', url: 'https://gchat.qpic.cn/a' }
    let calls = 0
    const redirect = (async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }) as unknown as typeof fetch
    await expect(downloadQQAttachment(a, undefined, redirect)).rejects.toThrow()
    expect(calls).toBe(1)
    const large = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(QQ_MAX_FILE_BYTES + 1)); controller.close() } }))) as unknown as typeof fetch
    await expect(downloadQQAttachment(a, undefined, large)).rejects.toThrow('20 MB')
  })
})

describe('QQ outbound reply files', () => {
  it('shows local attachment names without paths while retaining web links and ordinary command text', () => {
    const source = '已生成：[连接测试.txt]( /Users/derrick/日常/sessions/test/连接测试.txt)\n![图片](<file:///Users/derrick/report%20image.png>)\n[下载](./report.pdf)\n[官网](https://example.com/docs)\n运行 cd /workspace/project'
    expect(stripQQFileLinks(source)).toBe('已生成：连接测试.txt\n图片\n下载\n[官网](https://example.com/docs)\n运行 cd /workspace/project')
  })
  it('reads explicit output links with spaces, deduplicates, and rejects links outside the session roots', async () => {
    const root = tempDir(), outside = tempDir()
    const report = join(root, 'report with spaces.txt')
    writeFileSync(report, 'report body')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(root, '.private')); writeFileSync(join(root, '.private', 'token.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    const text = `[report]( <${report}> ) [again](<${report}> "report title") [outside](${join(outside, 'secret.txt')}) [symlink](${join(root, 'escape.txt')}) [hidden](${join(root, '.private', 'token.txt')}) [web](https://example.com/a.png)`
    const files = await readQQReplyFiles(text, [root])
    expect(files.map(file => file.filename)).toEqual(['report with spaces.txt'])
    expect(files[0]?.buffer.toString()).toBe('report body')
  })

  it('accepts whitespace after the opening parenthesis in an AI-generated QQ file link', async () => {
    const root = tempDir(), path = join(root, '连接测试.txt')
    writeFileSync(path, 'QQ附件连接正常')
    const files = await readQQReplyFiles(`已生成：[连接测试.txt]( ${path})`, [root])
    expect(files.map(file => file.filename)).toEqual(['连接测试.txt'])
    expect(files[0]?.buffer.toString()).toBe('QQ附件连接正常')
  })
})
