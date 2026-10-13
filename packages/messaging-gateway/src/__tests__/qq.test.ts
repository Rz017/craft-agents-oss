import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
    ])
    await adapter.sendText('group:same-id', 'reply')
    expect(fake.sent[0]?.target).toEqual({ scope: 'group', targetId: 'same-id', msgId: 'm1' })
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
    await expect(adapter.sendFile()).rejects.toThrow('not supported')
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
