/** Offline image and compaction checks against the actual relocated Pi bundle. */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1]!)
}
const bundle = argument('--bundle')
const photonPackage = argument('--photon')
const bunIndex = process.argv.indexOf('--bun')
const bun = bunIndex >= 0 ? argument('--bun') : process.execPath
const scratch = mkdtempSync(join(tmpdir(), 'craft-pi-image-smoke-'))
try {
  cpSync(photonPackage, join(scratch, 'node_modules', '@silvia-odwyer', 'photon-node'), { recursive: true })
  const require = createRequire(import.meta.url)
  const photon = require(join(photonPackage, 'photon_rs.js'))
  const pixels = new Uint8Array(2400 * 32 * 4).fill(255)
  const image = new photon.PhotonImage(pixels, 2400, 32)
  try {
    writeFileSync(join(scratch, 'large.png'), image.get_bytes())
    writeFileSync(join(scratch, 'large.jpg'), image.get_bytes_jpeg(80))
  } finally { image.free() }

  const source = readFileSync(bundle, 'utf8')
  // This build is intentionally not minified. Append a test-only probe in the
  // bundle's scope so both model-input processing and the real Read tool run
  // exactly the code shipped, without initializing credentials or a model.
  for (const name of ['processImage', 'createReadToolDefinition', 'createCraftSettingsManager', 'shouldCompact', 'readContextUsage']) {
    if (!source.includes(`function ${name}(`)) throw new Error(`Missing bundled image probe: ${name}`)
  }
  const probe = `
globalThis.fetch = () => { throw new Error('Offline image probe cannot access the network') };
(async () => {
  const settings = createCraftSettingsManager();
  for (const capacity of [1000000, 200000, 131072, 8192]) {
    const model = {id: 'smoke', provider: 'test', contextWindow: capacity};
    const policy = settings.getCompactionSettings(model);
    const threshold = Math.floor(capacity * 70 / 100);
    if (shouldCompact(threshold, capacity, policy) || !shouldCompact(threshold + 1, capacity, policy)) {
      throw new Error('Bundled compaction threshold is not 70 percent');
    }
    const usage = readContextUsage({model, settingsManager: settings, getContextUsage: () => ({tokens: 1, contextWindow: capacity})});
    if (usage.compactionSettings?.reserveTokens !== capacity - threshold) throw new Error('Host threshold metadata is stale');
  }
  console.log('PI_POLICY_SMOKE_OK: model-aware 70 percent thresholds and host metadata');
  const fs = await import('node:fs/promises');
  const photon = await import('@silvia-odwyer/photon-node');
  for (const [name, mimeType] of [['large.png', 'image/png'], ['large.jpg', 'image/jpeg']]) {
    const bytes = await fs.readFile(name);
    const result = await processImage(bytes, mimeType);
    if (!result.ok || !result.data) throw new Error('Prompt image processing failed: ' + result.message);
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(result.data, 'base64'));
    try {
      if (decoded.get_width() > 2000 || decoded.get_height() > 2000) throw new Error('Image was not resized');
    } finally { decoded.free() }
    const read = await createReadToolDefinition(process.cwd()).execute('smoke', {path: name});
    if (!read.content.some(block => block.type === 'image' && block.data.length > 0)) {
      throw new Error('Read tool omitted image: ' + JSON.stringify(read.content));
    }
  }
  console.log('PI_IMAGE_SMOKE_OK: PNG/JPEG prompt inputs and Read tool images');
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1) });
`
  const relocatedBundle = join(scratch, 'index.js')
  writeFileSync(relocatedBundle, source + probe)
  const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: scratch, CRAFT_DEBUG: '0' }
    const child = spawn(bun, [relocatedBundle], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Pi image smoke test timed out')) }, 30_000)
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-10_000) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolveResult({ code, output }) })
  })
  if (result.code !== 0 || !result.output.includes('PI_IMAGE_SMOKE_OK') || !result.output.includes('PI_POLICY_SMOKE_OK')) {
    throw new Error(`Relocated Pi image smoke test failed:\n${result.output}`)
  }
  console.log('PI_IMAGE_SMOKE_OK: PNG/JPEG prompt inputs and Read tool images')
  console.log('PI_POLICY_SMOKE_OK: model-aware 70 percent thresholds and host metadata')
} finally { rmSync(scratch, { recursive: true, force: true }) }
