import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { QQ_MAX_ATTACHMENTS, QQ_MAX_FILE_BYTES } from './adapters/qq/attachments'

export interface QQReplyFile { buffer: Buffer; filename: string }

/** Only explicit file links in the reply, within this session's output/cwd roots. */
export async function readQQReplyFiles(text: string, roots: string[]): Promise<QQReplyFile[]> {
  const allowed = (await Promise.all(roots.map(root => realpath(root).catch(() => null)))).filter((root): root is string => !!root)
  const files: QQReplyFile[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
    let value = match[1] || match[2] || ''
    if (/^(?:https?:|data:|sandbox:|codex:)/i.test(value)) continue
    if (value.startsWith('file://')) { try { value = new URL(value).pathname } catch { continue } }
    try { value = decodeURIComponent(value).replace(/:\d+$/, '') } catch { continue }
    const candidates = isAbsolute(value) ? [value] : roots.map(root => resolve(root, value))
    for (const candidate of candidates) {
      // Never turn links to hidden configuration or credentials into QQ uploads.
      const path = await realpath(candidate).catch(() => null)
      if (!path || seen.has(path) || !allowed.some(root => {
        const child = relative(root, path)
        return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child) &&
          !child.split(/[\\/]/).some(part => part.startsWith('.') || part === 'credentials.enc')
      })) continue
      // Refuse symlink replacements and bound the allocation using the opened file.
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
      if (!file) continue
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size < 1 || stat.size > QQ_MAX_FILE_BYTES) continue
        const buffer = Buffer.alloc(stat.size)
        let offset = 0
        while (offset < buffer.length) {
          const read = await file.read(buffer, offset, buffer.length - offset, offset)
          if (!read.bytesRead) break
          offset += read.bytesRead
        }
        if (offset !== buffer.length) continue
        seen.add(path)
        files.push({ buffer, filename: basename(path) })
      } finally { await file.close() }
      break
    }
    if (files.length >= QQ_MAX_ATTACHMENTS) break
  }
  return files
}
