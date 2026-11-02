import { describe, expect, test } from 'vitest'
import { isBlocked } from '../../src/core/blocklist'
import {
  BRANCH_KINDS,
  addSubject,
  emptyProject,
  folderSegment,
  relativeDir,
  removeSubject
} from '../../src/core/projects/tree'
import { SAMPLE_ENV } from '../helpers/env'

const env = SAMPLE_ENV
const root = 'D:\\Stories\\Ashfen'

describe('folder segments', () => {
  test('keeps a readable name and refuses a path', () => {
    expect(folderSegment('  Mara Voss  ')).toBe('Mara Voss')
    expect(folderSegment('mist-pines')).toBe('mist-pines')
    expect(folderSegment('')).toBeNull()
    expect(folderSegment('   ')).toBeNull()
    expect(folderSegment('.')).toBeNull()
    expect(folderSegment('..')).toBeNull()
    expect(folderSegment('a\\b')).toBeNull()
    expect(folderSegment('a/b')).toBeNull()
    expect(folderSegment('a:b')).toBeNull()
    expect(folderSegment('con')).toBeNull()
    expect(folderSegment('CON.txt')).toBeNull()
    expect(folderSegment('aux')).toBeNull()
    expect(folderSegment('lpt1')).toBeNull()
    expect(folderSegment('nul')).toBeNull()
    expect(folderSegment('name.')).toBeNull()
    expect(folderSegment('name ')).toBe('name')
    expect(folderSegment('bad<name>')).toBeNull()
    expect(folderSegment('a\u0001b')).toBeNull()
    expect(folderSegment('what?')).toBeNull()
    expect(folderSegment('a'.repeat(81))).toBeNull()
  })
})

describe('project tree', () => {
  test('starts with the four branches and an inbox, and no files move', () => {
    const tree = emptyProject({ id: 'p1', name: 'Ashfen', rootPath: root }, env)
    expect(tree).toMatchObject({
      version: 1,
      id: 'p1',
      name: 'Ashfen',
      rootPath: root
    })
    expect(tree?.branches.map((b) => b.kind)).toEqual([...BRANCH_KINDS])
    expect(tree?.branches.every((b) => b.subjects.length === 0)).toBe(true)
  })

  test('refuses a root Stash is not allowed to treat as a user folder', () => {
    expect(isBlocked('C:\\Windows\\Ashfen', env)).toBe(true)
    expect(
      emptyProject({ id: 'p', name: 'Ashfen', rootPath: 'C:\\Windows\\Ashfen' }, env)
    ).toBeNull()
    expect(emptyProject({ id: 'p', name: 'Ashfen', rootPath: 'C:\\Users\\jorda' }, env)).toBeNull()
    expect(
      emptyProject(
        { id: 'p', name: 'Ashfen', rootPath: 'C:\\Users\\jorda\\AppData\\Roaming\\Stash\\x' },
        env
      )
    ).toBeNull()
    expect(emptyProject({ id: 'p', name: 'Ashfen', rootPath: 'not-a-path' }, env)).toBeNull()
    expect(
      emptyProject({ id: 'p', name: 'Ashfen', rootPath: 'C:\\PROGRA~1\\Ashfen' }, env)
    ).toBeNull()
    expect(emptyProject({ id: 'p', name: 'con', rootPath: root }, env)).toBeNull()
    expect(
      emptyProject(
        { id: 'p', name: 'Ashfen', rootPath: 'C:\\Users\\jorda\\OneDrive\\Documents' },
        env
      )
    ).toBeNull()
    expect(
      emptyProject(
        {
          id: 'p',
          name: 'Ashfen',
          rootPath: 'C:\\Users\\jorda\\OneDrive\\Documents\\Ashfen'
        },
        env
      )?.rootPath
    ).toBe('C:\\Users\\jorda\\OneDrive\\Documents\\Ashfen')
  })

  test('a subject is a folder under its branch, and the same name may exist on another branch', () => {
    const tree = emptyProject({ id: 'p1', name: 'Ashfen', rootPath: root }, env)
    expect(tree).not.toBeNull()
    if (tree === null) return
    const withMara = addSubject(tree, 'character', 'Mara', 's1')
    expect(withMara?.branches.find((b) => b.kind === 'character')?.subjects).toEqual([
      { id: 's1', name: 'Mara', folder: 'Mara' }
    ])
    expect(relativeDir('character', 'Mara')).toBe('character\\Mara')
    const again = withMara && addSubject(withMara, 'character', 'mara', 's2')
    expect(again).toBeNull()
    const place = withMara && addSubject(withMara, 'location', 'Mara', 's3')
    expect(place?.branches.find((b) => b.kind === 'location')?.subjects[0]?.folder).toBe('Mara')
    expect(addSubject(tree, 'character', '..\\Windows', 's4')).toBeNull()
    expect(addSubject(tree, 'lore', '', 's5')).toBeNull()
  })

  test('adding a subject does not change the tree it was given', () => {
    const tree = emptyProject({ id: 'p1', name: 'Ashfen', rootPath: root }, env)
    expect(tree).not.toBeNull()
    if (tree === null) return
    addSubject(tree, 'scenery', 'mist pines', 's1')
    expect(tree.branches.every((b) => b.subjects.length === 0)).toBe(true)
    const next = addSubject(tree, 'scenery', 'mist pines', 's1')
    expect(relativeDir('scenery', next?.branches[0] ? 'mist pines' : '')).toBe(
      'scenery\\mist pines'
    )
    expect(next?.branches.find((b) => b.kind === 'scenery')?.subjects[0]).toEqual({
      id: 's1',
      name: 'mist pines',
      folder: 'mist pines'
    })
    const gone = next && removeSubject(next, 's1')
    expect(gone?.branches.every((b) => b.subjects.length === 0)).toBe(true)
    expect(next?.branches.find((b) => b.kind === 'scenery')?.subjects).toHaveLength(1)
    expect(removeSubject(tree, 'missing')).toBeNull()
  })
})
