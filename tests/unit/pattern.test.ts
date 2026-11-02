import { expect, test } from 'vitest'
import { resolvePattern } from '../../src/core/rules/pattern'
import { SAMPLE_ENV } from '../helpers/env'
import { treeFrom } from '../helpers/treeFrom'

const CHROME = 'Users\\jorda\\AppData\\Local\\Google\\Chrome\\User Data'
const file = { size: 10, mtimeMs: 1 }
const tree = treeFrom('C:\\', {
  [`${CHROME}\\Default\\Cache\\f`]: file,
  [`${CHROME}\\Default\\Code Cache\\f`]: file,
  [`${CHROME}\\Default\\Network\\f`]: file,
  [`${CHROME}\\Profile 1\\GPUCache\\f`]: file,
  'Windows\\Temp\\x.tmp': file,
  'Users\\jorda\\AppData\\Local\\Temp\\y.tmp': file
})
const paths = (ids: number[]): string[] => ids.map((id) => tree.folderPath(id)).sort()

test('resolvePattern expands tokens, * and {a,b} case-insensitively', () => {
  expect(
    paths(
      resolvePattern(
        tree,
        '%localappdata%\\google\\chrome\\USER DATA\\*\\{cache,GPUCache}',
        SAMPLE_ENV
      )
    )
  ).toEqual([`C:\\${CHROME}\\Default\\Cache`, `C:\\${CHROME}\\Profile 1\\GPUCache`])
})

test('an alternative may contain a space', () => {
  expect(
    paths(
      resolvePattern(tree, '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\{Code Cache}', SAMPLE_ENV)
    )
  ).toEqual([`C:\\${CHROME}\\Default\\Code Cache`])
})

test('a pattern without wildcards resolves to that one folder', () => {
  expect(paths(resolvePattern(tree, '%LOCALAPPDATA%\\Google', SAMPLE_ENV))).toEqual([
    'C:\\Users\\jorda\\AppData\\Local\\Google'
  ])
  expect(resolvePattern(tree, '%LOCALAPPDATA%\\npm-cache', SAMPLE_ENV)).toEqual([])
})

test('%SYSTEMROOT% and %TEMP% expand to the env folders', () => {
  expect(paths(resolvePattern(tree, '%SYSTEMROOT%\\Windows\\Temp', SAMPLE_ENV))).toEqual([
    'C:\\Windows\\Temp'
  ])
  expect(paths(resolvePattern(tree, '%TEMP%', SAMPLE_ENV))).toEqual([
    'C:\\Users\\jorda\\AppData\\Local\\Temp'
  ])
})

test('resolvePattern returns nothing when the base is outside the scanned root', () => {
  const other = treeFrom('D:\\Data', { 'npm-cache\\x': file })
  expect(resolvePattern(other, '%LOCALAPPDATA%\\npm-cache', SAMPLE_ENV)).toEqual([])
})
