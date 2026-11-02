import type { Category, RuleId, SafetyRating } from '../../shared/types'

export interface RuleDef {
  id: RuleId
  category: Category
  safety: SafetyRating
  title: string
  /** What the item is, and what happens if it is removed. */
  explanation: string
}

const rule = (
  id: RuleId,
  category: Category,
  safety: SafetyRating,
  title: string,
  explanation: string
): [RuleId, RuleDef] => [id, { id, category, safety, title, explanation }]

/** Every rule Stash applies (spec §6.3), keyed by id. */
export const RULES: Record<RuleId, RuleDef> = Object.fromEntries([
  rule(
    'duplicates',
    'duplicates',
    'review',
    'Duplicate file',
    'An identical copy of another file in your personal folders. Removing it keeps the copy Stash marks to keep.'
  ),

  rule(
    'temp-user',
    'tempCaches',
    'safe',
    'Old temporary files',
    'Files apps left in your temp folder more than a day ago. Apps recreate anything they still need.'
  ),
  rule(
    'browser-cache-chromium',
    'tempCaches',
    'safe',
    'Chrome or Edge cache',
    'Saved copies of web pages and images that help sites load faster. The browser rebuilds it as you browse; close the browser before cleaning.'
  ),
  rule(
    'browser-cache-firefox',
    'tempCaches',
    'safe',
    'Firefox cache',
    'Saved copies of web pages and images that help sites load faster. Firefox rebuilds it as you browse; close Firefox before cleaning.'
  ),
  rule(
    'crash-dumps',
    'tempCaches',
    'safe',
    'Crash dumps',
    'Memory snapshots saved when an app crashed, kept for troubleshooting. Safe to remove unless a developer asked you for them.'
  ),
  rule(
    'pkg-cache-npm',
    'tempCaches',
    'safe',
    'npm package cache',
    'Packages npm keeps so installs run faster. npm downloads them again when a project needs them.'
  ),
  rule(
    'pkg-cache-pip',
    'tempCaches',
    'safe',
    'pip package cache',
    'Python packages pip keeps so installs run faster. pip downloads them again when needed.'
  ),
  rule(
    'pkg-cache-yarn',
    'tempCaches',
    'safe',
    'Yarn package cache',
    'Packages Yarn keeps so installs run faster. Yarn downloads them again when a project needs them.'
  ),

  rule(
    'downloads-installers',
    'installersStale',
    'review',
    'Old installer or archive',
    'A setup file or archive you downloaded a while ago. Once the program is installed or the archive unpacked, you usually no longer need it.'
  ),
  rule(
    'stale-large',
    'installersStale',
    'review',
    'Large file left unchanged for months',
    "A big file in your personal folders that hasn't been modified in a long time. Check you no longer need it before removing it."
  ),

  rule(
    'dev-node-modules',
    'devLeftovers',
    'review',
    'Unused node_modules',
    "Packages installed for a JavaScript project you haven't worked on in a while. Running npm install in the project restores them."
  ),
  rule(
    'dev-build-output',
    'devLeftovers',
    'review',
    'Old build output',
    "Files a project's build produced. Building the project again recreates them; check the folder holds nothing you made by hand."
  ),
  rule(
    'dev-python-venv',
    'devLeftovers',
    'review',
    'Unused Python virtual environment',
    "A project's private copy of Python and its packages. You can recreate it from the project's requirements."
  ),
  rule(
    'blender-backups',
    'devLeftovers',
    'review',
    'Blender backup file',
    'A backup Blender writes each time you save (.blend1, .blend2 and so on). Your .blend file itself is untouched.'
  ),
  rule(
    'unity-library',
    'devLeftovers',
    'review',
    'Unity Library cache',
    "Unity's import cache for a project you haven't opened in a while. Unity rebuilds it the next time you open the project, which can take a few minutes."
  ),
  rule(
    'unreal-caches',
    'devLeftovers',
    'review',
    'Unreal Engine cache',
    "Intermediate build files and derived data for an Unreal project you haven't opened in a while. Unreal regenerates them the next time you open it."
  ),
  rule(
    'godot-cache',
    'devLeftovers',
    'review',
    'Godot import cache',
    "Imported assets for a Godot project you haven't opened in a while. Godot imports them again the next time you open the project."
  ),
  rule(
    'image-sequences',
    'devLeftovers',
    'review',
    'Old render frames',
    "A folder of numbered image frames, usually render output, that hasn't changed in a while. Keep it if these are your final renders."
  ),

  rule(
    'sys-windows-temp',
    'system',
    'info',
    'Windows temp folder',
    'Temporary files Windows and installers use. Clear them with Disk Cleanup or Storage settings, not by hand.'
  ),
  rule(
    'sys-windows-update',
    'system',
    'info',
    'Windows Update downloads',
    'Update files Windows has already downloaded. Disk Cleanup removes the ones Windows no longer needs.'
  ),
  rule(
    'sys-installer-cache',
    'system',
    'info',
    'Installer cache',
    "Copies Windows keeps so programs can be repaired or uninstalled. Never delete these by hand; uninstall programs you don't use instead."
  ),
  rule(
    'sys-component-store',
    'system',
    'info',
    'Windows component store (WinSxS)',
    "Windows' own library of system components; much of its apparent size is shared with Windows itself. Disk Cleanup's Windows Update Cleanup trims it safely."
  ),
  rule(
    'sys-hiberfil',
    'system',
    'info',
    'Hibernation file',
    'Holds the contents of memory while the PC hibernates. Windows manages it; turning hibernation off (powercfg /h off, as administrator) removes it.'
  ),
  rule(
    'sys-pagefile',
    'system',
    'info',
    'Page file',
    'Virtual memory Windows uses when RAM runs short. Windows manages its size; change it under Advanced system settings > Performance > Virtual memory.'
  )
])

/** Fixed limits for the image-sequence rule. Unlike the thresholds, these are not user settings. */
export const DEFAULT_LIMITS: { imageSeqMinFiles: number; imageSeqMinBytes: number } = Object.freeze(
  {
    imageSeqMinFiles: 100,
    imageSeqMinBytes: 524_288_000
  }
)
