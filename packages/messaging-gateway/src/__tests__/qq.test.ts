import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QQBot, QQBotInboundMessage, QQBotOptions, ReplyTarget } from '@tencent-connect/qqbot-nodejs'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import { QQAdapter, parseQQCredentials, testQQCredentials } from '../adapters/qq/index'
import { MessagingGateway } from '../gateway'
import { MessagingGatewayRegistry } from '../registry'
import { Renderer } from '../renderer'
import type { IncomingMessage, MessagingConfig, PlatformOwner } from '../types'

const creds = { appId: '123456', appSecret: 'test-secret' }
const dirs: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir() { const dir = mkdtempSync(join(tmpdir(), 'craft-qq-')); dirs.push(dir); return dir }

class FakeBot {
  handlers = new Map<string, (...args: any[]) => any>()
  sent: Array<{ target: ReplyTarget; text: string }> = []
  media: Array<{ target: ReplyTarget; kind: string; buffer: Buffer; filename?: string }> = []
  stopped = false
  failSend = false
  failStart = false
  autoReady = true
  private end?: () => void
  on(event: string, callback: (...args: any[]) => any) { this.handlers.set(event, callback) }
  async start() {
    if (this.failStart) throw new Error('secret must not appear in UI')
    if (this.autoReady) this.handlers.get('ready')?.({})
    await new Promise<void>((resolve) => { this.end = resolve })
  }
  stop() { this.stopped = true; this.end?.() }
  async sendText(target: ReplyTarget, text: string) {
    if (this.failSend) throw new Error('send failed')
    this.sent.push({ target: { ...target }, text })
    return { id: `sent-${this.sent.length}`, timestamp: Date.now() }
  }
  async receive(msg: QQBotInboundMessage) { await this.handlers.get('message')?.({}, msg) }
  async sendImage(target: ReplyTarget, source: { buffer: Buffer }) {
    this.media.push({ target: { ...target }, kind: 'image', buffer: source.buffer })
    return { message: { id: `image-${this.media.length}` }, upload: {} }
  }
  async sendFile(target: ReplyTarget, source: { buffer: Buffer }, options: { fileName: string }) {
    this.media.push({ target: { ...target }, kind: 'file', buffer: source.buffer, filename: options.fileName })
    return { message: { id: `file-${this.media.length}` }, upload: {} }
  }
}

function inbound(targetId: string, content: string, id = content, kind: 'group' | 'c2c' = 'group'): QQBotInboundMessage {
  return {
    kind, rawEventType: kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
    senderId: 'owner', senderName: 'Owner', messageId: id, content,
    timestamp: new Date().toISOString(), replyTarget: { scope: kind, targetId, msgId: id }, raw: {} as QQBotInboundMessage['raw'],
  }
}
async function makeAdapter(fake = new FakeBot()) {
  let options: QQBotOptions | undefined
  const adapter = new QQAdapter((opts) => { options = opts; return fake as unknown as QQBot })
  await adapter.initialize({ token: JSON.stringify(creds) })
  cleanups.push(() => adapter.destroy())
  return { fake, adapter, options }
}

describe('QQ official adapter', () => {
  it('validates credentials and subscribes only to group/C2C messages', async () => {
    expect(parseQQCredentials(JSON.stringify({ appId: ' 123 ', appSecret: ' secret ' }))).toEqual({ appId: '123', appSecret: 'secret' })
    expect(() => parseQQCredentials(JSON.stringify({ appId: 'bad', appSecret: 'secret' }))).toThrow()
    expect(() => parseQQCredentials(JSON.stringify({ appId: '123', appSecret: '' }))).toThrow()
    const { adapter, options } = await makeAdapter()
    expect(options?.intents).toBe(1 << 25)
    expect(options?.markdownSupport).toBe(false)
    expect(adapter.isConnected()).toBe(true)
  })

  it('normalizes private/group IDs, strips mentions and deduplicates resumed messages', async () => {
    const { fake, adapter } = await makeAdapter()
    const received: IncomingMessage[] = []
    adapter.onMessage(async (msg) => { received.push(msg) })
    const group = inbound('same-id', ' <@!123456> /pair 123456 ', 'm1')
    await fake.receive(group)
    await fake.receive(group)
    await fake.receive(inbound('same-id', 'hello', 'm2', 'c2c'))
    await fake.receive({ ...inbound('group', 'ambient', 'm3'), rawEventType: 'GROUP_MESSAGE_CREATE' })
    await fake.receive({ ...inbound('group', 'bot text', 'm4'), senderIsBot: true })
    await fake.receive(inbound('group', '', 'm5'))
    expect(received.map((msg) => [msg.channelId, msg.text])).toEqual([
      ['group:same-id', '/pair 123456'], ['c2c:same-id', 'hello'],
      ['group:group', 'ambient'],
    ])
    await adapter.sendText('group:same-id', 'reply')
    expect(fake.sent[0]?.target).toEqual({ scope: 'group', targetId: 'same-id', msgId: 'm1' })
  })

  it('delivers another inbound message while the first session turn is still running', async () => {
    const { fake, adapter } = await makeAdapter()
    let release!: () => void
    const running = new Promise<void>(resolve => { release = resolve })
    const received: string[] = []
    adapter.onMessage(async msg => {
      received.push(msg.text)
      if (msg.text === 'first') await running
    })
    const first = fake.receive(inbound('g1', 'first'))
    try {
      await fake.receive({ ...inbound('g1', 'second'), rawEventType: 'GROUP_MESSAGE_CREATE' })
      expect(received).toEqual(['first', 'second'])
    } finally { release(); await first }
  })

  it('chunks long Unicode replies without losing text, and recovers from send failures', async () => {
    const { fake, adapter } = await makeAdapter()
    const text = '😀'.repeat(2500)
    await adapter.sendText('group:g1', text)
    expect(fake.sent.map((msg) => msg.text).join('')).toBe(text)
    expect(fake.sent).toHaveLength(2)
    fake.failSend = true
    await expect(adapter.sendText('group:g1', 'fails')).rejects.toThrow('send failed')
    fake.failSend = false
    await adapter.sendText('group:g1', 'recovered')
    expect(fake.sent.at(-1)?.text).toBe('recovered')
    await expect(adapter.sendText('invalid', 'bad')).rejects.toThrow('Invalid QQ chat ID')
    await expect(adapter.sendFile('group:g1', Buffer.alloc(0), 'empty.txt')).rejects.toThrow('20 MB')
  })

  it('uploads images and documents to the right chat using its passive reply target', async () => {
    const { fake, adapter } = await makeAdapter()
    await fake.receive(inbound('g1', 'file please', 'source'))
    await adapter.sendFile('group:g1', Buffer.from('image'), 'preview.png')
    await adapter.sendFile('c2c:u1', Buffer.from('document'), 'report.pdf')
    expect(fake.media.map(m => [m.kind, m.target, m.filename])).toEqual([
      ['image', { scope: 'group', targetId: 'g1', msgId: 'source' }, undefined],
      ['file', { scope: 'c2c', targetId: 'u1' }, 'report.pdf'],
    ])
  })

  it('accepts attachment-only QQ events, downloads only after authorization, and cleans temporary files', async () => {
    const { fake, adapter } = await makeAdapter()
    const originalFetch = globalThis.fetch
    let downloads = 0, downloadedPath = '', temporaryPath = ''
    const storedPath = join(tempDir(), 'persisted-note.txt')
    const manager = {
      getSession: async () => ({ id: 'a', workspaceId: 'ws' }), getSessions: () => [],
      sendMessage: async (_id: string, text: string, files: any[], stored: any[]) => {
        expect(text).toContain('附件')
        expect(files[0].name).toBe('note.txt')
        expect(files[0].text).toBe('QQ attachment body')
        downloadedPath = files[0].path
        expect(existsSync(downloadedPath)).toBe(true)
        expect(stored[0].storedPath).toBe(storedPath)
      },
    } as unknown as ISessionManager
    const gateway = new MessagingGateway({
      workspaceId: 'ws', sessionManager: manager, storageDir: tempDir(),
      storeAttachment: async (workspaceId, sessionId, attachment) => {
        expect([workspaceId, sessionId]).toEqual(['ws', 'a'])
        temporaryPath = attachment.path
        writeFileSync(storedPath, readFileSync(attachment.path))
        return { id: 'persisted', type: attachment.type, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, storedPath }
      },
      getWorkspaceConfig: () => ({ enabled: true, platforms: { qq: { enabled: true, accessMode: 'owner-only', owners: [{ userId: 'owner', source: 'manual', addedAt: Date.now() }] } } }),
    })
    gateway.getBindingStore().bind('ws', 'a', 'qq', 'group:g1')
    gateway.registerAdapter(adapter); await gateway.start(); cleanups.push(() => gateway.stop())
    globalThis.fetch = (async () => { downloads++; return new Response('QQ attachment body') }) as unknown as typeof fetch
    try {
      const message = { ...inbound('g1', '', 'attachment'), rawEventType: 'GROUP_MESSAGE_CREATE', attachments: [{ content_type: 'text/plain', filename: 'note.txt', url: 'https://multimedia.nt.qq.com.cn/file' }] }
      await fake.receive({ ...message, senderId: 'stranger', messageId: 'blocked' })
      expect(downloads).toBe(0)
      await fake.receive(message)
      await fake.receive(message)
      expect(downloads).toBe(1)
      expect(downloadedPath).not.toBe('')
      expect(existsSync(downloadedPath)).toBe(true)
      expect(existsSync(temporaryPath)).toBe(false)
    } finally { globalThis.fetch = originalFetch }
  })

  it('reports errors/recovery and stops its socket on destruction', async () => {
    const fake = new FakeBot()
    const statuses: string[] = []
    const adapter = new QQAdapter(() => fake as unknown as QQBot)
    await adapter.initialize({ token: JSON.stringify(creds), onStatus: (state: string) => statuses.push(state) })
    fake.handlers.get('error')?.(new Error('secret'))
    expect(adapter.isConnected()).toBe(false)
    fake.handlers.get('resumed')?.({})
    expect(adapter.isConnected()).toBe(true)
    expect(statuses).toEqual(['connected', 'connecting', 'connected'])
    await adapter.destroy()
    expect(fake.stopped).toBe(true)
    expect(adapter.isConnected()).toBe(false)
    await expect(adapter.sendText('group:g', 'text')).rejects.toThrow('not connected')
  })

  it('cleans up a failed startup without surfacing SDK secrets', async () => {
    const fake = new FakeBot(); fake.failStart = true
    const adapter = new QQAdapter(() => fake as unknown as QQBot)
    await expect(adapter.initialize({ token: JSON.stringify(creds) })).rejects.toThrow('Could not connect to QQ')
    expect(fake.stopped).toBe(true)
  })

  it('cancels a pending connection when the workspace is closed', async () => {
    const fake = new FakeBot(); fake.autoReady = false
    const adapter = new QQAdapter(() => fake as unknown as QQBot)
    const starting = adapter.initialize({ token: JSON.stringify(creds) })
    // initialize awaits destruction before creating the new transport.
    await Promise.resolve(); await Promise.resolve()
    await adapter.destroy()
    await expect(starting).rejects.toThrow('cancelled')
    expect(fake.stopped).toBe(true)
  })

  it('checks the official auth endpoint without exposing its response', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: string }> = []
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), body: String(options?.body) })
      return new Response(JSON.stringify({ access_token: 'never-display-this' }))
    }) as typeof fetch
    try {
      expect(await testQQCredentials(creds)).toEqual({ success: true })
      expect(calls[0]).toEqual({ url: 'https://bots.qq.com/app/getAppAccessToken', body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }) })
      globalThis.fetch = (async () => new Response(JSON.stringify({ message: 'secret' }), { status: 401 })) as unknown as typeof fetch
      expect((await testQQCredentials(creds)).error).not.toContain('secret')
    } finally { globalThis.fetch = originalFetch }
  })
})

describe('QQ pairing, switching and text routing', () => {
  it('isolates groups, binds by code, switches sessions and gates workspace commands', async () => {
    const { fake, adapter } = await makeAdapter()
    const sessions = [
      { id: 'a', name: 'Session A', workspaceId: 'ws', createdAt: 1, lastMessageAt: 1 },
      { id: 'b', name: 'Session B', workspaceId: 'ws', createdAt: 2, lastMessageAt: 2 },
    ]
    const routed: Array<[string, string]> = []
    const manager = {
      getSessions: () => sessions,
      getSession: async (id: string) => sessions.find((s) => s.id === id),
      sendMessage: async (id: string, text: string) => { routed.push([id, text]) },
    } as unknown as ISessionManager
    const config: MessagingConfig = { enabled: true, platforms: { qq: { enabled: true, accessMode: 'owner-only', owners: [] } } }
    const codes = new Map([['123456', 'a'], ['654321', 'b']])
    const gateway = new MessagingGateway({
      workspaceId: 'ws', sessionManager: manager, storageDir: tempDir(),
      pairingConsumer: {
        canConsume: () => true,
        consume: (_platform, code) => {
          const id = codes.get(code); codes.delete(code)
          return id ? { kind: 'session', workspaceId: 'ws', sessionId: id } : null
        },
      },
      getWorkspaceConfig: () => config,
      seedOwnerOnFirstPair: async (_platform, owner: PlatformOwner) => {
        config.platforms.qq!.owners = [owner]; return [owner]
      },
    })
    gateway.registerAdapter(adapter); await gateway.start()
    cleanups.push(() => gateway.stop())
    await fake.receive({ ...inbound('g1', '/bind', 'blocked'), senderId: 'stranger' })
    expect(fake.sent.at(-1)?.text).not.toContain('Session A')
    await fake.receive(inbound('g1', '/pair 000000', 'bad-code'))
    expect(gateway.getBindingStore().getAll()).toHaveLength(0)
    await fake.receive(inbound('g1', '/pair 123456', 'pair-a'))
    await fake.receive(inbound('g2', '/pair 654321', 'pair-b'))
    await fake.receive(inbound('g1', 'hello A', 'a1'))
    await fake.receive(inbound('g2', 'hello B', 'b1'))
    expect(routed).toEqual([['a', 'hello A'], ['b', 'hello B']])
    await fake.receive(inbound('g1', '/bind', 'list'))
    expect(fake.sent.at(-1)?.text).toContain('Recent sessions')
    await fake.receive(inbound('g1', '/bind b', 'switch'))
    await fake.receive(inbound('g1', 'now B', 'b2'))
    expect(routed.at(-1)).toEqual(['b', 'now B'])
    expect(gateway.getBindingStore().findByChannel('qq', 'group:g2')?.sessionId).toBe('b')
    await fake.receive(inbound('g1', '/unbind', 'unbind'))
    expect(gateway.getBindingStore().findByChannel('qq', 'group:g1')).toBeUndefined()
    expect(gateway.getBindingStore().findByChannel('qq', 'group:g2')).toBeDefined()
  })

  it('sends complete text only at completion and points approvals back to Craft', async () => {
    const { fake, adapter } = await makeAdapter()
    const store = new (await import('../binding-store')).BindingStore(tempDir())
    const binding = store.bind('ws', 'a', 'qq', 'group:g')
    const renderer = new Renderer()
    await renderer.handle({ type: 'text_delta', sessionId: 'a', delta: 'draft' }, binding, adapter)
    await renderer.handle({ type: 'text_complete', sessionId: 'a', text: 'long '.repeat(800) }, binding, adapter)
    expect(fake.sent).toHaveLength(0)
    await renderer.handle({ type: 'complete', sessionId: 'a' }, binding, adapter)
    expect(fake.sent.map((msg) => msg.text).join('')).toBe('long '.repeat(800).trim())
    await renderer.handle({ type: 'plan_submitted', sessionId: 'a' }, binding, adapter)
    expect(fake.sent.at(-1)?.text).toContain('desktop app')
    await renderer.handle({ type: 'credential_request', sessionId: 'a' }, binding, adapter)
    expect(fake.sent.at(-1)?.text).toContain('securely')
    renderer.removeBinding(binding.id)
  })

  it('sends final response file links as QQ attachments once at completion', async () => {
    const { fake, adapter } = await makeAdapter()
    const store = new (await import('../binding-store')).BindingStore(tempDir())
    const binding = store.bind('ws', 'a', 'qq', 'group:g')
    const renderer = new Renderer({ getReplyFiles: async () => [{ buffer: Buffer.from('report'), filename: 'report.txt', linkTargets: ['/workspace/report.txt'] }] })
    await renderer.handle({ type: 'text_complete', sessionId: 'a', text: '[报告](/workspace/report.txt)' }, binding, adapter)
    expect(fake.media).toHaveLength(0)
    await renderer.handle({ type: 'complete', sessionId: 'a' }, binding, adapter)
    await renderer.handle({ type: 'complete', sessionId: 'a' }, binding, adapter)
    expect(fake.media).toHaveLength(1)
    expect(fake.media[0]?.filename).toBe('report.txt')
    expect(fake.sent).toHaveLength(0)
  })

  it('retains normal reply text and unresolved links alongside delivered attachments', async () => {
    const { fake, adapter } = await makeAdapter()
    const store = new (await import('../binding-store')).BindingStore(tempDir())
    const binding = store.bind('ws', 'a', 'qq', 'group:g')
    const renderer = new Renderer({ getReplyFiles: async () => [{ buffer: Buffer.from('report'), filename: 'report.txt', linkTargets: ['/workspace/report.txt'] }] })
    await renderer.handle({ type: 'text_complete', sessionId: 'a', text: '报告已生成。\n[报告](/workspace/report.txt)\n[缺失文件](/workspace/missing.txt)\n[官网](https://example.com)' }, binding, adapter)
    await renderer.handle({ type: 'complete', sessionId: 'a' }, binding, adapter)
    expect(fake.media).toHaveLength(1)
    expect(fake.sent.map(message => message.text)).toEqual(['报告已生成。\n\n缺失文件\n[官网](https://example.com)'])
  })

  it('reports failed attachments without silently hiding their labels', async () => {
    const { fake, adapter } = await makeAdapter()
    const store = new (await import('../binding-store')).BindingStore(tempDir())
    const binding = store.bind('ws', 'a', 'qq', 'group:g')
    const failing = spyOn(fake, 'sendFile').mockRejectedValue(new Error('QQ rejected upload'))
    cleanups.push(() => { failing.mockRestore() })
    const renderer = new Renderer({ getReplyFiles: async () => [{ buffer: Buffer.from('report'), filename: 'report.txt', linkTargets: ['/workspace/report.txt'] }] })
    await renderer.handle({ type: 'text_complete', sessionId: 'a', text: '[报告](/workspace/report.txt)' }, binding, adapter)
    await renderer.handle({ type: 'complete', sessionId: 'a' }, binding, adapter)
    expect(fake.media).toHaveLength(0)
    expect(fake.sent[0]?.text).toContain('未能发送')
    expect(fake.sent[1]?.text).toBe('报告')
  })
})

describe('QQ workspace configuration', () => {
  it('keeps credentials per workspace, persists owner defaults and clears another bot’s bindings', async () => {
    const saved = new Map<string, { value: string }>()
    const credentials = {
      get: async (key: { workspaceId: string; name: string }) => saved.get(`${key.workspaceId}:${key.name}`) ?? null,
      set: async (key: { workspaceId: string; name: string }, value: { value: string }) => { saved.set(`${key.workspaceId}:${key.name}`, value) },
      delete: async (key: { workspaceId: string; name: string }) => { saved.delete(`${key.workspaceId}:${key.name}`) },
    } as unknown as CredentialManager
    const root = tempDir()
    const registry = new MessagingGatewayRegistry({
      sessionManager: {} as ISessionManager, credentialManager: credentials,
      getMessagingDir: (ws) => join(root, ws),
    })
    const initialize = spyOn(QQAdapter.prototype, 'initialize').mockResolvedValue(undefined)
    const test = spyOn(registry, 'testQQCredentials').mockResolvedValue({ success: true })
    cleanups.push(async () => { await registry.stopAll(); initialize.mockRestore(); test.mockRestore() })
    await registry.saveQQCredentials('ws1', creds)
    await registry.saveQQCredentials('ws2', { appId: '999999', appSecret: 'other-secret' })
    expect(saved.size).toBe(2)
    await expect(registry.saveQQCredentials('ws2', creds)).rejects.toThrow('another workspace')
    expect(registry.getConfig('ws1')?.platforms.qq?.accessMode).toBe('owner-only')
    registry.setPlatformOwners('ws1', 'qq', [{ userId: 'owner', addedAt: Date.now() }])
    expect(registry.getPlatformOwners('ws2', 'qq')).toEqual([])
    // Registry owns a separate in-memory binding store; insert through it for the replacement test.
    const state = (registry as unknown as { workspaces: Map<string, { gateway: MessagingGateway }> }).workspaces.get('ws1')!
    state.gateway.getBindingStore().bind('ws1', 'a', 'qq', 'group:g', undefined, { accessMode: 'open' })
    state.gateway.getBindingStore().bind('ws1', 't', 'telegram', '123', undefined, { accessMode: 'open' })
    registry.setPlatformAccessMode('ws1', 'qq', 'owner-only')
    expect(state.gateway.getBindingStore().findByChannel('qq', 'group:g')?.config.accessMode).toBe('inherit')
    expect(state.gateway.getBindingStore().findByChannel('telegram', '123')?.config.accessMode).toBe('open')
    await registry.disconnectPlatform('ws1', 'qq')
    await registry.saveQQCredentials('ws1', { appId: '777777', appSecret: 'replacement' })
    expect(registry.getBindings('ws1').map((b) => b.platform)).toEqual(['telegram'])
    expect(registry.getPlatformOwners('ws1', 'qq')).toEqual([])
    await registry.disconnectPlatform('ws1', 'qq')
    expect(registry.getConfig('ws1')?.runtime.qq?.state).toBe('disconnected')
  })
})
