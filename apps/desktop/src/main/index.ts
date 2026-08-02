import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { IPC_CHANNELS, type AgentEvent, type CommandMap } from '../shared/contracts';
import { DesktopAgentService } from './agent-service';
import { CommandService } from './command-service';
import { ConnectorService } from './connector-service';
import { createConnectorTestSeam } from './connector-test-seam';
import { DesktopMcpBridge } from './mcp-service';
import {
  isAllowedExternalUrl,
  isAllowedRendererNavigation,
  resolveDesktopLaunchHooks,
  type DesktopLaunchHooks,
} from './navigation-security';
import { ElectronSecretStoreBackend, SecureStore } from './secure-store';
import { VaultService } from './vault-service';

let mainWindow: BrowserWindow | null = null;
let vaultService: VaultService | null = null;
let agentService: DesktopAgentService | null = null;
let mcpBridge: DesktopMcpBridge | null = null;
let ipcRegistered = false;
let shutdownStarted = false;

// electron-vite emits the main process as an ES module. Derive the bundle
// directory from import.meta.url instead of relying on CommonJS' __dirname,
// which is not defined when the built application starts.
const mainModuleDirectory = dirname(fileURLToPath(import.meta.url));

function startupDiagnostic(stage: string): void {
  if (process.env.OUTREACHR_STARTUP_DIAGNOSTICS === '1') {
    process.stderr.write(`[outreachr-startup] ${stage}\n`);
  }
}

startupDiagnostic('main module evaluated');

async function openExternal(value: unknown): Promise<void> {
  if (!isAllowedExternalUrl(value)) {
    throw new Error('Only credential-free HTTPS links may be opened externally');
  }
  await shell.openExternal(value, { activate: true });
}

function resourcesRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : resolve(app.getAppPath(), 'resources', 'generated');
}

function emitAgentEvent(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC_CHANNELS.agentEvent, event);
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC request from an untrusted renderer');
  }
}

async function createWindow(
  commandService: CommandService,
  launchHooks: DesktopLaunchHooks,
): Promise<BrowserWindow> {
  const rendererEntry = join(mainModuleDirectory, '../renderer/index.html');
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    backgroundColor: '#f7f9fb',
    title: 'Outreachr',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(mainModuleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedRendererNavigation(url, rendererEntry, launchHooks.developmentRendererUrl)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void openExternal(url).catch(() => undefined);
  };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.handle(IPC_CHANNELS.bootstrap, (event) => {
      assertTrustedIpcSender(event);
      return commandService.bootstrap();
    });
    ipcMain.handle(
      IPC_CHANNELS.command,
      async (event, command: keyof CommandMap, payload: unknown) => {
        assertTrustedIpcSender(event);
        const result = await commandService.execute(command, payload);
        if (command === 'data.reset') {
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 100);
        }
        return result;
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.selectFile,
      async (event, filters?: Array<{ name: string; extensions: string[] }>) => {
        assertTrustedIpcSender(event);
        const owner = BrowserWindow.getFocusedWindow();
        const options: Electron.OpenDialogOptions = {
          properties: ['openFile'],
          ...(filters ? { filters } : {}),
        };
        const result = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    );
    ipcMain.handle(IPC_CHANNELS.selectDirectory, async (event) => {
      assertTrustedIpcSender(event);
      const owner = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle(IPC_CHANNELS.openExternal, (event, url: string) => {
      assertTrustedIpcSender(event);
      return openExternal(url);
    });
    ipcMain.handle(IPC_CHANNELS.revealPath, (event, path: string) => {
      assertTrustedIpcSender(event);
      if (typeof path !== 'string' || !path.trim() || path.length > 4_096)
        throw new Error('Invalid local path');
      shell.showItemInFolder(resolve(path));
    });
    ipcMain.handle(IPC_CHANNELS.copyText, (event, text: string) => {
      assertTrustedIpcSender(event);
      if (typeof text !== 'string' || text.length > 1_000_000)
        throw new Error('Invalid clipboard text');
      clipboard.writeText(text);
    });
    ipcMain.handle(
      IPC_CHANNELS.openLegal,
      async (event, document: 'license' | 'notice' | 'third-party') => {
        assertTrustedIpcSender(event);
        const names = {
          license: 'LICENSE',
          notice: 'NOTICE',
          'third-party': 'THIRD_PARTY_NOTICES.md',
        } as const;
        if (!(document in names)) throw new Error('Unknown legal document');
        const base = app.isPackaged ? process.resourcesPath : resolve(app.getAppPath(), '..', '..');
        const error = await shell.openPath(join(base, names[document]));
        if (error) throw new Error(error);
      },
    );
  }

  if (launchHooks.developmentRendererUrl) await window.loadURL(launchHooks.developmentRendererUrl);
  else await window.loadFile(rendererEntry);
  if (launchHooks.openDevTools) window.webContents.openDevTools({ mode: 'detach' });
  return window;
}

async function start(): Promise<void> {
  const launchHooks = resolveDesktopLaunchHooks(process.env, app.isPackaged);
  if (launchHooks.e2eDataDirectory) app.setPath('userData', resolve(launchHooks.e2eDataDirectory));
  startupDiagnostic('waiting for Electron ready');
  await app.whenReady();
  startupDiagnostic('Electron ready');
  app.setAppUserModelId('app.outreachr.desktop');
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  const vault = new VaultService({
    appVersion: app.getVersion(),
    platform: process.platform,
    dataDirectory: app.getPath('userData'),
    resourceDirectory: resourcesRoot(),
  });
  startupDiagnostic('initializing vault');
  await vault.initialize();
  startupDiagnostic('vault initialized');
  const integrity = vault.integrityCheck();
  if (!integrity.ok)
    throw new Error(`Local SQLite integrity check failed: ${integrity.messages.join('; ')}`);
  const auditIntegrity = vault.auditIntegrity();
  if (!auditIntegrity.ok) {
    throw new Error(
      `Local audit chain verification failed at sequence ${auditIntegrity.errorAt ?? 'unknown'}`,
    );
  }
  vaultService = vault;
  const connectorTestSeam = createConnectorTestSeam(process.env, !app.isPackaged);
  const secureStore = new SecureStore(
    vault.vault,
    connectorTestSeam?.secretBackend ?? new ElectronSecretStoreBackend(),
  );
  const connectors = new ConnectorService({
    vault,
    secureStore,
    openExternal,
    ...(connectorTestSeam
      ? {
          fetch: connectorTestSeam.fetch,
          authorizeForTest: connectorTestSeam.authorizeForTest,
        }
      : {}),
  });
  const mcp = await DesktopMcpBridge.start({ vault, appVersion: app.getVersion() });
  mcpBridge = mcp;
  startupDiagnostic('local MCP bridge initialized');
  const agents = await DesktopAgentService.create({
    dataDirectory: app.getPath('userData'),
    resourcesRoot: resourcesRoot(),
    openExternal,
    mcp,
    credentialStore: secureStore,
    preferenceStore: secureStore,
    persistVault: () => vault.persist(),
  });
  startupDiagnostic('agent runtime initialized');
  agentService = agents;
  const commands = new CommandService({ vault, connectors, agents, emitAgentEvent });
  mainWindow = await createWindow(commands, launchHooks);
  startupDiagnostic('first window created');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      void createWindow(commands, launchHooks).then((window) => {
        mainWindow = window;
      });
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    const detail = error instanceof Error ? (error.stack ?? error.message) : message;
    startupDiagnostic(`fatal startup error: ${detail}`);
    // Native error boxes are modal on macOS and invisible to Playwright. Exit
    // directly for the explicitly gated unpackaged E2E seam so a startup
    // regression fails immediately with the captured diagnostic instead of
    // presenting as a one-minute "no first window" timeout.
    if (!app.isPackaged && process.env.NODE_ENV === 'test' && process.env.OUTREACHR_E2E_DATA_DIR) {
      app.exit(1);
      return;
    }
    dialog.showErrorBox('Outreachr could not start', message);
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void (async () => {
    try {
      await vaultService?.persist();
    } catch (error) {
      shutdownStarted = false;
      const message = error instanceof Error ? error.message : 'Unknown local save error';
      dialog.showErrorBox(
        'Outreachr could not save before quitting',
        `${message}\n\nThe application remains open so you can try again.`,
      );
      return;
    }
    await Promise.allSettled([agentService?.dispose(), mcpBridge?.dispose()]);
    app.quit();
  })();
});
