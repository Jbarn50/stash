import { expect, test } from 'vitest'
import { driveOf, isSameOrInside, normalizePath } from '../../src/core/paths'

test('isSameOrInside ignores case, slash style and trailing separators', () => {
  expect(isSameOrInside('c:/users/JORDA/desktop/', 'C:\\Users\\jorda\\Desktop')).toBe(true)
  expect(isSameOrInside('C:\\Users\\jorda\\Desktop\\a.txt', 'C:\\Users\\jorda\\Desktop\\')).toBe(
    true
  )
})

test('isSameOrInside rejects sibling prefixes', () => {
  expect(isSameOrInside('C:\\Windows2\\x.dll', 'C:\\Windows')).toBe(false)
  expect(isSameOrInside('C:\\Program Files Backup\\a', 'C:\\Program Files')).toBe(false)
})

test('isSameOrInside treats a drive root as the parent of everything on that drive only', () => {
  expect(isSameOrInside('C:\\Users', 'C:\\')).toBe(true)
  expect(isSameOrInside('c:/', 'C:\\')).toBe(true)
  expect(isSameOrInside('D:\\Users', 'C:\\')).toBe(false)
})

test('normalizePath', () => {
  expect(normalizePath('\\\\?\\c:\\Temp\\..\\x\\')).toBe('C:\\x')
  expect(normalizePath('c:/')).toBe('C:\\')
})

test('driveOf gives the upper-case drive letter whatever the path style', () => {
  expect(driveOf('c:/Users/jorda')).toBe('C:')
  expect(driveOf('\\\\?\\d:\\x\\y')).toBe('D:')
})
