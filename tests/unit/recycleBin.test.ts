import type { Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  binStatus,
  findRecordIn,
  parseMountvol,
  parseRegDwords,
  parseWhoamiSid,
  recycledBytes
} from '../../src/main/recycleBin'
import { makeIRecord } from '../helpers/iRecord'

type FsCall = 'lstat' | 'readdir' | 'stat' | 'readFile'

// Two seams for things a temp folder cannot produce on demand. `execFile` is replaced, so no real
// tool runs in this file (the integration tests run the real ones). The four fs calls below pass
// through to the real disk unless a test overrides one path, to make it fail or to return a value.
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  fsOverrides: new Map<string, () => unknown>()
}))

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const wrap =
    (name: FsCall) =>
    async (...args: unknown[]): Promise<unknown> => {
      const override = mocks.fsOverrides.get(`${name}:${String(args[0])}`)
      return override ? override() : (fs[name] as (...a: unknown[]) => Promise<unknown>)(...args)
    }
  return {
    ...fs,
    lstat: wrap('lstat'),
    readdir: wrap('readdir'),
    stat: wrap('stat'),
    readFile: wrap('readFile')
  }
})

const errno = (code: string): Error => Object.assign(new Error(code), { code })
function failFs(call: FsCall, path: string, code: string): void {
  mocks.fsOverrides.set(`${call}:${path}`, () => {
    throw errno(code)
  })
}
function stubFs(call: FsCall, path: string, value: unknown): void {
  mocks.fsOverrides.set(`${call}:${path}`, () => value)
}
const fileOfSize = (size: number): Stats => ({ isDirectory: () => false, size }) as unknown as Stats

let root: string
let bin: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stash-bin-'))
  bin = join(root, 'bin')
  await mkdir(bin)
  // A process nobody expected fails at once rather than hanging the test.
  mocks.execFile.mockImplementation((...args: unknown[]) => {
    const done = args[args.length - 1] as (error: Error) => void
    done(new Error('unexpected process'))
  })
})
afterEach(async () => {
  mocks.fsOverrides.clear()
  mocks.execFile.mockReset()
  await rm(root, { recursive: true, force: true })
})

async function put(path: string, bytes: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 7))
  return path
}

describe('parsers', () => {
  test('parseMountvol', () => {
    expect(parseMountvol('    \\\\?\\Volume{8b748fbd-2416-4233-9195-ff48d41241de}\\\r\n')).toBe(
      '{8b748fbd-2416-4233-9195-ff48d41241de}'
    )
  })

  test('parseMountvol returns the GUID exactly as printed, and null when there is none', () => {
    expect(parseMountvol('\\\\?\\Volume{8B748FBD-2416-4233-9195-FF48D41241DE}\\\n')).toBe(
      '{8B748FBD-2416-4233-9195-FF48D41241DE}'
    )
    expect(parseMountvol('')).toBeNull()
    expect(parseMountvol('The system cannot find the file specified.\r\n')).toBeNull()
    expect(parseMountvol('\\\\?\\Volume{not-a-guid}\\\r\n')).toBeNull()
    expect(parseMountvol('Volume{8b748fbd-2416-4233-9195-ff48d41241de}')).toBeNull()
  })

  test('parseRegDwords', () => {
    expect(
      parseRegDwords(
        '\r\nHKEY_CURRENT_USER\\...\\{8b748fbd-2416-4233-9195-ff48d41241de}\r\n    MaxCapacity    REG_DWORD    0x66e7\r\n    NukeOnDelete    REG_DWORD    0x0\r\n'
      )
    ).toEqual({ MaxCapacity: 26343, NukeOnDelete: 0 })
  })

  test('parseRegDwords reads hexadecimal, tolerates LF line ends, and ignores what is not a DWORD', () => {
    const text = [
      '',
      'HKEY_LOCAL_MACHINE\\Software\\Example',
      '    Big    REG_DWORD    0xFFFFFFFF',
      '    Name With Spaces    REG_DWORD    0x10',
      '    Text    REG_SZ    0x5',
      '    Wide    REG_QWORD    0x7',
      '    Blob    REG_BINARY    0A0B',
      'HKEY_LOCAL_MACHINE\\Software\\Example\\Child',
      'NotIndented    REG_DWORD    0x1',
      '    Broken    REG_DWORD    zz',
      ''
    ].join('\n')
    expect(parseRegDwords(text)).toEqual({ Big: 4294967295, 'Name With Spaces': 16 })
    expect(parseRegDwords('')).toEqual({})
  })

  test('parseWhoamiSid', () => {
    expect(parseWhoamiSid('"desktop-1\\jorda","S-1-5-21-1-2-3-1001"\r\n')).toBe(
      'S-1-5-21-1-2-3-1001'
    )
  })

  test('parseWhoamiSid takes the last field, and refuses anything that is not a SID', () => {
    expect(parseWhoamiSid('"AzureAD\\Jo Bloggs","S-1-12-1-1-2-3-4"')).toBe('S-1-12-1-1-2-3-4')
    for (const text of [
      '',
      '\r\n',
      'ERROR: Access is denied.\r\n',
      '"desktop-1\\jorda","not a sid"\r\n',
      '"desktop-1\\jorda","S-1-5"\r\n',
      '"desktop-1\\jorda","S-2-5-21-1-2-3"\r\n',
      '"desktop-1\\jorda","S-1-5-21-1-2-x"\r\n',
      '"S-1-5-21-1-2-3-1001","desktop-1\\jorda"\r\n'
    ]) {
      expect(() => parseWhoamiSid(text), JSON.stringify(text)).toThrow()
    }
  })
})

describe('binStatus', () => {
  const disabled = { status: 'disabled', maxCapacityBytes: 0 }
  const unknown = { status: 'unknown', maxCapacityBytes: 0 }

  test.each([
    ['the Group Policy is set and the volume could not be read', null, true, disabled],
    [
      'the Group Policy is set though the volume says on',
      { NukeOnDelete: 0, MaxCapacity: 100 },
      true,
      disabled
    ],
    ['the volume could not be read', null, false, unknown],
    ['NukeOnDelete is 1', { NukeOnDelete: 1, MaxCapacity: 100 }, false, disabled],
    ['NukeOnDelete is 1 and MaxCapacity is missing', { NukeOnDelete: 1 }, false, disabled],
    [
      'NukeOnDelete is 0 and MaxCapacity (in MB) is present',
      { NukeOnDelete: 0, MaxCapacity: 100 },
      false,
      { status: 'enabled', maxCapacityBytes: 104_857_600 }
    ],
    ['NukeOnDelete is 0 and MaxCapacity is missing', { NukeOnDelete: 0 }, false, unknown],
    ['NukeOnDelete is missing', { MaxCapacity: 100 }, false, unknown],
    ['NukeOnDelete is neither 0 nor 1', { NukeOnDelete: 2, MaxCapacity: 100 }, false, unknown],
    ['the volume has none of the values', {}, false, unknown]
  ])('%s', (_name, volume, noRecycleFiles, expected) => {
    expect(binStatus(volume, noRecycleFiles)).toEqual(expected)
  })

  test('MaxCapacity is in megabytes of 1,048,576 bytes', () => {
    expect(binStatus({ NukeOnDelete: 0, MaxCapacity: 26343 }, false)).toEqual({
      status: 'enabled',
      maxCapacityBytes: 27_622_637_568
    })
  })
})

describe('recycledBytes', () => {
  test('adds up a $R file, and a $R folder with nested files', async () => {
    await put(join(bin, '$RAAAAAA.txt'), 1000)
    await put(join(bin, '$RBBBBBB', 'a.bin'), 100)
    await put(join(bin, '$RBBBBBB', 'sub', 'b.bin'), 2000)
    await put(join(bin, '$RBBBBBB', 'sub', 'deeper', 'c.bin'), 30)
    await mkdir(join(bin, '$RBBBBBB', 'empty'))
    expect(await recycledBytes(bin)).toBe(3130)
  })

  test('does not follow a junction, inside a $R folder or as a $R entry itself', async () => {
    const outside = join(root, 'outside')
    await put(join(outside, 'big.bin'), 5000)
    await put(join(bin, '$RCCCCCC', 'real.bin'), 400)
    const inner = join(bin, '$RCCCCCC', 'link')
    const top = join(bin, '$RDDDDDD')
    await symlink(outside, inner, 'junction')
    await symlink(outside, top, 'junction')
    // A link counts as itself, by its own lstat size, and never as the folder it points to.
    const links = (await lstat(inner)).size + (await lstat(top)).size
    expect(await recycledBytes(bin)).toBe(400 + links)
  })

  test('ignores everything that is not a $R entry', async () => {
    await put(join(bin, '$RAAAAAA.txt'), 10)
    await put(join(bin, '$IAAAAAA.txt'), 544)
    await put(join(bin, 'desktop.ini'), 129)
    await put(join(bin, 'notes.bin'), 7000)
    await put(join(bin, 'Other', 'big.bin'), 7000)
    expect(await recycledBytes(bin)).toBe(10)
  })

  test('a folder that is missing or empty holds nothing', async () => {
    expect(await recycledBytes(join(root, 'not-there'))).toBe(0)
    expect(await recycledBytes(bin)).toBe(0)
  })

  test('a bin folder that cannot be listed is an error, not an empty bin', async () => {
    failFs('readdir', bin, 'EPERM')
    await expect(recycledBytes(bin)).rejects.toMatchObject({ code: 'EPERM' })
  })

  test('a file that vanishes while the bin is read counts as nothing', async () => {
    await put(join(bin, '$RAAAAAA', 'a.bin'), 100)
    const gone = await put(join(bin, '$RAAAAAA', 'b.bin'), 200)
    await put(join(bin, '$RBBBBBB.txt'), 40)
    failFs('lstat', gone, 'ENOENT')
    expect(await recycledBytes(bin)).toBe(140)
  })

  test('a $R entry or a folder inside it that vanishes counts as nothing', async () => {
    const vanished = await put(join(bin, '$RAAAAAA.txt'), 500)
    await put(join(bin, '$RBBBBBB', 'keep.bin'), 60)
    await put(join(bin, '$RBBBBBB', 'sub', 'lost.bin'), 70)
    failFs('lstat', vanished, 'ENOENT')
    failFs('readdir', join(bin, '$RBBBBBB', 'sub'), 'ENOENT')
    expect(await recycledBytes(bin)).toBe(60)
  })

  describe('an entry it cannot measure', () => {
    const when = new Date()
    // The $I record states the size Windows counted when the item was recycled.
    const iRecord = (size: bigint): Buffer =>
      makeIRecord({ originalSize: size, deletedAtMs: when.getTime(), path: 'C:\\Users\\jorda\\x' })

    test('is counted at the original size in its $I record, whatever was summed before the error', async () => {
      await put(join(bin, '$REEEEEE', 'a.bin'), 100)
      const unreadable = await put(join(bin, '$REEEEEE', 'b.bin'), 200)
      await writeFile(join(bin, '$IEEEEEE'), iRecord(12_345n))
      await put(join(bin, '$RFFFFFF.txt'), 50)
      failFs('lstat', unreadable, 'EPERM')
      expect(await recycledBytes(bin)).toBe(12_345 + 50)
    })

    test('is counted at its $I size when a folder inside it cannot be listed', async () => {
      await put(join(bin, '$REEEEEE', 'sub', 'a.bin'), 100)
      await writeFile(join(bin, '$IEEEEEE'), iRecord(777n))
      failFs('readdir', join(bin, '$REEEEEE', 'sub'), 'EACCES')
      expect(await recycledBytes(bin)).toBe(777)
    })

    test('is counted at its $I size when the $R entry itself cannot be read', async () => {
      const entry = await put(join(bin, '$REEEEEE.txt'), 10)
      await writeFile(join(bin, '$IEEEEEE.txt'), iRecord(4096n))
      failFs('lstat', entry, 'EBUSY')
      expect(await recycledBytes(bin)).toBe(4096)
    })

    test('makes the whole count fail when its $I record is missing, unreadable or damaged', async () => {
      const entry = await put(join(bin, '$REEEEEE.txt'), 10)
      failFs('lstat', entry, 'EPERM')
      await expect(recycledBytes(bin)).rejects.toMatchObject({ code: 'ENOENT' })

      await mkdir(join(bin, '$IEEEEEE.txt')) // a folder where the record should be
      await expect(recycledBytes(bin)).rejects.toMatchObject({ code: 'EISDIR' })
      await rm(join(bin, '$IEEEEEE.txt'), { recursive: true })

      await writeFile(join(bin, '$IEEEEEE.txt'), Buffer.from('not a record at all, no'))
      await expect(recycledBytes(bin)).rejects.toThrow('Unsupported $I record')
    })
  })
})

describe('findRecordIn', () => {
  const SINCE = Date.UTC(2026, 10, 1, 12, 0, 0)
  const PATH = 'C:\\Users\\jorda\\Música\\naïve 📁 写真.txt'

  // Writes a file (or makes a folder) in the bin and sets its modified time, so that no test depends
  // on the wall clock. The default is just after the batch started.
  async function putI(iName: string, content: Buffer | null, mtimeMs = SINCE + 500): Promise<void> {
    const file = join(bin, iName)
    if (content) await writeFile(file, content)
    else await mkdir(file)
    await utimes(file, new Date(mtimeMs), new Date(mtimeMs))
  }

  const validRecord = (): Buffer =>
    makeIRecord({ originalSize: 1n, deletedAtMs: SINCE + 500, path: PATH })

  async function putRecord(
    iName: string,
    r: { path?: string; deletedAtMs?: number; mtimeMs?: number }
  ): Promise<void> {
    const record = makeIRecord({
      originalSize: 10n,
      deletedAtMs: r.deletedAtMs ?? SINCE + 500,
      path: r.path ?? PATH
    })
    await putI(iName, record, r.mtimeMs)
  }

  test('finds the record of a path, whatever its case, slashes or \\\\?\\ prefix, and names the $R', async () => {
    await putRecord('$IA1B2C3.txt', {})
    await putRecord('$IZZZZZZ.txt', { path: 'C:\\Users\\jorda\\other.txt' })
    const expected = {
      iName: '$IA1B2C3.txt',
      rName: '$RA1B2C3.txt',
      originalPath: PATH,
      deletedAtMs: SINCE + 500
    }
    for (const asked of [
      PATH,
      'c:/users/JORDA/música/NAÏVE 📁 写真.TXT',
      `\\\\?\\${PATH}`,
      'C:\\Users\\jorda\\Música\\..\\Música\\naïve 📁 写真.txt'
    ]) {
      expect(await findRecordIn(bin, asked, SINCE), asked).toEqual(expected)
    }
  })

  test('is null when no record is for that path, or there are none', async () => {
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()
    await putRecord('$IA1B2C3.txt', { path: 'C:\\Users\\jorda\\Música\\naïve 📁 写真.txt.bak' })
    await putRecord('$IA1B2C4.txt', { path: 'C:\\Users\\jorda\\Música' })
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()
  })

  test('is null when the folder is missing or cannot be listed', async () => {
    expect(await findRecordIn(join(root, 'not-there'), PATH, SINCE)).toBeNull()
    failFs('readdir', bin, 'EPERM')
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()
  })

  test('reads only $I files last written within a minute before the batch started', async () => {
    await putRecord('$ISTALE1.txt', { mtimeMs: SINCE - 61_000 })
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()
    await putRecord('$IRECENT.txt', { mtimeMs: SINCE - 59_000 })
    expect((await findRecordIn(bin, PATH, SINCE))?.iName).toBe('$IRECENT.txt')
  })

  test('a record deleted more than two seconds before the batch started is not a match', async () => {
    await putRecord('$IOLDER1.txt', { deletedAtMs: SINCE - 2_001 })
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()
    await putRecord('$IEDGE01.txt', { deletedAtMs: SINCE - 2_000 })
    expect((await findRecordIn(bin, PATH, SINCE))?.iName).toBe('$IEDGE01.txt')
  })

  test.each([
    ['the newer record sorts first', '$IAAAAAA.txt', '$IZZZZZZ.txt'],
    ['the newer record sorts last', '$IZZZZZZ.txt', '$IAAAAAA.txt']
  ])('the newest of two matches wins when %s', async (_name, newer, older) => {
    await putRecord(newer, { deletedAtMs: SINCE + 3_000 })
    await putRecord(older, { deletedAtMs: SINCE + 1_000 })
    expect(await findRecordIn(bin, PATH, SINCE)).toMatchObject({
      iName: newer,
      deletedAtMs: SINCE + 3_000
    })
  })

  test('skips $I files that are malformed, truncated, version 1 or unreadable', async () => {
    const version1 = validRecord()
    version1.writeBigInt64LE(1n, 0)
    await putI('$IGARBAGE.txt', Buffer.from('this is not a record'))
    await putI('$IVERSN1.txt', version1)
    await putI('$ITRUNCD.txt', validRecord().subarray(0, validRecord().length - 2))
    await putI('$IEMPTY0.txt', Buffer.alloc(0))
    await putI('$IAFOLDER', null) // a folder: reading it fails
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()

    await putRecord('$IGOODONE.txt', {})
    expect((await findRecordIn(bin, PATH, SINCE))?.iName).toBe('$IGOODONE.txt')
  })

  test('a $I file that cannot be read or vanishes does not stop the others', async () => {
    await putRecord('$IAAAAAA.txt', {})
    await putRecord('$IBBBBBB.txt', { deletedAtMs: SINCE + 900 })
    failFs('stat', join(bin, '$IBBBBBB.txt'), 'ENOENT')
    expect((await findRecordIn(bin, PATH, SINCE))?.iName).toBe('$IAAAAAA.txt')
    mocks.fsOverrides.clear()
    failFs('readFile', join(bin, '$IBBBBBB.txt'), 'EPERM')
    expect((await findRecordIn(bin, PATH, SINCE))?.iName).toBe('$IAAAAAA.txt')
  })

  test('looks only at $I files', async () => {
    // Each would match if it were read as a record.
    await putI('$RA1B2C3.txt', validRecord())
    await putI('desktop.ini', validRecord())
    await putI('A$IA1B2C3.txt', validRecord())
    expect(await findRecordIn(bin, PATH, SINCE)).toBeNull()
  })
})

// The Windows tools are faked with what they print on a real machine.
describe('with the Windows tools faked', () => {
  const GUID = '{8b748fbd-2416-4233-9195-ff48d41241de}'
  const SID = 'S-1-5-21-111-222-333-1001'
  const BIN = `C:\\$Recycle.Bin\\${SID}`
  const VOLUME_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\${GUID}`
  const POLICY_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'
  const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

  interface Machine {
    mountvol: string | Error
    volume: Record<string, number> | Error
    /** NoRecycleFiles per hive; a hive left out has no such value, and reg.exe exits 1. */
    policies: { HKCU?: number; HKLM?: number }
    sid: string | Error
  }

  const listing = (key: string, values: Record<string, number>): string =>
    `\r\n${key}\r\n${Object.entries(values)
      .map(([name, v]) => `    ${name}    REG_DWORD    0x${v.toString(16)}\r\n`)
      .join('')}\r\n`

  function answer(m: Machine, tool: string, args: string[]): string | Error {
    if (tool === 'mountvol.exe') return m.mountvol
    if (tool === 'whoami.exe') return m.sid
    if (tool === 'reg.exe') {
      if (args[1] === VOLUME_KEY) {
        return m.volume instanceof Error ? m.volume : listing(VOLUME_KEY, m.volume)
      }
      for (const hive of ['HKCU', 'HKLM'] as const) {
        const key = `${hive}\\${POLICY_KEY}`
        if (args[1] !== key) continue
        const value = m.policies[hive]
        return value === undefined
          ? new Error('ERROR: The system was unable to find the specified registry key or value.')
          : listing(key, { NoRecycleFiles: value })
      }
    }
    return new Error(`unexpected command: ${tool} ${args.join(' ')}`)
  }

  /** Starts the module afresh (it remembers the SID) against a machine that answers like Windows. */
  async function boot(
    overrides: Partial<Machine> = {}
  ): Promise<typeof import('../../src/main/recycleBin') & { machine: Machine }> {
    const machine: Machine = {
      mountvol: `    \\\\?\\Volume${GUID}\\\r\n`,
      volume: { MaxCapacity: 26343, NukeOnDelete: 0 },
      policies: {},
      sid: `"mytop\\jorda","${SID}"\r\n`,
      ...overrides
    }
    mocks.execFile.mockImplementation(
      (
        file: string,
        args: string[],
        _options: unknown,
        done: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        const reply = answer(machine, basename(file).toLowerCase(), args)
        queueMicrotask(() => (reply instanceof Error ? done(reply, '', '') : done(null, reply, '')))
      }
    )
    stubFs('readdir', BIN, []) // the user's real bin is never read in this file
    vi.resetModules()
    return { ...(await import('../../src/main/recycleBin')), machine }
  }

  const started = (tool: string): string[][] =>
    mocks.execFile.mock.calls
      .filter(([file]) => basename(file as string).toLowerCase() === tool)
      .map(([, args]) => args as string[])

  describe('getRecycleBinInfo', () => {
    test('an enabled bin reports its capacity in bytes and what its $R entries hold', async () => {
      const { getRecycleBinInfo } = await boot()
      stubFs('readdir', BIN, ['$RAAAAAA.txt', '$IAAAAAA.txt', 'desktop.ini', '$RBBBBBB'])
      stubFs('lstat', join(BIN, '$RAAAAAA.txt'), fileOfSize(1234))
      stubFs('lstat', join(BIN, '$RBBBBBB'), fileOfSize(66))
      expect(await getRecycleBinInfo('C:')).toEqual({
        drive: 'C:',
        status: 'enabled',
        maxCapacityBytes: 27_622_637_568,
        usedBytes: 1300
      })
    })

    test('the drive letter is upper-cased, and the volume is found through its GUID', async () => {
      const { getRecycleBinInfo } = await boot()
      expect((await getRecycleBinInfo('c:')).drive).toBe('C:')
      expect(started('mountvol.exe')).toEqual([['C:', '/L']])
      expect(started('reg.exe')).toContainEqual(['query', VOLUME_KEY])
    })

    test('the Group Policy is read from both hives, for the one value', async () => {
      const { getRecycleBinInfo } = await boot()
      await getRecycleBinInfo('C:')
      expect(started('reg.exe')).toEqual(
        expect.arrayContaining([
          ['query', `HKCU\\${POLICY_KEY}`, '/v', 'NoRecycleFiles'],
          ['query', `HKLM\\${POLICY_KEY}`, '/v', 'NoRecycleFiles']
        ])
      )
    })

    test('every tool is started by absolute path, hidden, with a timeout and no shell', async () => {
      const { getRecycleBinInfo } = await boot()
      await getRecycleBinInfo('C:')
      const tools = new Set<string>()
      expect(mocks.execFile.mock.calls.length).toBeGreaterThanOrEqual(4)
      for (const [file, , options] of mocks.execFile.mock.calls) {
        expect(isAbsolute(file as string)).toBe(true)
        expect(dirname(file as string)).toBe(SYSTEM32)
        expect(options).toEqual({ windowsHide: true, timeout: 10_000 })
        tools.add(basename(file as string).toLowerCase())
      }
      expect([...tools].sort()).toEqual(['mountvol.exe', 'reg.exe', 'whoami.exe'])
    })

    test('a bin that is turned off is disabled, and its usage is not measured', async () => {
      const { getRecycleBinInfo } = await boot({ volume: { MaxCapacity: 26343, NukeOnDelete: 1 } })
      failFs('readdir', BIN, 'EPERM') // measuring it would fail, and make the answer unknown
      expect(await getRecycleBinInfo('C:')).toEqual({
        drive: 'C:',
        status: 'disabled',
        maxCapacityBytes: 0,
        usedBytes: 0
      })
    })

    test.each([
      ['the user Group Policy', { HKCU: 1 }],
      ['the machine Group Policy', { HKLM: 1 }],
      ['both Group Policies', { HKCU: 1, HKLM: 1 }],
      ['a Group Policy with another non-zero value', { HKCU: 2 }]
    ])('%s: the bin is off even when the volume says on', async (_name, policies) => {
      const { getRecycleBinInfo } = await boot({ policies })
      failFs('readdir', BIN, 'EPERM')
      expect(await getRecycleBinInfo('C:')).toEqual({
        drive: 'C:',
        status: 'disabled',
        maxCapacityBytes: 0,
        usedBytes: 0
      })
    })

    test('a Group Policy that turns the bin off counts even when the volume cannot be read', async () => {
      const { getRecycleBinInfo } = await boot({
        mountvol: new Error('The system cannot find the file specified.'),
        policies: { HKLM: 1 }
      })
      expect((await getRecycleBinInfo('C:')).status).toBe('disabled')
    })

    test('a Group Policy set to 0, or not set at all, leaves the volume in charge', async () => {
      const { getRecycleBinInfo } = await boot({ policies: { HKCU: 0, HKLM: 0 } })
      expect((await getRecycleBinInfo('C:')).status).toBe('enabled')
      const { getRecycleBinInfo: again } = await boot({ policies: {} })
      expect((await again('C:')).status).toBe('enabled')
    })

    test.each([
      ['mountvol fails', { mountvol: new Error('The system cannot find the file specified.') }],
      ['mountvol prints no volume', { mountvol: 'nothing useful\r\n' }],
      ['the volume key cannot be read', { volume: new Error('ERROR: key not found') }],
      ['the volume key has no NukeOnDelete', { volume: { MaxCapacity: 26343 } }],
      ['the volume key has no MaxCapacity', { volume: { NukeOnDelete: 0 } }],
      ['NukeOnDelete is neither 0 nor 1', { volume: { MaxCapacity: 26343, NukeOnDelete: 7 } }],
      ['whoami fails, so the bin folder is unknown', { sid: new Error('whoami failed') }]
    ])('is unknown when %s', async (_name, broken) => {
      const { getRecycleBinInfo } = await boot(broken as Partial<Machine>)
      expect(await getRecycleBinInfo('C:')).toEqual({
        drive: 'C:',
        status: 'unknown',
        maxCapacityBytes: 0,
        usedBytes: 0
      })
    })

    test('is unknown, never an error or a guess, when the bin cannot be measured', async () => {
      const { getRecycleBinInfo } = await boot()
      failFs('readdir', BIN, 'EPERM')
      expect(await getRecycleBinInfo('C:')).toEqual({
        drive: 'C:',
        status: 'unknown',
        maxCapacityBytes: 0,
        usedBytes: 0
      })
    })

    test('is unknown when an entry cannot be measured and has no usable $I record', async () => {
      const { getRecycleBinInfo } = await boot()
      stubFs('readdir', BIN, ['$RAAAAAA.txt'])
      failFs('lstat', join(BIN, '$RAAAAAA.txt'), 'EPERM')
      failFs('readFile', join(BIN, '$IAAAAAA.txt'), 'ENOENT')
      expect((await getRecycleBinInfo('C:')).status).toBe('unknown')
    })

    test.each([
      '',
      'C',
      'c',
      'C:\\',
      'C:\\Windows',
      'CD:',
      '1:',
      ' C:',
      'C: ',
      'C:\n',
      '\\\\srv\\share',
      ':'
    ])('is unknown for %j, without starting any process', async (drive) => {
      const { getRecycleBinInfo } = await boot()
      expect(await getRecycleBinInfo(drive)).toEqual({
        drive,
        status: 'unknown',
        maxCapacityBytes: 0,
        usedBytes: 0
      })
      expect(mocks.execFile).not.toHaveBeenCalled()
    })
  })

  describe('recycleBinDir', () => {
    test('is the drive, $Recycle.Bin and the user SID', async () => {
      const { recycleBinDir } = await boot()
      expect(await recycleBinDir('C:')).toBe(BIN)
      expect(await recycleBinDir('d:')).toBe(`D:\\$Recycle.Bin\\${SID}`)
    })

    test.each(['', 'C', 'C:\\', 'CD:', '\\\\srv\\share'])(
      'rejects %j as an invalid drive, without starting any process',
      async (drive) => {
        const { recycleBinDir } = await boot()
        await expect(recycleBinDir(drive)).rejects.toThrow(new Error('Invalid drive'))
        expect(mocks.execFile).not.toHaveBeenCalled()
      }
    )
  })

  describe('getUserSid', () => {
    test('asks whoami once and remembers the answer', async () => {
      const { getUserSid } = await boot()
      expect(await getUserSid()).toBe(SID)
      expect(await getUserSid()).toBe(SID)
      expect(started('whoami.exe')).toEqual([['/user', '/fo', 'csv', '/nh']])
    })

    test('does not remember a failure: the next call asks again', async () => {
      const { getUserSid, machine } = await boot({ sid: new Error('whoami failed') })
      await expect(getUserSid()).rejects.toThrow('whoami failed')
      machine.sid = 'ERROR: not a SID\r\n'
      await expect(getUserSid()).rejects.toThrow()
      machine.sid = `"mytop\\jorda","${SID}"\r\n`
      expect(await getUserSid()).toBe(SID)
      expect(await getUserSid()).toBe(SID)
      expect(started('whoami.exe')).toHaveLength(3)
    })
  })

  describe('findRecycledRecord', () => {
    const PATH = 'C:\\Users\\jorda\\Música\\naïve 📁 写真.txt'

    test('looks in the user bin folder of the drive', async () => {
      const { findRecycledRecord } = await boot()
      const deletedAtMs = Date.now()
      const iFile = join(BIN, '$IAB12CD.txt')
      stubFs('readdir', BIN, ['$IAB12CD.txt', '$RAB12CD.txt'])
      stubFs('stat', iFile, { mtimeMs: deletedAtMs })
      stubFs('readFile', iFile, makeIRecord({ originalSize: 5n, deletedAtMs, path: PATH }))
      expect(await findRecycledRecord('c:', PATH.toUpperCase(), deletedAtMs - 10)).toEqual({
        iName: '$IAB12CD.txt',
        rName: '$RAB12CD.txt',
        originalPath: PATH,
        deletedAtMs
      })
    })

    test('is null, and never an error, when it cannot look', async () => {
      const { findRecycledRecord } = await boot()
      expect(await findRecycledRecord('C:', PATH, Date.now())).toBeNull() // nothing in the bin
      failFs('readdir', BIN, 'ENOENT')
      expect(await findRecycledRecord('C:', PATH, Date.now())).toBeNull() // no bin folder
      failFs('readdir', BIN, 'EPERM')
      expect(await findRecycledRecord('C:', PATH, Date.now())).toBeNull() // not allowed to look
    })

    test('is null when the user SID is unknown', async () => {
      const { findRecycledRecord } = await boot({ sid: new Error('whoami failed') })
      expect(await findRecycledRecord('C:', PATH, Date.now())).toBeNull()
    })

    test.each(['', 'C', 'C:\\', '\\\\srv\\share'])(
      'is null for the invalid drive %j, without starting any process',
      async (drive) => {
        const { findRecycledRecord } = await boot()
        expect(await findRecycledRecord(drive, PATH, Date.now())).toBeNull()
        expect(mocks.execFile).not.toHaveBeenCalled()
      }
    )
  })
})
