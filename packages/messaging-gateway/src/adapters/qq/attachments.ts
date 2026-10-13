import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs'
import type { IncomingAttachment } from '../../types'

export const QQ_MAX_FILE_BYTES = 20 * 1024 * 1024
export const QQ_MAX_ATTACHMENTS = 5
type QQAttachment = NonNullable<QQBotInboundMessage['attachments']>[number]

export function qqAttachmentName(a: QQAttachment, index: number): string {
  const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx' }
  const extension = extensions[a.content_type] || '.bin'
  const fallback = `attachment-${index + 1}${extension}`
  const name = basename((a.filename || fallback).replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '_').slice(0, 180) || fallback
  return extname(name) ? name : `${name}${extension}`
}

export function validateQQAttachmentUrl(value: string): URL {
  const url = new URL(value.startsWith('//') ? `https:${value}` : value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !['qq.com', 'qq.com.cn', 'qpic.cn'].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('附件地址不是受支持的 QQ HTTPS 地址')
  }
  return url
}

/** Stream with an enforced byte limit; validate every redirect before following it. */
export async function downloadQQAttachment(a: QQAttachment, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if ((a.size ?? 0) > QQ_MAX_FILE_BYTES) throw new Error('附件超过 20 MB 限制')
  let url = validateQQAttachmentUrl(a.url)
  const timeout = AbortSignal.timeout(30_000)
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetcher(url, { redirect: 'manual', signal: downloadSignal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('附件下载重定向无效')
      url = validateQQAttachmentUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok || !response.body) throw new Error(`附件下载失败（HTTP ${response.status}）`)
    if (Number(response.headers.get('content-length')) > QQ_MAX_FILE_BYTES) {
      await response.body.cancel()
      throw new Error('附件超过 20 MB 限制')
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > QQ_MAX_FILE_BYTES) throw new Error('附件超过 20 MB 限制')
        chunks.push(Buffer.from(value))
      }
    } finally { await reader.cancel().catch(() => {}) }
    return Buffer.concat(chunks, total)
  }
  throw new Error('附件下载重定向次数过多')
}

export async function loadQQAttachments(attachments: QQAttachment[], signal?: AbortSignal): Promise<{ attachments: IncomingAttachment[]; cleanup: () => Promise<void> }> {
  if (attachments.length > QQ_MAX_ATTACHMENTS) throw new Error('每条消息最多接收 5 个附件')
  const dir = await mkdtemp(join(tmpdir(), 'craft-qq-attachments-'))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  try {
    const loaded: IncomingAttachment[] = []
    for (const [index, a] of attachments.entries()) {
      const fileName = qqAttachmentName(a, index)
      const data = await downloadQQAttachment(a, signal)
      const localPath = join(dir, `${index}${extname(fileName)}`)
      await writeFile(localPath, data, { mode: 0o600 })
      loaded.push({ type: a.content_type.startsWith('image/') ? 'photo' : 'document', fileId: String(index), fileName, mimeType: a.content_type, fileSize: data.length, localPath })
    }
    return { attachments: loaded, cleanup }
  } catch (error) { await cleanup(); throw error }
}
