// Small project files the scanner remembers by name, because the dev-leftover rules need them to
// recognise a project even though files this small are not tracked one by one.
const MARKER_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'cargo.toml',
  'project.godot',
  'pyvenv.cfg'
])
const MARKER_EXTENSIONS = ['.csproj', '.uproject']

/** True for a project manifest the detectors look for. Case-insensitive, as Windows names are. */
export function isMarkerFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MARKER_NAMES.has(lower) || MARKER_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
