# Stash — manual checks

These checks run against the **installed** app, built by `npm run build:win` into `dist\Stash-Setup-<version>.exe`. Checks 2–5 only read: none of them cleans anything. Cleanup is never run on real files.

Run Stash from the Start menu or the desktop shortcut, not from a Claude session's shell. The Claude desktop app is MSIX-packaged, so a program started from one of its shells may see a redirected copy of `%APPDATA%` and `%LOCALAPPDATA%`.

The installer creates those shortcuts itself. How, and which icon they show, is in `docs/installer.md`. The desktop shortcut should show the indigo tile with the bone disk, the mint slice, and the copper bolt.

| #   | Check                                                         | Expected                                                                                                                                                                                                                                                    | Result |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Install from `dist\Stash-Setup-<version>.exe`.                | SmartScreen warns, because the installer is unsigned: choose **More info**, then **Run anyway**. The installer lets you choose the folder. A desktop shortcut and a Start menu shortcut appear, both with the Stash disk icon, and Stash starts afterwards. |        |
| 2   | Scan C:.                                                      | The total is within 5% of File Explorer's "Used space" for C:. Unreadable folders explain the gap, and **Rescan as administrator** narrows it.                                                                                                              |        |
| 3   | Open "Windows can clean these".                               | It lists `hiberfil.sys` (about 6.2 GB on this machine) and `pagefile.sys` (about 26.4 GB).                                                                                                                                                                  |        |
| 4   | In Explore, find a OneDrive file known to be cloud-only.      | It shows about 0 B.                                                                                                                                                                                                                                         |        |
| 5   | Choose **Rescan as administrator** and accept the UAC prompt. | `C:\Windows\Temp` now shows a size.                                                                                                                                                                                                                         |        |

Results: write the date, the observed value and pass/fail in the Result column.
