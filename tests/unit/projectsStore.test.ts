import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ProjectsStore } from '../../src/main/projectsStore'
import { SAMPLE_ENV } from '../helpers/env'

let dir: string
let ids: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stash-projects-'))
  ids = ['p1', 's1', 's2']
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function store(): ProjectsStore {
  return new ProjectsStore(dir, SAMPLE_ENV, () => {
    const id = ids.shift()
    if (id === undefined) throw new Error('test ran out of ids')
    return id
  })
}

test('a project is remembered and no folder is created at its root', async () => {
  const saved = await store().create('Ashfen', 'D:\\Stories\\Ashfen')
  expect(saved.rootPath).toBe('D:\\Stories\\Ashfen')
  expect(saved.branches.map((branch) => branch.kind)).toEqual([
    'inbox',
    'character',
    'lore',
    'scenery',
    'location'
  ])
  const withMara = await store().addSubject(saved.id, 'character', 'Mara')
  expect(withMara.branches.find((branch) => branch.kind === 'character')?.subjects).toEqual([
    { id: 's1', name: 'Mara', folder: 'Mara' }
  ])
  const listed = await store().list()
  expect(listed).toEqual([withMara])
  // The app-data folder holds the record only. The project root is a string in that file.
  expect(await readdir(dir)).toEqual(['projects.json'])
  const text = await readFile(join(dir, 'projects.json'), 'utf8')
  expect(text).toContain('D:\\\\Stories\\\\Ashfen')
  expect(text).not.toContain('mkdir')
})

test('a protected root is refused and nothing is written', async () => {
  await expect(store().create('Ashfen', 'C:\\Windows\\Ashfen')).rejects.toThrow(
    /can't be a project/
  )
  expect(await readdir(dir)).toEqual([])
})

test('removing a name drops it from the record and leaves the file tree alone', async () => {
  const projects = store()
  const saved = await projects.create('Ashfen', 'D:\\Stories\\Ashfen')
  const withPlace = await projects.addSubject(saved.id, 'location', 'North Gate')
  const subject = withPlace.branches.find((branch) => branch.kind === 'location')?.subjects[0]
  expect(subject?.folder).toBe('North Gate')
  const cleared = await projects.removeSubject(saved.id, subject?.id ?? '')
  expect(cleared.branches.every((branch) => branch.subjects.length === 0)).toBe(true)
  expect(await readdir(dir)).toEqual(['projects.json'])
})

test('a damaged projects file is set aside', async () => {
  await writeFile(join(dir, 'projects.json'), '{')
  expect(await store().list()).toEqual([])
  expect(await readdir(dir)).toEqual(['projects.json.bad'])
})
