import { readFileSync } from 'node:fs'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ORGANIZE_REASONS } from '../../src/core/projects/movePlan'
import { LikenessStore } from '../../src/main/likenessStore'
import { applyOrganize, undoOrganizeMoves, type OrganizeIo } from '../../src/main/organize'
import { OrganizeLog } from '../../src/main/organizeLog'
import { OrganizeService } from '../../src/main/organizeService'
import { ProjectsStore } from '../../src/main/projectsStore'
import { SAMPLE_ENV } from '../helpers/env'

const NOW = Date.UTC(2026, 10, 2)
const ROOT = 'D:\\Stories\\Ashfen'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'stash-organize-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
  await rm(join(process.cwd(), 'C:\\Windows'), { recursive: true, force: true })
})

function local(winPath: string): string {
  const rest = winPath.replace(/\//g, '\\').replace(/^[A-Za-z]:\\/, '')
  const parts = rest.split('\\').filter((part) => part !== '' && part !== '.' && part !== '..')
  return join(scratch, 'disk', ...parts)
}

function diskIo(): OrganizeIo {
  return {
    async exists(path) {
      try {
        await access(local(path))
        return true
      } catch {
        return false
      }
    },
    async isFile(path) {
      try {
        return (await stat(local(path))).isFile()
      } catch {
        return false
      }
    },
    async mkdir(path) {
      await mkdir(local(path), { recursive: true })
    },
    async rename(from, to) {
      await rename(local(from), local(to))
    }
  }
}

async function put(winPath: string, text: string): Promise<void> {
  const path = local(winPath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

function callsIo(): OrganizeIo & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    exists: async () => {
      calls.push('exists')
      return false
    },
    isFile: async () => {
      calls.push('isFile')
      return true
    },
    mkdir: async () => {
      calls.push('mkdir')
    },
    rename: async () => {
      calls.push('rename')
    }
  }
}

test('a blocked root creates nothing', async () => {
  const io = callsIo()
  const result = await applyOrganize({
    root: 'C:\\Windows\\Ashfen',
    env: SAMPLE_ENV,
    projectId: 'p1',
    requests: [{ from: 'D:\\Imports\\a.png', branch: 'character', folder: 'Mara' }],
    io,
    log: { append: async () => undefined },
    now: () => NOW,
    id: 'org-1'
  })
  expect(result).toMatchObject({
    status: 'refused',
    reason: ORGANIZE_REASONS.blockedRoot,
    moves: []
  })
  expect(io.calls).toEqual([])
  await expect(access(join(process.cwd(), 'C:\\Windows'))).rejects.toThrow()
})

test('a file on another drive stays put and no folder is created', async () => {
  const io = callsIo()
  const result = await applyOrganize({
    root: ROOT,
    env: SAMPLE_ENV,
    projectId: 'p1',
    requests: [{ from: 'C:\\Users\\jorda\\Pictures\\a.png', branch: 'character', folder: 'Mara' }],
    io,
    log: { append: async () => undefined },
    now: () => NOW,
    id: 'org-1'
  })
  expect(result.moves[0]).toMatchObject({ status: 'failed', reason: ORGANIZE_REASONS.crossVolume })
  expect(io.calls).toEqual([])
})

test('a taken destination is left alone', async () => {
  await put('D:\\Stories\\Ashfen\\character\\Mara\\a.png', 'already')
  await put('D:\\Imports\\a.png', 'incoming')
  const logDir = join(scratch, 'app')
  const log = new OrganizeLog(logDir)
  const result = await applyOrganize({
    root: ROOT,
    env: SAMPLE_ENV,
    projectId: 'p1',
    requests: [{ from: 'D:\\Imports\\a.png', branch: 'character', folder: 'Mara' }],
    io: diskIo(),
    log,
    now: () => NOW,
    id: 'org-1'
  })
  expect(result.moves[0]).toMatchObject({ status: 'failed', reason: ORGANIZE_REASONS.destTaken })
  expect(await readFile(local('D:\\Stories\\Ashfen\\character\\Mara\\a.png'), 'utf8')).toBe(
    'already'
  )
  expect(await readFile(local('D:\\Imports\\a.png'), 'utf8')).toBe('incoming')
  expect(await log.readAll()).toEqual([])
})

test('a confirm renames inside the project, logs it, and undo renames it back', async () => {
  await put('D:\\Imports\\a.png', 'mara-bytes')
  await put('D:\\Imports\\b.png', 'mara-two')
  const logDir = join(scratch, 'app')
  const log = new OrganizeLog(logDir)
  const io = diskIo()
  const moved = await applyOrganize({
    root: ROOT,
    env: SAMPLE_ENV,
    projectId: 'p1',
    requests: [
      { from: 'D:\\Imports\\a.png', branch: 'character', folder: 'Mara' },
      { from: 'D:\\Imports\\b.png', branch: 'character', folder: 'Mara' }
    ],
    io,
    log,
    now: () => NOW,
    id: 'org-1'
  })
  expect(moved.status).toBe('done')
  expect(moved.moves.map((move) => move.to)).toEqual([
    'D:\\Stories\\Ashfen\\character\\Mara\\a.png',
    'D:\\Stories\\Ashfen\\character\\Mara\\b.png'
  ])
  expect(await readFile(local('D:\\Stories\\Ashfen\\character\\Mara\\a.png'), 'utf8')).toBe(
    'mara-bytes'
  )
  await expect(access(local('D:\\Imports\\a.png'))).rejects.toThrow()
  const lines = await log.readAll()
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({
    type: 'organize',
    id: 'org-1',
    from: 'D:\\Imports\\a.png',
    to: 'D:\\Stories\\Ashfen\\character\\Mara\\a.png'
  })
  expect(await readdir(logDir)).toEqual(['organize-log.jsonl'])

  const back = await undoOrganizeMoves({
    projectId: 'p1',
    organizeId: 'org-1',
    id: 'undo-1',
    moves: lines.map((line) => ({ from: line.from, to: line.to })),
    io,
    log,
    now: () => NOW
  })
  expect(back).toEqual({ movedBack: 2, failed: 0 })
  expect(await readFile(local('D:\\Imports\\a.png'), 'utf8')).toBe('mara-bytes')
  expect(await readFile(local('D:\\Imports\\b.png'), 'utf8')).toBe('mara-two')
  await expect(access(local('D:\\Stories\\Ashfen\\character\\Mara\\a.png'))).rejects.toThrow()
  expect(await log.pending()).toBeNull()
})

test('undo leaves a file where it is when the old path is taken', async () => {
  await put('D:\\Stories\\Ashfen\\inbox\\a.png', 'filed')
  await put('D:\\Imports\\a.png', 'newer')
  const log = new OrganizeLog(join(scratch, 'app'))
  const back = await undoOrganizeMoves({
    projectId: 'p1',
    organizeId: 'org-1',
    id: 'undo-1',
    moves: [{ from: 'D:\\Imports\\a.png', to: 'D:\\Stories\\Ashfen\\inbox\\a.png' }],
    io: diskIo(),
    log,
    now: () => NOW
  })
  expect(back).toEqual({ movedBack: 0, failed: 1 })
  expect(await readFile(local('D:\\Stories\\Ashfen\\inbox\\a.png'), 'utf8')).toBe('filed')
  expect(await readFile(local('D:\\Imports\\a.png'), 'utf8')).toBe('newer')
  expect(await log.readAll()).toEqual([])
})

test('confirm files a group into the tree and undo reads the organize log', async () => {
  const app = join(scratch, 'app')
  const projectIds = ['p1', 's1']
  const organizeIds = ['org-1', 'undo-1']
  const projects = new ProjectsStore(app, SAMPLE_ENV, () => {
    const id = projectIds.shift()
    if (id === undefined) throw new Error('test ran out of ids')
    return id
  })
  const created = await projects.create('Ashfen', ROOT)
  const service = new OrganizeService(
    projects,
    new OrganizeLog(app),
    new LikenessStore(app),
    SAMPLE_ENV,
    diskIo(),
    async (path) => new Uint8Array(await readFile(local(path))),
    () => NOW,
    () => {
      const id = organizeIds.shift()
      if (id === undefined) throw new Error('test ran out of ids')
      return id
    }
  )
  await put('D:\\Imports\\mara.png', 'mara-bytes')
  const result = await service.confirm(created.id, [
    {
      branch: 'character',
      folder: 'Mara',
      subjectId: null,
      paths: ['D:\\Imports\\mara.png'],
      hashes: ['0000000000000001']
    }
  ])
  expect(result.status).toBe('done')
  expect(result.moves[0]).toMatchObject({
    status: 'moved',
    to: 'D:\\Stories\\Ashfen\\character\\Mara\\mara.png'
  })
  const character = result.project?.branches.find((branch) => branch.kind === 'character')
  expect(character?.subjects).toEqual([{ id: 's1', name: 'Mara', folder: 'Mara' }])
  expect(await readFile(local('D:\\Stories\\Ashfen\\character\\Mara\\mara.png'), 'utf8')).toBe(
    'mara-bytes'
  )
  const names = await readdir(app)
  expect(names).toContain('organize-log.jsonl')
  expect(names).not.toContain('cleanup-log.jsonl')
  const hashes = await readFile(join(app, 'likeness-hashes.json'), 'utf8')
  expect(hashes).toContain('0000000000000001')
  expect(hashes).not.toContain('mara-bytes')

  const undone = await service.undo()
  expect(undone).toEqual({ status: 'done', movedBack: 1, failed: 0 })
  expect(await readFile(local('D:\\Imports\\mara.png'), 'utf8')).toBe('mara-bytes')
})

test('a bad folder name creates nothing', async () => {
  const io = callsIo()
  const projects = new ProjectsStore(join(scratch, 'app'), SAMPLE_ENV, () => 'p1')
  const created = await projects.create('Ashfen', ROOT)
  const service = new OrganizeService(
    projects,
    new OrganizeLog(join(scratch, 'app')),
    new LikenessStore(join(scratch, 'app')),
    SAMPLE_ENV,
    io,
    async () => null,
    () => NOW,
    () => 'org-1'
  )
  const result = await service.confirm(created.id, [
    {
      branch: 'character',
      folder: '..\\Windows',
      subjectId: null,
      paths: ['D:\\Imports\\a.png'],
      hashes: [null]
    }
  ])
  expect(result.moves[0]).toMatchObject({ status: 'failed', reason: ORGANIZE_REASONS.badName })
  expect(io.calls).toEqual([])
})

test('the move does not recycle or unlink', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/organize.ts'), 'utf8')
  expect(source).not.toMatch(/\bunlink\b/)
  expect(source).not.toMatch(/trashItem/)
})
