import { app } from 'electron'
import { join } from 'node:path'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'

// Read installed metadata at runtime: electron-builder adds this marker only to
// the QQ distribution, while the regular upstream build keeps its defaults.
export const isQQCustomBuild = (() => {
  try {
    return readJsonFileSync<{ craftCustomBuild?: string }>(
      join(app.getAppPath(), 'package.json'),
    ).craftCustomBuild === 'qq'
  } catch { return false }
})()
