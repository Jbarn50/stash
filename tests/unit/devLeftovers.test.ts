import { expect, test } from 'vitest'
import { createDetectorContext, type Limits } from '../../src/core/detectors/context'
import { runStaticDetectors } from '../../src/core/detectors/index'
import { DEFAULT_LIMITS } from '../../src/core/rules/catalog'
import { validateSettings } from '../../src/core/settings'
import type { ScanTree } from '../../src/core/tree'
import type { Finding } from '../../src/shared/types'
import { SAMPLE_ENV } from '../helpers/env'
import { treeFrom, type TreeEntry } from '../helpers/treeFrom'

const now = Date.UTC(2026, 10, 1)
const DAY = 86_400_000
const MiB = 1_048_576
const OLD = now - 60 * DAY
const NEW = now - 2 * DAY
const P = 'Users\\jorda\\Projects'

const small = (mtimeMs: number): TreeEntry => ({ size: 300, mtimeMs })
const blob = (mtimeMs: number, size = 2 * MiB): TreeEntry => ({ size, mtimeMs })

function detect(tree: ScanTree, limits?: Partial<Limits>): Finding[] {
  return runStaticDetectors(
    createDetectorContext({
      scanId: 's1',
      tree,
      env: SAMPLE_ENV,
      settings: validateSettings({}),
      now,
      limits
    })
  )
}
const rules = (findings: Finding[]): Record<string, string> =>
  Object.fromEntries(findings.map((f) => [f.path, f.ruleId]))

test('idle node_modules next to package.json is flagged; an active project is not', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\old\\package.json`]: small(OLD),
    [`${P}\\old\\node_modules\\x.js`]: blob(OLD),
    // Activity inside node_modules itself (an npm install) does not make the project active.
    [`${P}\\old2\\package.json`]: small(OLD),
    [`${P}\\old2\\node_modules\\fresh.js`]: blob(NEW),
    [`${P}\\live\\package.json`]: small(NEW),
    [`${P}\\live\\node_modules\\x.js`]: blob(OLD),
    [`${P}\\no-manifest\\node_modules\\x.js`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({
    [`C:\\${P}\\old\\node_modules`]: 'dev-node-modules',
    [`C:\\${P}\\old2\\node_modules`]: 'dev-node-modules'
  })
})

test('a nested node_modules inside a flagged one is not reported again', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\app\\package.json`]: small(OLD),
    [`${P}\\app\\node_modules\\lib\\package.json`]: small(OLD),
    [`${P}\\app\\node_modules\\lib\\node_modules\\dep.js`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({ [`C:\\${P}\\app\\node_modules`]: 'dev-node-modules' })
})

test('build output needs its manifest: target + Cargo.toml yes, target alone no', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\rs\\Cargo.toml`]: small(OLD),
    [`${P}\\rs\\target\\debug\\a.exe`]: blob(OLD),
    [`${P}\\lonely\\target\\a.bin`]: blob(OLD),
    [`${P}\\web\\package.json`]: small(OLD),
    [`${P}\\web\\dist\\app.js`]: blob(OLD),
    [`${P}\\web\\build\\b.js`]: blob(OLD),
    [`${P}\\web2\\package.json`]: small(OLD),
    [`${P}\\web2\\target\\x.bin`]: blob(OLD),
    [`${P}\\pyp\\pyproject.toml`]: small(OLD),
    [`${P}\\pyp\\dist\\pkg.whl`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({
    [`C:\\${P}\\rs\\target`]: 'dev-build-output',
    [`C:\\${P}\\web\\dist`]: 'dev-build-output',
    [`C:\\${P}\\web\\build`]: 'dev-build-output',
    [`C:\\${P}\\pyp\\dist`]: 'dev-build-output'
  })
})

test('bin and obj next to a .csproj are flagged', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\cs\\App.csproj`]: small(OLD),
    [`${P}\\cs\\bin\\Debug\\App.dll`]: blob(OLD),
    [`${P}\\cs\\obj\\x.cache`]: blob(OLD),
    [`${P}\\no-cs\\bin\\tool.exe`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({
    [`C:\\${P}\\cs\\bin`]: 'dev-build-output',
    [`C:\\${P}\\cs\\obj`]: 'dev-build-output'
  })
})

test('a venv is found by pyvenv.cfg whatever its folder name', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\py\\env-3.12\\pyvenv.cfg`]: small(OLD),
    [`${P}\\py\\env-3.12\\Lib\\x.bin`]: blob(OLD),
    [`${P}\\py2\\venv\\Lib\\x.bin`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({ [`C:\\${P}\\py\\env-3.12`]: 'dev-python-venv' })
})

test('Unity Library needs both Assets and ProjectSettings', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\game\\Assets\\a.txt`]: small(OLD),
    [`${P}\\game\\ProjectSettings\\p.txt`]: small(OLD),
    [`${P}\\game\\Library\\c.bin`]: blob(OLD),
    [`${P}\\half\\Assets\\a.txt`]: small(OLD),
    [`${P}\\half\\Library\\c.bin`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({ [`C:\\${P}\\game\\Library`]: 'unity-library' })
})

test('Unreal caches need a .uproject; .godot needs project.godot', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\ue\\Shooter.uproject`]: small(OLD),
    [`${P}\\ue\\Intermediate\\a.bin`]: blob(OLD),
    [`${P}\\ue\\DerivedDataCache\\b.ddc`]: blob(OLD),
    [`${P}\\ue\\Content\\c.uasset`]: blob(OLD),
    [`${P}\\gd\\project.godot`]: small(OLD),
    [`${P}\\gd\\.godot\\imported\\x.ctex`]: blob(OLD),
    [`${P}\\no-gd\\.godot\\x.bin`]: blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({
    [`C:\\${P}\\ue\\Intermediate`]: 'unreal-caches',
    [`C:\\${P}\\ue\\DerivedDataCache`]: 'unreal-caches',
    [`C:\\${P}\\gd\\.godot`]: 'godot-cache'
  })
})

test('.blend1 and .blend12 are flagged; .blend is not', () => {
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\Art\\scene.blend': blob(NEW),
    'Users\\jorda\\Art\\scene.blend1': blob(NEW),
    'Users\\jorda\\Art\\scene.BLEND12': blob(NEW),
    'Users\\jorda\\Art\\notes.blend.txt': blob(NEW)
  })
  const findings = detect(tree)
  expect(rules(findings)).toEqual({
    'C:\\Users\\jorda\\Art\\scene.blend1': 'blender-backups',
    'C:\\Users\\jorda\\Art\\scene.BLEND12': 'blender-backups'
  })
  expect(findings.every((f) => f.kind === 'file')).toBe(true)
})

test('image sequences: 100 frames of 6 MiB idle 31 days flagged; 99 frames not; a big non-frame file blocks it', () => {
  const entries: Record<string, TreeEntry> = {}
  const shot = (name: string, frames: number, mtimeMs: number): void => {
    for (let i = 1; i <= frames; i++) {
      entries[`Users\\jorda\\Renders\\${name}\\frame${String(i).padStart(4, '0')}.exr`] = blob(
        mtimeMs,
        6 * MiB
      )
    }
  }
  shot('full', 100, now - 31 * DAY)
  shot('short', 99, now - 31 * DAY)
  shot('mixed', 100, now - 31 * DAY)
  entries['Users\\jorda\\Renders\\mixed\\master.mov'] = blob(now - 31 * DAY, 100 * MiB)
  shot('recent', 100, now - 5 * DAY)
  expect(rules(detect(treeFrom('C:\\', entries)))).toEqual({
    'C:\\Users\\jorda\\Renders\\full': 'image-sequences'
  })
})

test('default limits', () =>
  expect(DEFAULT_LIMITS).toEqual({ imageSeqMinFiles: 100, imageSeqMinBytes: 524288000 }))

test('stale-large skips a big old file inside a flagged node_modules', () => {
  const tree = treeFrom('C:\\', {
    [`${P}\\app\\package.json`]: small(OLD),
    [`${P}\\app\\node_modules\\huge.bin`]: { size: 200 * MiB, mtimeMs: now - 400 * DAY }
  })
  expect(rules(detect(tree))).toEqual({ [`C:\\${P}\\app\\node_modules`]: 'dev-node-modules' })
})

test('installed tools and apps are not projects: nothing under AppData or a dot-folder is flagged', () => {
  const ext = 'Users\\jorda\\.vscode\\extensions\\pub.ext-1.0.0'
  const app = 'Users\\jorda\\AppData\\Local\\Programs\\SomeApp\\resources\\app'
  const tree = treeFrom('C:\\', {
    [`${ext}\\package.json`]: small(OLD),
    [`${ext}\\node_modules\\x.js`]: blob(OLD),
    [`${app}\\package.json`]: small(OLD),
    [`${app}\\node_modules\\x.js`]: blob(OLD),
    // A project outside the profile is still a project.
    'dev\\proj\\package.json': small(OLD),
    'dev\\proj\\node_modules\\x.js': blob(OLD)
  })
  expect(rules(detect(tree))).toEqual({ 'C:\\dev\\proj\\node_modules': 'dev-node-modules' })
})
