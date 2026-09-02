const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const net = require('net');
const https = require('https');
const si = require('systeminformation');
const ping = require('ping');
const { autoUpdater } = require('electron-updater');

app.setAppUserModelId('com.turekboost.app');

let mainWindow;
let pingLoop = null;
let monitorStopTimer = null;
let tray;
let overlayWindow = null;
let lastNetworkStats = null;
let monitorTemperatureCache = { at: 0, cpu: null, gpu: null };
let activeSession = null;
let activeSpeedtestJob = null;
let updateDownloadReady = false;
let updateCheckInProgress = false;
let updateDownloadInProgress = false;
const sessionFile = () => path.join(app.getPath('userData'), 'sessions.json');
const boostBackupFile = () => path.join(app.getPath('userData'), 'boost-backup.json');
const boostChangesFile = () => path.join(app.getPath('userData'), 'boost-changes.json');
const logFile = () => path.join(app.getPath('userData'), 'turekboost.log');

const GAME_PRESETS = [
  { id: 'cs2', game: 'Counter-Strike 2', artwork: 'counter-strike_2.png', processNames: ['cs2.exe', 'cs2'], regions: [
    { id: 'eu', label: 'Europa', host: '155.133.248.36' },
    { id: 'us-east', label: 'USA Wschód', host: '155.133.255.70' },
  ] },
  { id: 'valorant', game: 'Valorant', artwork: 'valorant.png', processNames: ['valorant.exe', 'valorant-win64-shipping.exe'], regions: [
    { id: 'eu', label: 'Europa', host: 'euw1.api.riotgames.com' },
    { id: 'na', label: 'Ameryka Północna', host: 'na1.api.riotgames.com' },
  ] },
  { id: 'lol', game: 'League of Legends', artwork: 'league_of_legends.png', processNames: ['leagueclient.exe', 'league of legends.exe'], regions: [
    { id: 'euw', label: 'EU West', host: 'euw1.api.riotgames.com' },
    { id: 'eune', label: 'EU Nordic & East', host: 'eun1.api.riotgames.com' },
  ] },
  { id: 'fortnite', game: 'Fortnite', artwork: 'fortnite.png', processNames: ['fortniteclient-win64-shipping.exe'], regions: [
    { id: 'eu', label: 'Europa', host: 'ping-eu.ds.on.epicgames.com' },
    { id: 'na', label: 'Ameryka Północna', host: 'ping-naw.ds.on.epicgames.com' },
  ] },
  { id: 'apex', game: 'Apex Legends', artwork: 'apexlegends.png', processNames: ['r5apex.exe', 'r5apex'], regions: [
    { id: 'eu', label: 'Europa (usługa EA)', host: 'ea.com' },
    { id: 'na', label: 'Ameryka Północna (usługa EA)', host: 'help.ea.com' },
  ] },
  { id: 'call-of-duty', game: 'Call of Duty', artwork: 'callofduty.jpeg', processNames: ['cod.exe', 'cod_hq.exe', 'modernwarfare.exe', 'blackops6.exe'], regions: [
    { id: 'eu', label: 'Europa', host: 'eu.battle.net' },
    { id: 'na', label: 'Ameryka Północna', host: 'us.battle.net' },
  ] },
  { id: 'minecraft', game: 'Minecraft', artwork: 'minecraft.png', processNames: ['javaw.exe', 'minecraft.exe', 'minecraft.windows.exe'], regions: [
    { id: 'eu', label: 'Europa', host: 'sessionserver.mojang.com' },
    { id: 'global', label: 'Usługi Mojang', host: 'api.minecraftservices.com' },
  ] },
  { id: 'rocket-league', game: 'Rocket League', artwork: 'rocketleague.png', processNames: ['rocketleague.exe'], regions: [
    { id: 'eu', label: 'Europa', host: 'rl-cdn.psyonix.com' },
    { id: 'na', label: 'Ameryka Północna', host: 'rl-cdn-na.psyonix.com' },
  ] },
];

function tcpProbe(host, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ alive, time: alive ? Date.now() - started : null });
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(2000, () => finish(false));
  });
}

async function readMonitorTemperatures() {
  const now = Date.now();
  if (now - monitorTemperatureCache.at < 5000) return monitorTemperatureCache;
  let cpu = null;
  let gpu = null;
  try {
    const [temperature, graphics] = await Promise.all([si.cpuTemperature(), si.graphics()]);
    cpu = typeof temperature.main === 'number' ? temperature.main : await readTemperatureFallback();
    gpu = typeof graphics.controllers?.[0]?.temperatureGpu === 'number'
      ? graphics.controllers[0].temperatureGpu
      : await readGpuTemperatureFallback();
  } catch {
    cpu = await readTemperatureFallback();
    gpu = await readGpuTemperatureFallback();
  }
  monitorTemperatureCache = { at: now, cpu, gpu };
  return monitorTemperatureCache;
}

function readGpuTemperatureFallback() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('nvidia-smi.exe', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const temperature = Number(String(stdout).trim().split(/\r?\n/)[0]);
      resolve(Number.isFinite(temperature) ? temperature : null);
    });
  });
}

async function probeWithFallback(host) {
  const icmp = await ping.promise.probe(host, { timeout: 2, extra: process.platform === 'linux' ? ['-c', '1'] : ['-n', '1'] });
  if (icmp.alive) return { alive: true, time: typeof icmp.time === 'number' ? icmp.time : null, protocol: 'ICMP' };
  const tcp = await tcpProbe(host);
  return { ...tcp, protocol: tcp.alive ? 'TCP/443' : 'ICMP/TCP' };
}

function readSessions() {
  try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch { return []; }
}

function writeSessions(sessions) {
  fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
  fs.writeFileSync(sessionFile(), JSON.stringify(sessions.slice(-100), null, 2));
}

function writeLog(level, message) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${level} ${message}\n`);
  } catch (error) {
    console.error('Nie udało się zapisać logu:', error.message);
  }
}

function readBoostChanges() {
  try { return JSON.parse(fs.readFileSync(boostChangesFile(), 'utf8')); } catch { return {}; }
}

function writeBoostChanges(changes) {
  fs.mkdirSync(path.dirname(boostChangesFile()), { recursive: true });
  fs.writeFileSync(boostChangesFile(), JSON.stringify(changes, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    center: true,
    maximizable: false,
    fullscreenable: false,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0a0e14',
    icon: path.join(__dirname, 'renderer', 'assets', 'turekboost-icon.ico'),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }

  });
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  overlayWindow = new BrowserWindow({
    width: 240,
    height: 76,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.webContents.once('did-finish-load', () => {
    if (lastNetworkStats && pingLoop && overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('net:sample', lastNetworkStats);
  });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

ipcMain.handle('overlay:toggle', async () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
    return { visible: false };
  }
  createOverlayWindow();
  return { visible: true };
});

ipcMain.handle('overlay:ping', async () => {
  try {
    const result = await probeWithFallback('1.1.1.1');
    return { alive: result.alive, current: result.alive ? result.time : null, jitter: 0, loss: result.alive ? 0 : 100 };
  } catch {
    return { alive: false, current: null, jitter: 0, loss: 100 };
  }
});

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'assets', 'turekboost-logo.png'));
  tray = new Tray(icon);
  tray.setToolTip('TurekBoost');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Pokaż TurekBoost', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Zakończ', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function sendUpdateStatus(status, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:updateStatus', { status, ...details });
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus('not-available', { version: info.version }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: progress.percent }));
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloadReady = true;
    sendUpdateStatus('downloaded', { version: info.version });
  });
  autoUpdater.on('error', (error) => {
    updateDownloadReady = false;
    writeLog('WARN', `Aktualizacje: ${error.message}`);
    sendUpdateStatus('error', { error: error.message });
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  configureAutoUpdater();
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch((error) => {
      writeLog('WARN', `Automatyczne sprawdzanie aktualizacji: ${error.message}`);
      sendUpdateStatus('error', { error: error.message });
    }), 5000);
  }
});

app.on('window-all-closed', () => {
  if (pingLoop) clearInterval(pingLoop);
  if (process.platform === 'darwin') app.quit();
});

app.on('before-quit', () => { app.isQuitting = true; });

ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:close', () => mainWindow.hide());
ipcMain.handle('app:openDiscord', () => shell.openExternal('https://discord.gg/quSWqau6SW'));
ipcMain.handle('app:restartAsAdmin', async () => {
  if (process.platform !== 'win32') return { ok: false, error: 'Ta funkcja jest dostępna tylko na Windows.' };
  const executable = process.execPath.replace(/'/g, "''");
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${executable}' -Verb RunAs`], (error) => {
      if (error) return resolve({ ok: false, error: error.message });
      app.isQuitting = true;
      app.quit();
      resolve({ ok: true });
    });
  });
});

ipcMain.handle('app:getAutostart', async () => ({ enabled: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle('app:setAutostart', async (event, enabled) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Autostart jest dostępny na Windows.' };
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
  return { ok: true, enabled: app.getLoginItemSettings().openAtLogin };
});
ipcMain.handle('app:getInfo', async () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));
ipcMain.handle('app:checkForUpdates', async () => {
  if (!app.isPackaged) return { ok: false, status: 'dev', message: 'Aktualizacje są dostępne po zainstalowaniu aplikacji.' };
  if (updateCheckInProgress) return { ok: false, status: 'busy', message: 'Sprawdzanie aktualizacji już trwa.' };
  updateCheckInProgress = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, status: result?.updateInfo?.version && result.updateInfo.version !== app.getVersion() ? 'available' : 'not-available', version: result?.updateInfo?.version || null };
  } catch (error) {
    writeLog('WARN', `Sprawdzanie aktualizacji: ${error.message}`);
    return { ok: false, status: 'error', message: 'Nie udało się sprawdzić aktualizacji.' };
  } finally {
    updateCheckInProgress = false;
  }
});
ipcMain.handle('app:downloadUpdate', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Aktualizacje są dostępne po zainstalowaniu aplikacji.' };
  if (updateDownloadInProgress) return { ok: false, error: 'Pobieranie aktualizacji już trwa.' };
  updateDownloadInProgress = true;
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    writeLog('WARN', `Pobieranie aktualizacji: ${error.message}`);
    return { ok: false, error: 'Nie udało się pobrać aktualizacji.' };
  } finally {
    updateDownloadInProgress = false;
  }
});
ipcMain.handle('app:installUpdate', () => {
  if (!updateDownloadReady) return { ok: false, error: 'Aktualizacja nie jest jeszcze gotowa.' };
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
  return { ok: true };
});
ipcMain.handle('app:exportLogs', async () => {
  if (!fs.existsSync(logFile())) writeLog('INFO', 'Utworzono pusty log diagnostyczny.');
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `turekboost-log-${Date.now()}.txt`,
    filters: [{ name: 'Logi tekstowe', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  fs.copyFileSync(logFile(), result.filePath);
  return { ok: true, path: result.filePath };
});

// ---------- NETWORK ANALYZER ----------

const PRESET_TARGETS = [
  { id: 'cloudflare', label: 'Cloudflare DNS', host: '1.1.1.1' },
  { id: 'google', label: 'Google DNS', host: '8.8.8.8' },
  { id: 'frankfurt', label: 'EU (Frankfurt) - Hetzner', host: 'hel1-speed.hetzner.com' },
  { id: 'warsaw_isp', label: 'Router / brama domyślna', host: 'gateway' },
];

ipcMain.handle('net:getPresets', async () => PRESET_TARGETS);
ipcMain.handle('games:getPresets', async () => GAME_PRESETS);
ipcMain.handle('history:getSessions', async () => readSessions());
ipcMain.handle('history:deleteSession', async (event, sessionId) => {
  const sessions = readSessions();
  const remaining = sessions.filter((session) => String(session.id) !== String(sessionId));
  writeSessions(remaining);
  return { ok: remaining.length !== sessions.length };
});
ipcMain.handle('history:clear', async () => {
  writeSessions([]);
  return { ok: true };
});
ipcMain.handle('history:export', async (event, { format, data }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `turekboost-${Date.now()}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  const comparisonText = data.comparison
    ? `\n\nPORÓWNANIE PRZED / PO OPTYMALIZACJI\nPrzed: ${data.comparison.before.avg} ms · ${data.comparison.before.loss}% loss · ${data.comparison.before.quality}\nPo: ${data.comparison.after.avg} ms · ${data.comparison.after.loss}% loss · ${data.comparison.after.quality}\nZmiana: ${data.comparison.deltaAvg} ms ping · ${data.comparison.deltaLoss} pp loss`
    : '';
  const content = format === 'csv'
    ? ['timestamp,host,time,alive', ...data.samples.map((s) => `${new Date(s.t).toISOString()},${data.host},${s.time ?? ''},${s.alive}`)].join('\n')
    : format === 'txt'
    ? `TUREKBOOST - RAPORT JAKOŚCI POŁĄCZENIA\nData: ${new Date().toLocaleString('pl-PL')}\nCel: ${data.host}\n\nŚredni ping: ${data.avg ?? 'brak'} ms\nMin / Max: ${data.min ?? 'brak'} / ${data.max ?? 'brak'} ms\nJitter: ${data.jitter ?? 'brak'} ms\nUtrata pakietów: ${data.loss ?? 'brak'}%\nOcena: ${data.quality ?? 'brak'}${comparisonText}\n\nPRÓBKI\n${data.samples.map((s) => `${new Date(s.t).toISOString()} | ${s.time ?? 'timeout'} ms | ${s.alive ? 'OK' : 'LOSS'}`).join('\n')}`
    : JSON.stringify(data, null, 2);
  fs.writeFileSync(result.filePath, content);
  return { ok: true, path: result.filePath };
});

ipcMain.handle('sys:getGameProcesses', async () => {
  const processes = await si.processes();
  const names = processes.list.map((p) => p.name.toLowerCase());
  return GAME_PRESETS.filter((game) => game.processNames.some((name) => names.includes(name))).map((game) => game.id);
});

ipcMain.handle('sys:getConnection', async () => readConnectionInfo());

ipcMain.handle('diag:traceroute', async (event, host) => {
  const command = process.platform === 'win32' ? 'tracert' : 'traceroute';
  return new Promise((resolve) => execFile(command, process.platform === 'win32' ? ['-d', '-h', '12', host] : ['-m', '12', host], { timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, output: (stdout || stderr || '').trim() })));
});

ipcMain.handle('diag:traceDetailed', async (event, host) => {
  return runFullTraceDetailed(host);
});

ipcMain.handle('diag:speedtest', async (event) => runFullSpeedtest((percent, label) => {
  if (event.sender && !event.sender.isDestroyed()) event.sender.send('diag:speedtestProgress', { percent, label });
}));
ipcMain.handle('diag:speedtestCancel', async () => {
  if (!activeSpeedtestJob) return { ok: false, error: 'Brak aktywnego testu.' };
  activeSpeedtestJob.cancelled = true;
  activeSpeedtestJob.requests.forEach((request) => request.destroy());
  return { ok: true };
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateFullTestPing(samples) {
  const values = samples.filter((sample) => sample.alive && typeof sample.time === 'number').map((sample) => sample.time);
  const jitterValues = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  return {
    samples,
    avg: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    jitter: jitterValues.length ? Math.round((jitterValues.reduce((sum, value) => sum + value, 0) / jitterValues.length) * 10) / 10 : 0,
    loss: samples.length ? Math.round(((samples.length - values.length) / samples.length) * 100) : 100,
  };
}

function measureSpeedtestRequest(job, kind, sendProgress) {
  const isUpload = kind === 'upload';
  const body = isUpload ? Buffer.alloc(2 * 1024 * 1024, 0x61) : null;
  const options = isUpload
    ? {
      hostname: 'speed.cloudflare.com',
      path: '/__up',
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
    }
    : { hostname: 'speed.cloudflare.com', path: '/__down?bytes=5000000', method: 'GET' };

  return new Promise((resolve) => {
    const started = Date.now();
    let received = 0;
    let settled = false;
    const request = https.request(options, (response) => {
      const successful = response.statusCode >= 200 && response.statusCode < 300;
      response.on('data', (chunk) => { if (!isUpload) received += chunk.length; });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        job.requests.delete(request);
        if (job.cancelled) return resolve({ ok: false, cancelled: true, error: 'Test anulowany.' });
        if (!successful) return resolve({ ok: false, error: `Endpoint zwrócił HTTP ${response.statusCode}.` });
        const bytes = isUpload ? body.length : received;
        const seconds = Math.max((Date.now() - started) / 1000, 0.001);
        resolve({ ok: bytes > 0, mbps: Math.round((bytes * 8 / seconds / 1000000) * 10) / 10 });
      });
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        job.requests.delete(request);
        resolve({ ok: false, cancelled: job.cancelled, error: job.cancelled ? 'Test anulowany.' : error.message });
      });
      response.on('aborted', () => {
        if (settled) return;
        settled = true;
        job.requests.delete(request);
        resolve({ ok: false, cancelled: job.cancelled, error: job.cancelled ? 'Test anulowany.' : 'Połączenie z endpointem zostało przerwane.' });
      });
      response.resume();
    });
    job.requests.add(request);
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      job.requests.delete(request);
      resolve({ ok: false, cancelled: job.cancelled, error: job.cancelled ? 'Test anulowany.' : error.message });
    });
    request.setTimeout(15000, () => {
      if (settled) return;
      request.destroy();
      settled = true;
      job.requests.delete(request);
      resolve({ ok: false, error: 'Przekroczono limit czasu.' });
    });
    if (isUpload) request.end(body);
    else request.end();
    if (sendProgress) sendProgress(isUpload ? 58 : 8, isUpload ? 'Mierzę wysyłanie danych…' : 'Mierzę pobieranie danych…');
  });
}

async function runFullSpeedtest(sendProgress) {
  const job = { cancelled: false, requests: new Set() };
  activeSpeedtestJob = job;
  try {
    const download = await measureSpeedtestRequest(job, 'download', sendProgress);
    if (job.cancelled) return { ok: false, cancelled: true, error: 'Test anulowany.', download, upload: { ok: false, error: 'Test anulowany.' } };
    const upload = await measureSpeedtestRequest(job, 'upload', sendProgress);
    if (job.cancelled) return { ok: false, cancelled: true, error: 'Test anulowany.', download, upload };
    const result = {
      ok: Boolean(download.ok),
      mbps: download.ok ? download.mbps : null,
      download,
      upload,
    };
    if (!download.ok && !upload.ok) result.error = 'Nie udało się zmierzyć pobierania ani wysyłania.';
    if (sendProgress) sendProgress(100, 'Pomiar zakończony.');
    return result;
  } finally {
    if (activeSpeedtestJob === job) activeSpeedtestJob = null;
  }
}

function runFullTraceDetailed(host) {
  const command = process.platform === 'win32' ? 'tracert' : 'traceroute';
  const args = process.platform === 'win32' ? ['-d', '-w', '1000', '-h', '12', host] : ['-n', '-w', '1', '-m', '12', host];
  return new Promise((resolve) => execFile(command, args, { timeout: 30000 }, async (err, stdout, stderr) => {
    const output = (stdout || stderr || '').trim();
    const hops = output.split(/\r?\n/).map((line) => {
      const hopMatch = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!hopMatch) return null;
      const times = [...hopMatch[2].matchAll(/(\d+(?:\.\d+)?)\s*ms/g)].map((match) => Number(match[1]));
      const ipMatch = hopMatch[2].match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      if (!times.length && !ipMatch) return null;
      return { hop: Number(hopMatch[1]), address: ipMatch ? ipMatch[0] : '*', traceMs: times.length ? Math.min(...times) : null };
    }).filter(Boolean);
    for (const hop of hops) {
      if (hop.address === '*') { hop.pingMs = null; hop.loss = 100; continue; }
      try {
        const result = await ping.promise.probe(hop.address, { timeout: 1, extra: process.platform === 'linux' ? ['-c', '1'] : ['-n', '1'] });
        hop.pingMs = result.alive && typeof result.time === 'number' ? result.time : null;
        hop.loss = result.alive ? 0 : 100;
      } catch { hop.pingMs = null; hop.loss = 100; }
    }
    const problem = hops.find((hop) => hop.loss >= 50 || (hop.pingMs !== null && hop.pingMs >= 100));
    resolve({ ok: !err || hops.length > 0, output, hops, diagnosis: problem ? `Pierwszy podejrzany hop: ${problem.hop} (${problem.address}).` : 'Nie wykryto wyraźnego problemu na trasie.' });
  }));
}

async function readConnectionInfo() {
  const interfaces = await si.networkInterfaces();
  const active = interfaces.find((item) => !item.internal && item.operstate === 'up');
  return active
    ? {
      type: /wi-?fi|wireless|802\.11/i.test(active.type + active.iface) ? 'Wi-Fi' : 'Ethernet',
      name: active.iface,
      address: active.ip4 || active.ip6 || null,
      speed: active.speed || null,
      signal: active.signalLevel || null,
    }
    : null;
}

function buildFullTestRecommendation(pingStats, speedResult, traceResult, connection) {
  const firstProblem = traceResult.hops.find((hop) => hop.loss >= 50 || (hop.pingMs !== null && hop.pingMs >= 100));
  if (connection?.type === 'Wi-Fi' && (pingStats.loss >= 20 || pingStats.jitter >= 25)) {
    return { category: 'wifi', title: 'Najbardziej prawdopodobny problem z Wi-Fi', detail: 'Sprawdź siłę sygnału, odległość od routera i spróbuj połączenia przewodowego.' };
  }
  if (firstProblem?.hop <= 2) {
    return { category: 'router', title: 'Możliwy problem z routerem lub bramą', detail: 'Pierwszy problem pojawia się blisko Twojej sieci. Zrestartuj router i sprawdź okablowanie.' };
  }
  if (pingStats.loss >= 20 || pingStats.avg === null) {
    return { category: 'server', title: 'Cel testu lub serwer nie odpowiada stabilnie', detail: 'Porównaj wynik z innym celem; jeśli tylko ten cel ma straty, problem jest po stronie serwera.' };
  }
  if (firstProblem || (speedResult.ok && speedResult.mbps < 10)) {
    return { category: 'operator', title: 'Możliwy problem po stronie operatora lub trasy', detail: 'Skontaktuj się z operatorem, przekazując ten raport i wynik traceroute.' };
  }
  if (pingStats.avg >= 150) {
    return { category: 'server', title: 'Wysokie opóźnienie do badanego serwera', detail: 'Sprawdź inny region lub serwer; lokalne łącze odpowiada, ale cel jest odległy albo przeciążony.' };
  }
  return { category: 'good', title: 'Połączenie wygląda stabilnie', detail: 'Nie wykryto istotnego problemu z Wi-Fi, routerem, operatorem ani trasą.' };
}

ipcMain.handle('diag:fullTest', async (event, requestedHost) => {
  if (pingLoop) finishMonitor(false);
  const hostInput = typeof requestedHost === 'string' && requestedHost.trim() ? requestedHost.trim().slice(0, 255) : '1.1.1.1';
  const host = hostInput === 'gateway' ? await getDefaultGateway() : hostInput;
  const startedAt = Date.now();
  const sendProgress = (percent, label) => {
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('diag:fullTestProgress', { percent, label });
  };

  try {
    sendProgress(5, 'Sprawdzam ping i stabilność odpowiedzi…');
    const samples = [];
    for (let index = 0; index < 6; index++) {
      let result = { alive: false, time: null };
      try { result = await probeWithFallback(host); } catch { /* zachowaj próbkę jako timeout */ }
      samples.push({ t: Date.now(), time: result.alive && typeof result.time === 'number' ? result.time : null, alive: Boolean(result.alive) });
      sendProgress(10 + Math.round(((index + 1) / 6) * 40), `Ping: próbka ${index + 1}/6`);
      if (index < 5) await wait(500);
    }
    const pingStats = calculateFullTestPing(samples);
    sendProgress(58, 'Wykonuję test prędkości i traceroute…');
    const [speedtest, traceroute, connection] = await Promise.all([
      runFullSpeedtest(),
      runFullTraceDetailed(host),
      readConnectionInfo(),
    ]);
    const recommendation = buildFullTestRecommendation(pingStats, speedtest, traceroute, connection);
    const session = { id: startedAt.toString(), startedAt, endedAt: Date.now(), host, samples };
    writeSessions([...readSessions(), session]);
    sendProgress(100, 'Raport gotowy.');
    return { ok: true, host, ping: pingStats, speedtest, traceroute, connection, recommendation, durationMs: Date.now() - startedAt };
  } catch (error) {
    sendProgress(100, 'Test zakończony błędem.');
    return { ok: false, error: error.message || 'Nie udało się wykonać pełnego testu.' };
  }
});

ipcMain.handle('games:benchmarkRegions', async (event, gameId) => {
  const game = GAME_PRESETS.find((item) => item.id === gameId);
  if (!game) return { ok: false, error: 'Nie znaleziono gry.' };
  const results = [];
  for (const region of game.regions) {
    const times = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await probeWithFallback(region.host);
        if (result.alive && typeof result.time === 'number') times.push(result.time);
      } catch { /* continue with the next attempt */ }
    }
    results.push({ label: region.label, host: region.host, avg: times.length ? times.reduce((sum, time) => sum + time, 0) / times.length : null, loss: Math.round(((3 - times.length) / 3) * 100) });
  }
  results.sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity));
  return { ok: true, results };
});

ipcMain.handle('net:startMonitor', async (event, { host, gameId = null }) => {
  if (pingLoop) clearInterval(pingLoop);
  if (monitorStopTimer) clearTimeout(monitorStopTimer);

  let resolvedHost = host;
  if (host === 'gateway') {
    resolvedHost = await getDefaultGateway();
  }

  const samples = [];
  const sessionSamples = [];
  const startedAt = Date.now();
  const game = gameId ? GAME_PRESETS.find((item) => item.id === gameId) : null;
  activeSession = { id: startedAt.toString(), startedAt, host: resolvedHost, gameId: game?.id || null, gameName: game?.game || null, samples: sessionSamples };
  const MAX_SAMPLES = 60;

  const tick = async () => {
    try {
      const res = await probeWithFallback(resolvedHost);
      const alive = res.alive;
      const time = alive && typeof res.time === 'number' ? res.time : null;

      samples.push({ t: Date.now(), time, alive });
      if (samples.length > MAX_SAMPLES) samples.shift();
      sessionSamples.push({ t: Date.now(), time, alive });

      const successful = samples.filter((s) => s.alive && s.time !== null);
      const times = successful.map((s) => s.time);
      const loss = samples.length
        ? Math.round(((samples.length - successful.length) / samples.length) * 100)
        : 0;

      let jitter = 0;
      if (times.length > 1) {
        let diffs = [];
        for (let i = 1; i < times.length; i++) diffs.push(Math.abs(times[i] - times[i - 1]));
        jitter = Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10;
      }

      const stats = {
        current: time,
        alive,
        min: times.length ? Math.min(...times) : null,
        max: times.length ? Math.max(...times) : null,
        avg: times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null,
        jitter,
        loss,
        history: samples.map((s) => s.time),
        host: resolvedHost,
      };
      const temperatures = await readMonitorTemperatures();
      stats.cpuTemperature = temperatures.cpu;
      stats.gpuTemperature = temperatures.gpu;
      lastNetworkStats = stats;

      const alertReasons = [];
      if (loss >= 20) alertReasons.push(`utrata ${loss}%`);
      if (time !== null && time >= 150) alertReasons.push(`ping ${time} ms`);
      if (temperatures.cpu !== null && temperatures.cpu >= 85) alertReasons.push(`CPU ${temperatures.cpu}°C`);
      if (temperatures.gpu !== null && temperatures.gpu >= 85) alertReasons.push(`GPU ${temperatures.gpu}°C`);
      if (activeSession && alertReasons.length && new Date().getTime() - (activeSession.lastAlert || 0) > 30000) {
        activeSession.lastAlert = Date.now();
        const reason = alertReasons.join(' · ');
        if (Notification.isSupported()) new Notification({ title: 'TurekBoost: alert monitoringu', body: reason }).show();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('net:alert', { loss, time, cpuTemperature: temperatures.cpu, gpuTemperature: temperatures.gpu, reason });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('net:sample', stats);
        mainWindow.webContents.send('net:progress', { percent: Math.min(100, Math.round(((Date.now() - startedAt) / 12000) * 100)) });
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('net:sample', stats);
    } catch (e) {
      // pojedynczy błąd nie przerywa pętli
    }
  };

  tick();
  pingLoop = setInterval(tick, 1000);
  monitorStopTimer = setTimeout(() => finishMonitor(true), 12000);
  return { ok: true, host: resolvedHost };
});

ipcMain.handle('net:stopMonitor', async () => {
  finishMonitor(false);
  return { ok: true };
});

function finishMonitor(completed) {
  if (pingLoop) clearInterval(pingLoop);
  pingLoop = null;
  if (monitorStopTimer) clearTimeout(monitorStopTimer);
  monitorStopTimer = null;
  if (activeSession && activeSession.samples.length) {
    const saved = { ...activeSession, samples: [...activeSession.samples], endedAt: Date.now() };
    delete saved.lastAlert;
    writeSessions([...readSessions(), saved]);
    activeSession = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('net:reset');
  lastNetworkStats = null;
  if (completed && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('net:progress', { percent: 100 });
    mainWindow.webContents.send('net:complete');
  }
}

function getDefaultGateway() {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? 'ipconfig'
        : process.platform === 'darwin'
        ? 'route -n get default'
        : 'ip route';
    exec(cmd, (err, stdout) => {
      if (err) return resolve('1.1.1.1');
      if (process.platform === 'win32') {
        const match = stdout.match(/Default Gateway.*?:\s*([\d.]+)/);
        return resolve(match ? match[1] : '1.1.1.1');
      }
      if (process.platform === 'darwin') {
        const match = stdout.match(/gateway:\s*([\d.]+)/);
        return resolve(match ? match[1] : '1.1.1.1');
      }
      const match = stdout.match(/default via ([\d.]+)/);
      resolve(match ? match[1] : '1.1.1.1');
    });
  });
}

// ---------- PC BOOST ----------

ipcMain.handle('sys:getSnapshot', async () => {
  const [cpu, mem, currentLoad, processes, temperature, graphics] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.currentLoad(),
    si.processes(),
    si.cpuTemperature(),
    si.graphics(),
  ]);
  const detectedCpuTemperature = typeof temperature.main === 'number' ? temperature.main : await readTemperatureFallback();
  const detectedGpuTemperature = typeof graphics.controllers?.[0]?.temperatureGpu === 'number'
    ? graphics.controllers[0].temperatureGpu
    : await readGpuTemperatureFallback();

  const topProcesses = processes.list
    .slice()
    .sort((a, b) => b.memRss - a.memRss)
    .slice(0, 12)
    .map((p) => ({
      pid: p.pid,
      name: p.name,
      memMB: Math.round((p.memRss || 0) / 1024),
      cpu: Math.round((p.cpu || 0) * 10) / 10,
    }));

  return {
    cpuModel: `${cpu.manufacturer} ${cpu.brand}`,
    cpuLoad: Math.round(currentLoad.currentLoad * 10) / 10,
    memTotalGB: Math.round((mem.total / 1024 / 1024 / 1024) * 10) / 10,
    memUsedGB: Math.round(((mem.total - mem.available) / 1024 / 1024 / 1024) * 10) / 10,
    memUsedPct: Math.round(((mem.total - mem.available) / mem.total) * 100),
    cpuTemperature: detectedCpuTemperature,
    gpuTemperature: detectedGpuTemperature,
    topProcesses,
  };
});

ipcMain.handle('boost:killProcess', async (event, pid) => {
  if (!/^\d+$/.test(String(pid)) || Number(pid) <= 0 || Number(pid) === process.pid) {
    return { ok: false, error: 'Nieprawidłowy lub chroniony PID.' };
  }
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
    exec(cmd, (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? stderr || err.message : null });
    });
  });
});

ipcMain.handle('boost:cleanMemory', async (event, exclusions = []) => {
  if (process.platform !== 'win32') return { ok: false, error: 'RAM Cleaner jest dostępny tylko na Windows.' };
  const before = await si.mem();
  const safeExclusions = Array.isArray(exclusions)
    ? exclusions.map((name) => String(name).replace(/\.exe$/i, '').trim()).filter((name) => /^[a-zA-Z0-9_. -]+$/.test(name)).slice(0, 20)
    : [];
  const exclusionExpression = safeExclusions.length ? ` -and $_.ProcessName -notin @(${safeExclusions.map((name) => `'${name.replace(/'/g, "''")}'`).join(',')})` : '';
  const command = `powershell -NoProfile -Command "$signature = '[DllImport(\"psapi.dll\")] public static extern bool EmptyWorkingSet(IntPtr hProcess);'; Add-Type -MemberDefinition $signature -Name Win32 -Namespace TurekBoost; $self = ${process.pid}; Get-Process | Where-Object { $_.Id -ne $self -and $_.Id -ne 0 -and $_.Handles -and $_.WorkingSet64 -gt 52428800 -and $_.ProcessName -notmatch '^(System|Idle|Registry|smss|csrss|wininit|services|lsass|svchost|dwm|electron)$'${exclusionExpression} } | ForEach-Object { try { [TurekBoost.Win32]::EmptyWorkingSet($_.Handle) } catch {} }"`;
  const result = await runCmd(command);
  if (!result.ok) return { ok: false, error: result.output || 'Nie udało się wyczyścić pamięci.' };
  const after = await si.mem();
  return { ok: true, freedMB: Math.max(0, Math.round((after.available - before.available) / 1024 / 1024)) };
});

ipcMain.handle('boost:setHighPriority', async (event, pid) => {
  if (!/^\d+$/.test(String(pid))) return { ok: false, error: 'Nieprawidłowy PID.' };
  if (process.platform !== 'win32') return { ok: false, error: 'Dostępne tylko na Windows.' };
  return runCmd(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).PriorityClass = 'High'"`);
});

ipcMain.handle('boost:gameMode', async (event, gameId) => {
  const game = GAME_PRESETS.find((item) => item.id === gameId);
  if (!game) return { ok: false, error: 'Nie znaleziono gry.' };
  const processes = await si.processes();
  const process = processes.list.find((item) => game.processNames.includes(item.name.toLowerCase()));
  if (!process) return { ok: false, error: 'Uruchom grę, aby włączyć Game Mode.' };
  if (!/^\d+$/.test(String(process.pid))) return { ok: false, error: 'Nieprawidłowy PID procesu gry.' };
  return runCmd(`powershell -NoProfile -Command "(Get-Process -Id ${process.pid}).PriorityClass = 'High'"`).then((result) => ({ ...result, pid: process.pid }));
});

ipcMain.handle('boost:highPerfPowerPlan', async () => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Dostępne tylko na Windows.' };
  }
  const backup = await captureBoostBackup();
  if (!backup.ok) return backup;
  return new Promise((resolve) => {
    // GUID SCHEME_MIN = Wysoka wydajność
    exec('powercfg /s SCHEME_MIN', (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? stderr || err.message : null });
    });
  });
});

ipcMain.handle('boost:flushDns', async () => {
  const cmd =
    process.platform === 'win32'
      ? 'ipconfig /flushdns'
      : process.platform === 'darwin'
      ? 'sudo killall -HUP mDNSResponder'
      : 'systemd-resolve --flush-caches';
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? stderr || err.message : null });
    });
  });
});

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      const output = (stderr || stdout || err?.message || '').trim();
      writeLog(err ? 'ERROR' : 'INFO', `${cmd} :: ${output}`);
      resolve({ ok: !err, output });
    });
  });
}

function readTemperatureFallback() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Measure-Object -Property CurrentTemperature -Average).Average'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const kelvinTenths = Number(String(stdout).trim());
      resolve(Number.isFinite(kelvinTenths) && kelvinTenths > 0 ? Math.round((kelvinTenths / 10 - 273.15) * 10) / 10 : null);
    });
  });
}

ipcMain.handle('boost:tcpOptimize', async () => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Dostępne tylko na Windows.' };
  }

  const commands = [
    'netsh interface tcp set global autotuninglevel=normal',
    'netsh interface tcp set supplemental template=internet congestionprovider=ctcp',
    'netsh interface tcp set heuristics enabled=disabled',
  ];

  const results = [];
  for (const cmd of commands) {
    const res = await runCmd(cmd);
    results.push({ cmd, ...res });
    if (!res.ok) {
      const isAdminIssue = /requires elevation|access is denied|odmowa dostępu|wymaga podniesienia/i.test(res.output);
      return {
        ok: false,
        error: isAdminIssue
          ? `Brak uprawnień administratora. Zamknij TurekBoost i uruchom go ponownie jako administrator (prawy przycisk na plik → "Uruchom jako administrator"). Szczegóły: ${cmd} → ${res.output}`
          : `Polecenie "${cmd}" nie powiodło się: ${res.output}`,
      };
    }
  }

  return { ok: true };
});

const BOOST_OPTIONS = {
  highPerf: {
    on: 'powercfg /s SCHEME_MIN',
    off: 'powercfg /s SCHEME_BALANCED',
  },
  tcp: {
    on: 'netsh interface tcp set global autotuninglevel=normal && netsh interface tcp set supplemental template=internet congestionprovider=ctcp && netsh interface tcp set heuristics enabled=disabled',
    off: 'netsh interface tcp set global autotuninglevel=normal && netsh interface tcp set heuristics enabled=enabled',
  },
  inputLag: {
    on: 'reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 0 /f && reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d 0 /f && reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d 0 /f',
    off: 'reg add "HKCU\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 1 /f && reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d 6 /f && reg add "HKCU\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d 10 /f',
  },
  keyboard: {
    on: 'reg add "HKCU\\Control Panel\\Keyboard" /v KeyboardDelay /t REG_SZ /d 0 /f && reg add "HKCU\\Control Panel\\Keyboard" /v KeyboardSpeed /t REG_SZ /d 31 /f',
    off: 'reg add "HKCU\\Control Panel\\Keyboard" /v KeyboardDelay /t REG_SZ /d 1 /f && reg add "HKCU\\Control Panel\\Keyboard" /v KeyboardSpeed /t REG_SZ /d 31 /f',
  },
  gameBar: {
    on: 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR" /v AppCaptureEnabled /t REG_DWORD /d 0 /f && reg add "HKCU\\System\\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 0 /f',
    off: 'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR" /v AppCaptureEnabled /t REG_DWORD /d 1 /f && reg add "HKCU\\System\\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 1 /f',
  },
  lastAccess: {
    on: 'fsutil behavior set disablelastaccess 1',
    off: 'fsutil behavior set disablelastaccess 0',
  },
  superfetch: {
    on: 'powershell -NoProfile -Command "Stop-Service SysMain -Force; Set-Service SysMain -StartupType Disabled"',
    off: 'powershell -NoProfile -Command "Set-Service SysMain -StartupType Manual; Start-Service SysMain"',
  },
  indexing: {
    on: 'powershell -NoProfile -Command "Stop-Service WSearch -Force; Set-Service WSearch -StartupType Disabled"',
    off: 'powershell -NoProfile -Command "Set-Service WSearch -StartupType Automatic; Start-Service WSearch"',
  },
  networkSaving: {
    on: 'powercfg -setacvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 0 && powercfg -setactive SCHEME_CURRENT',
    off: 'powercfg -setacvalueindex SCHEME_CURRENT SUB_PCIEXPRESS ASPM 1 && powercfg -setactive SCHEME_CURRENT',
  },
  activeCores: {
    on: 'powercfg -setacvalueindex SCHEME_CURRENT SUB_PROCESSOR CPMINCORES 100 && powercfg -setactive SCHEME_CURRENT',
    off: 'powercfg -setacvalueindex SCHEME_CURRENT SUB_PROCESSOR CPMINCORES 10 && powercfg -setactive SCHEME_CURRENT',
  },
  backgroundPriority: {
    on: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl" /v Win32PrioritySeparation /t REG_DWORD /d 26 /f',
    off: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl" /v Win32PrioritySeparation /t REG_DWORD /d 2 /f',
  },
  ultimatePerf: {
    on: 'powershell -NoProfile -Command "$output = powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61; $guid = [regex]::Match(($output -join \' \'), \'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\').Value; if ($guid) { powercfg /s $guid } else { exit 1 }"',
    off: 'powercfg /s SCHEME_BALANCED',
  },
};

ipcMain.handle('boost:applyOption', async (event, { option, enabled }) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Opcje są dostępne tylko na Windows.' };
  const definition = BOOST_OPTIONS[option];
  if (!definition) return { ok: false, error: 'Nieznana opcja optymalizacji.' };
  const backup = await captureBoostBackup();
  if (!backup.ok) return { ok: false, error: `Nie wykonano zmiany bez kopii ustawień: ${backup.error}` };
  const result = await runCmd(definition[enabled ? 'on' : 'off']);
  if (!result.ok) {
    const admin = /access is denied|odmowa dostępu|requires elevation|wymaga podniesienia/i.test(result.output);
    return { ok: false, error: admin ? 'Ta opcja wymaga uruchomienia aplikacji jako administrator.' : result.output || 'Nie udało się zastosować ustawienia.' };
  }
  const changes = readBoostChanges();
  changes[option] = { previousEnabled: !enabled, changedAt: Date.now() };
  writeBoostChanges(changes);
  return { ok: true, undoAvailable: true };
});

async function captureBoostBackup() {
  if (process.platform !== 'win32') return { ok: false, error: 'Backup jest dostępny tylko na Windows.' };
  const backupDir = path.join(app.getPath('userData'), 'boost-registry-backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const scheme = await runCmd('powercfg /getactivescheme');
  const match = scheme.output.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  const registryKeys = {
    mouse: 'HKCU\\Control Panel\\Mouse',
    keyboard: 'HKCU\\Control Panel\\Keyboard',
    gameDvr: 'HKCU\\System\\GameConfigStore',
    gameCapture: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR',
    priority: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl',
  };
  const files = [];
  for (const [name, key] of Object.entries(registryKeys)) {
    const file = path.join(backupDir, `${name}.reg`);
    const result = await runCmd(`reg export "${key}" "${file}" /y`);
    if (result.ok) files.push(file);
  }
  if (!match) return { ok: false, error: 'Nie udało się odczytać aktywnego planu zasilania.' };
  fs.writeFileSync(boostBackupFile(), JSON.stringify({ powerScheme: match[0], files, createdAt: Date.now() }, null, 2));
  return { ok: true, createdAt: Date.now() };
}

ipcMain.handle('boost:backupSettings', async () => captureBoostBackup());
ipcMain.handle('boost:getChanges', async () => readBoostChanges());

ipcMain.handle('boost:undoOption', async (event, option) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Cofanie jest dostępne tylko na Windows.' };
  const definition = BOOST_OPTIONS[option];
  const changes = readBoostChanges();
  const change = changes[option];
  if (!definition || !change) return { ok: false, error: 'Brak zapisanej zmiany do cofnięcia.' };
  const backup = await captureBoostBackup();
  if (!backup.ok) return { ok: false, error: `Nie wykonano cofnięcia bez kopii ustawień: ${backup.error}` };
  const result = await runCmd(definition[change.previousEnabled ? 'on' : 'off']);
  if (!result.ok) return { ok: false, error: result.output || 'Nie udało się cofnąć zmiany.' };
  delete changes[option];
  writeBoostChanges(changes);
  return { ok: true };
});

ipcMain.handle('boost:restoreSettings', async () => {
  if (process.platform !== 'win32') return { ok: false, error: 'Przywracanie jest dostępne tylko na Windows.' };
  let backup;
  try { backup = JSON.parse(fs.readFileSync(boostBackupFile(), 'utf8')); } catch { return { ok: false, error: 'Nie znaleziono kopii ustawień.' }; }
  const powerResult = await runCmd(`powercfg /s ${backup.powerScheme}`);
  const results = await Promise.all((backup.files || []).map((file) => runCmd(`reg import "${file}"`)));
  const failed = [powerResult, ...results].find((result) => !result.ok);
  if (failed) {
    const output = failed.output || '';
    return { ok: false, error: /access is denied|error accessing the registry|odmowa dostępu|requires elevation|wymaga podniesienia/i.test(output) ? 'Przywracanie wymaga uruchomienia jako administrator.' : output || 'Nie udało się przywrócić ustawień.' };
  }
  writeBoostChanges({});
  return { ok: true };
});
