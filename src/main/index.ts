import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { errorMessage } from '../core/errorMessage'
import { CHANNELS } from '../shared/ipc'
import type { Settings } from '../shared/types'
import { BinUsageCache } from './binUsage'
import { CleanupLog } from './cleanupLog'
import { buildWinEnv } from './env'
import { forwarder, registerIpc, startupScanRoot } from './ipc'
import { LiveSettings } from './liveSettings'
import { driveRoots } from './overview'
import { getRecycleBinInfo } from './recycleBin'
import { ScanSession } from './session'
import { loadSettings, saveSettings } from './settings'
import { createHashRunner, createScanRunner } from './workerRunners'

// Tests point STASH_USER_DATA at a throwaway folder so they never touch the real settings or cleanup log.
app.setPath('userData', process.env.STASH_USER_DATA ?? join(app.getPath('appData'), 'Stash'))

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    title: 'Stash',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // The renderer never opens new windows or navigates away from the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/**
 * The settings Stash starts with. An unreadable settings.json stops Stash with a message: running on
 * the defaults would drop the user's exclusions, and the next save would overwrite their file.
 */
async function startupSettings(dir: string): Promise<Settings | null> {
  try {
    return await loadSettings(dir)
  } catch (e) {
    dialog.showErrorBox(
      "Stash couldn't read its settings",
      `${join(dir, 'settings.json')}\n\n${errorMessage(e)}\n\nFix or move the file, then start Stash again.`
    )
    app.quit()
    return null
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('local.stash.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  const userData = app.getPath('userData')
  const loaded = await startupSettings(userData)
  if (loaded === null) return

  const env = buildWinEnv()
  const settings = new LiveSettings(loaded, (s) => saveSettings(userData, s))
  const log = new CleanupLog(userData)
  const currentWindow = (): BrowserWindow | null => mainWindow
  const session = new ScanSession({
    scanRunner: createScanRunner(),
    hashRunner: createHashRunner(),
    getSettings: () => settings.get(),
    env,
    emit: forwarder(currentWindow, CHANNELS.onSessionEvent)
  })
  const binUsage = new BinUsageCache(
    () => driveRoots(settings.get().scanTargets).map((root) => root.slice(0, 2)),
    getRecycleBinInfo
  )
  registerIpc({
    session,
    log,
    settingsDir: userData,
    env,
    recycler: { trash: (p) => shell.trashItem(p) },
    window: currentWindow,
    settings,
    binUsage
  })

  mainWindow = createWindow()
  // A relaunch through "Rescan as administrator" asks for its scan with --scan=<root>.
  const scanRoot = startupScanRoot(process.argv)
  if (scanRoot !== null) {
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        session.start(scanRoot)
      } catch (e) {
        console.error(`Couldn't start the scan of ${scanRoot}:`, errorMessage(e))
      }
    })
  }
  // Measuring the Recycle Bins can take seconds, so it never holds up the window.
  void binUsage.refresh()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
