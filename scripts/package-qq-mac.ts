/** Build the independent, locally signed Craft Agents QQ app without uploading. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This packaging entry point targets Apple Silicon macOS')
}
const root = join(import.meta.dir, '..')
const { version } = JSON.parse(readFileSync(join(root, 'qq-release.json'), 'utf8')) as { version: string }
if (!/^\d+\.\d+\.\d+-qq\.\d+$/.test(version)) throw new Error('Invalid version in qq-release.json')
const appDir = join(root, 'apps', 'electron')
const output = join(appDir, 'release', 'qq')
const bun = existsSync(join(root, '.local-tools', 'bun')) ? join(root, '.local-tools', 'bun') : process.execPath
const dependencies = join(root, 'node_modules')
const resources = [
  { from: bun, to: 'app/vendor/bun/bun' },
  { from: join(dependencies, '@anthropic-ai', 'claude-agent-sdk'), to: 'app/node_modules/@anthropic-ai/claude-agent-sdk' },
  { from: join(dependencies, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'), to: 'app/node_modules/@anthropic-ai/claude-agent-sdk-binary' },
  { from: join(dependencies, '@vscode', 'ripgrep'), to: 'app/node_modules/@vscode/ripgrep' },
  { from: join(root, 'packages', 'pi-agent-server', 'dist', 'index.js'), to: 'app/resources/pi-agent-server/index.js' },
  { from: join(dependencies, '@silvia-odwyer', 'photon-node'), to: 'app/resources/pi-agent-server/node_modules/@silvia-odwyer/photon-node' },
  { from: join(root, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'), to: 'messaging-whatsapp-worker/worker.cjs' },
]
const env = {
  ...process.env,
  PATH: [join(root, '.local-tools'), join(dependencies, '.bin'), process.env.PATH].filter(Boolean).join(':'),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
}
const uvPath = spawnSync('which', ['uv'], { env, encoding: 'utf8' }).stdout?.trim()
if (uvPath && existsSync(uvPath)) resources.push({ from: uvPath, to: 'app/resources/bin/darwin-arm64/uv' })
function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Build command failed: ${command} (${result.status})`)
}
run(bun, ['run', 'electron:build'])
for (const resource of resources) {
  if (!existsSync(resource.from)) throw new Error(`Missing packaged resource: ${resource.from}`)
}
mkdirSync(output, { recursive: true })
const configPath = join(output, 'qq-builder.json')
const baseConfig = parse(readFileSync(join(appDir, 'electron-builder.yml'), 'utf8'))
writeFileSync(configPath, JSON.stringify({
  ...baseConfig,
  appId: 'local.craftagents.qq',
  productName: 'Craft Agents QQ',
  directories: { ...baseConfig.directories, output },
  electronDist: join(dependencies, 'electron', 'dist'),
  npmRebuild: false,
  publish: null,
  extraMetadata: { ...baseConfig.extraMetadata, version, name: 'craft-agents-qq', productName: 'Craft Agents QQ', craftCustomBuild: 'qq' },
  mac: {
    ...baseConfig.mac,
    identity: '-',
    notarize: false,
    extraResources: resources,
  },
}, null, 2))
run(join(dependencies, '.bin', 'electron-builder'), ['--config', configPath, '--mac', '--arm64', '--dir', '--publish', 'never'], appDir)
const packagedResources = join(output, 'mac-arm64', 'Craft Agents QQ.app', 'Contents', 'Resources', 'app')
run(bun, [join(root, 'scripts', 'verify-pi-images.ts'),
  '--bun', join(packagedResources, 'vendor', 'bun', 'bun'),
  '--bundle', join(packagedResources, 'resources', 'pi-agent-server', 'index.js'),
  '--photon', join(packagedResources, 'resources', 'pi-agent-server', 'node_modules', '@silvia-odwyer', 'photon-node'),
])
console.log(`Built App: ${join(output, 'mac-arm64', 'Craft Agents QQ.app')}`)
if (process.argv.includes('--archive')) {
  const archive = join(output, `Craft-Agents-QQ-${version}-arm64.zip`)
  run('codesign', ['--verify', '--deep', '--strict', join(output, 'mac-arm64', 'Craft Agents QQ.app')])
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(output, 'mac-arm64', 'Craft Agents QQ.app'), archive])
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archive.split('/').at(-1)}\n`)
  console.log(`Release archive: ${archive}`)
}
