import { expect, test } from 'vitest'
import { isMarkerFile } from '../../src/core/rules/markers'

test.each([
  'package.json',
  'Package.JSON',
  'pyproject.toml',
  'Cargo.toml',
  'project.godot',
  'pyvenv.cfg',
  'App.csproj',
  'Game.uproject'
])('%s is a marker', (name) => expect(isMarkerFile(name)).toBe(true))

test.each(['package.json.bak', 'readme.md', 'csproj', 'x.uproject.old', 'pyvenv.cfg.txt'])(
  '%s is not a marker',
  (name) => expect(isMarkerFile(name)).toBe(false)
)
