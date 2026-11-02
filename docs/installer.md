# Installer, shortcuts, and icons

Stash ships as an unsigned NSIS installer, `dist/Stash-Setup-<version>.exe`, from `npm run build:win`. The settings are in `electron-builder.yml`. This page is what that file actually does. It was checked against electron-builder 26's NSIS templates (`app-builder-lib/templates/nsis`).

## What the installer creates

The installer is assisted (`oneClick: false`), so it asks for a folder (`allowToChangeInstallationDirectory: true`). It does not show a checkbox for shortcuts. It creates them itself.

| Shortcut   | Where                             | When                                                                                                                                                                                                                        |
| ---------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop    | `%USERPROFILE%\Desktop\Stash.lnk` | Every fresh install. `createDesktopShortcut: always` also creates it again on a later install when the shortcut is missing and the run is not an in-place update. Pass `--no-desktop-shortcut` to the installer to skip it. |
| Start menu | Start Menu `\Stash.lnk`           | Every fresh install (`createStartMenuShortcut: true`). An upgrade keeps the existing one.                                                                                                                                   |

`shortcutName` is the product name, `Stash`. Both shortcuts are `CreateShortCut` of `Stash.exe`, with that exe as the icon (icon index 0). The taskbar grouping id written onto the link is `local.stash.app`, the same `appId` the window sets at startup.

Uninstall removes both links. It does not empty the Recycle Bin and it does not delete `%APPDATA%\Stash` (settings and the cleanup log stay).

## Where the icon comes from

`win.icon` is `build/icon.ico`. electron-builder embeds it in `Stash.exe` with rcedit. Because the shortcuts point at the exe, the desktop icon, the Start menu icon, the taskbar icon, and Alt-Tab all show that file.

The `.ico` holds PNG images at 16, 20, 24, 32, 40, 48, 64, 96, 128, and 256. Sizes 24 and below are a drawn drawer-and-gauge, so a 100% taskbar still reads. Larger sizes are the full picture in `build/icon.png` (1024×1024).

| File                                     | Used for                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `build/icon.png`                         | Master art, 1024×1024. Linux packaging if no other icon is given.                  |
| `build/icon.ico`                         | Windows exe, installer, uninstaller, and therefore every shortcut.                 |
| `build/icon.icns`                        | macOS bundle, if anyone runs `npm run build:mac`. Not part of the Windows v1 ship. |
| `resources/icon.png`                     | Window icon while developing, and on Linux. Imported from `src/main/index.ts`.     |
| `src/renderer/src/assets/stash-mark.png` | The mark beside "Stash" in the sidebar.                                            |

`nsis.installerIcon` and `nsis.uninstallerIcon` are the same `.ico`, so Add/Remove Programs and the installer window match the exe.

Regenerate the derived files after changing the master:

```bash
python3 scripts/render-icon.py
```

The script is not shipped. `electron-builder.yml` excludes `scripts/`.

## What is not done yet

The installer is unsigned, so SmartScreen warns on first run. There is no Windows certificate in the config. `npm run build:win` has to be run on Windows; it was not run for this change. The checks in `docs/manual-checks.md` are still blank, including "Stash starts afterwards" from the shortcut.
