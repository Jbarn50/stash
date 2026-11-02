### Task 19: Full round trip, installer, manual checks

**Files:**
- Modify: `tests/e2e/app.spec.ts`, `electron-builder.yml`
- Create: `docs/manual-checks.md`

**Interfaces:**
- Consumes: the whole app; `findRecycledRecord` (Task 10) for the safety net.

- [ ] **Step 1: Write the round-trip e2e test.**

```ts
test('recycle the fixture .blend1, then restore it from History', async () => {
  const original = readFileSync(fx.p.blend1)
  // Cleanup → expand "Dev & creative leftovers" → tick scene.blend1 → Clean selected → Clean
  await expect(page.getByText(/Recycled 1 item/)).toBeVisible()
  expect(existsSync(fx.p.blend1)).toBe(false)
  // History → Restore
  await expect(page.getByText('restored')).toBeVisible()
  expect(readFileSync(fx.p.blend1)).toEqual(original)
})
test('a folder changed after the scan is skipped as "changed since scan"', async () => {
  writeFileSync(join(fx.p.webapp, 'node_modules', 'new.txt'), 'x')   // changes the folder's own mtime
  // Cleanup → tick the webapp node_modules finding → Clean selected → Clean
  await expect(page.getByText('changed since scan')).toBeVisible()
  expect(existsSync(join(fx.p.webapp, 'node_modules'))).toBe(true)
})
// afterAll: if p.blend1 is missing, move it back via findRecycledRecord; then fx.dispose()
```

- [ ] **Step 2:** Run `npm run test:e2e`. Expect a PASS. A failure points to wiring in Tasks 14–17; fix it there and re-run.
- [ ] **Step 3: Installer.**
  - In `electron-builder.yml`, set NSIS `oneClick: false`, `allowToChangeInstallationDirectory: true` and `artifactName: Stash-Setup-${version}.${ext}`, with no signing.
  - Run `npm run build:win`.
  - Expect `dist\Stash-Setup-<version>.exe` to exist.
- [ ] **Step 4: Write `docs/manual-checks.md`** with a results column. Checks 2–5 are read-only, so the implementer runs them and records the results. Cleanup is never run on real files.
  1. Install from `dist\`. SmartScreen will warn: choose **More info**, then **Run anyway**.
  2. Scan C:. The total should be within 5% of File Explorer's "Used space" for C:. Unreadable folders explain the gap, and **Rescan as administrator** narrows it.
  3. "Windows can clean these" lists `hiberfil.sys` and `pagefile.sys`, about 6.2 GB and 26.4 GB on this machine.
  4. A OneDrive file known to be cloud-only shows about 0 B in Explore.
  5. After **Rescan as administrator**, `C:\Windows\Temp` shows a size.
- [ ] **Step 5: Full verification.** Run `npm run typecheck`, `npm test` and `npm run test:e2e`. All pass.
- [ ] **Step 6: Commit** `git add -A; git commit -m "test: end-to-end recycle and restore; NSIS installer; manual checks"`
