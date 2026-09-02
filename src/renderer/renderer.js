// ---------- Nawigacja ----------
const navItems = document.querySelectorAll('.nav-item[data-view]');
let analyzerInitialized = false;

function showView(viewName) {
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');
}

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    showView(item.dataset.view);
    if (item.dataset.view === 'analyzer') initializeAnalyzer();
    if (item.dataset.view === 'boost') refreshSnapshot();
    if (item.dataset.view === 'history') loadHistory();
  });
  document.getElementById('saveBaselineBtn').addEventListener('click', () => {
    if (!captureOptimizationBaseline()) return showFeedback('Najpierw uruchom pomiar, aby zapisać wynik PRZED.');
    showFeedback('Zapisano wynik PRZED optymalizacją. Uruchom test ponownie po zmianach.');
  });
});

showView('home');

const savedAlertSetting = localStorage.getItem('turekboost-alerts');
if (savedAlertSetting !== null) document.getElementById('alertToggle').checked = savedAlertSetting === 'true';
document.getElementById('alertToggle').addEventListener('change', (event) => localStorage.setItem('turekboost-alerts', String(event.target.checked)));
const savedTheme = localStorage.getItem('turekboost-theme');
if (savedTheme === 'light') document.body.classList.add('light-theme');

document.querySelectorAll('.home-card').forEach((card) => {
  card.addEventListener('click', () => {
    if (card.dataset.openView) document.querySelector(`[data-view="${card.dataset.openView}"]`).click();
  });
});
document.getElementById('joinDiscord').addEventListener('click', () => window.api.openDiscord());
document.getElementById('windowMinimize').addEventListener('click', () => window.api.windowMinimize());
document.getElementById('windowClose').addEventListener('click', () => window.api.windowClose());

async function refreshSystemStatus() {
  const [info, snapshot] = await Promise.all([window.api.getAppInfo(), window.api.getSnapshot()]);
  document.getElementById('appVersion').textContent = `WERSJA ${info.version}`;
  const hot = (snapshot.cpuTemperature !== null && snapshot.cpuTemperature >= 85) || (snapshot.gpuTemperature !== null && snapshot.gpuTemperature >= 85);
  document.getElementById('systemStatusText').textContent = hot ? 'Wymaga uwagi — wysoka temperatura' : 'System działa prawidłowo';
  document.getElementById('systemStatusDot').classList.toggle('warning', hot);
  const cpuTemperature = snapshot.cpuTemperature === null ? 'CPU temp. brak sensora' : `CPU ${snapshot.cpuTemperature}°C`;
  const gpuTemperature = snapshot.gpuTemperature === null ? 'GPU temp. brak sensora' : `GPU ${snapshot.gpuTemperature}°C`;
  document.getElementById('systemStatusDetails').textContent = `CPU ${snapshot.cpuLoad}% · RAM ${snapshot.memUsedPct}% · ${cpuTemperature} · ${gpuTemperature}`;
}
refreshSystemStatus();
document.getElementById('refreshSystemStatus').addEventListener('click', refreshSystemStatus);
const updateStatus = document.getElementById('updateStatus');
const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
checkUpdatesBtn.addEventListener('click', async () => {
  checkUpdatesBtn.disabled = true;
  updateStatus.textContent = 'Sprawdzam dostępność aktualizacji…';
  try {
    const result = await window.api.checkForUpdates();
    if (!result.ok) updateStatus.textContent = result.message || 'Nie udało się sprawdzić aktualizacji.';
  } catch {
    updateStatus.textContent = 'Nie udało się sprawdzić aktualizacji.';
  } finally {
    checkUpdatesBtn.disabled = false;
  }
});
window.api.onUpdateStatus((status) => {
  if (status.status === 'checking') updateStatus.textContent = 'Sprawdzam dostępność aktualizacji…';
  if (status.status === 'available') {
    updateStatus.textContent = `Dostępna wersja ${status.version}. Pobieranie…`;
    window.api.downloadUpdate().then((result) => {
      if (!result.ok) updateStatus.textContent = result.error || 'Nie udało się pobrać aktualizacji.';
    }).catch(() => {
      updateStatus.textContent = 'Nie udało się pobrać aktualizacji.';
    });
  }
  if (status.status === 'downloading') updateStatus.textContent = `Pobieranie aktualizacji: ${Math.round(status.percent)}%`;
  if (status.status === 'downloaded') {
    updateStatus.textContent = `Wersja ${status.version} jest gotowa. Uruchamiam instalację po zamknięciu aplikacji.`;
    window.api.installUpdate();
  }
  if (status.status === 'not-available') updateStatus.textContent = 'Masz najnowszą wersję TurekBoost.';
  if (status.status === 'error') updateStatus.textContent = 'Nie udało się sprawdzić aktualizacji. Spróbuj później.';
});
document.getElementById('exportLogsBtn').addEventListener('click', async () => {
  const result = await window.api.exportLogs();
  showFeedback(result.ok ? 'Logi zostały wyeksportowane.' : 'Eksport logów anulowany.');
});

// ---------- Network Analyzer ----------
const targetSelect = document.getElementById('targetSelect');
const customHost = document.getElementById('customHost');
const toggleBtn = document.getElementById('toggleMonitor');
const connStatus = document.getElementById('connStatus');
const chart = document.getElementById('pingChart');
const connectionInfo = document.getElementById('connectionInfo');
const diagnosticOutput = document.getElementById('diagnosticOutput');
let gamePresets = [];
let selectedGame = null;
let currentSession = { host: '', samples: [] };
let lastStats = null;
let optimizationBaseline = null;

let monitoring = false;
let overlayActive = false;
let fullTestRunning = false;
let lastFullTest = null;
let speedtestRunning = false;
let speedtestRunId = 0;
let lastSpeedtestResult = null;

async function loadPresets() {
  const presets = await window.api.getPresets();
  targetSelect.innerHTML = '';
  presets.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.host;
    opt.textContent = p.label;
    targetSelect.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Własny host…';
  targetSelect.appendChild(customOpt);
}

async function initializeAnalyzer() {
  if (analyzerInitialized) return;
  analyzerInitialized = true;
  const [connection] = await Promise.all([window.api.getConnection(), loadPresets()]);
  connectionInfo.textContent = connection
    ? `${connection.type} · ${connection.name}${connection.address ? ` · ${connection.address}` : ''}${connection.speed ? ` · ${connection.speed} Mb/s` : ''}`
    : 'Połączenie: brak danych';
}

async function loadGamePresets() {
  gamePresets = await window.api.getGamePresets();
  renderGameTiles();
  const running = await window.api.getGameProcesses();
  updateGameTileStatuses(running);
}

function renderGameTiles() {
  const tiles = document.getElementById('gameTiles');
  tiles.innerHTML = '';
  gamePresets.forEach((game) => {
    const tile = document.createElement('button');
    tile.className = 'game-tile';
    tile.dataset.game = game.id;
    tile.innerHTML = `<div class="game-tile-art"><img src="assets/games/${game.artwork}" alt="" onerror="this.style.display='none'"><span>${game.game.split(' ').map((word) => word[0]).join('').slice(0, 3)}</span></div><div class="game-tile-copy"><strong>${game.game}</strong><small>${game.regions.length} regiony</small><span class="game-process-line"><span class="game-status-button">SPRAWDZANIE</span><span class="game-status-text">Trwa wykrywanie procesu</span></span></div>`;
    tile.addEventListener('click', () => openGameDetail(game));
    tiles.appendChild(tile);
  });
}

function updateGameTileStatuses(runningIds) {
  document.querySelectorAll('.game-tile').forEach((tile) => {
    const active = runningIds.includes(tile.dataset.game);
    const statusButton = tile.querySelector('.game-status-button');
    const statusText = tile.querySelector('.game-status-text');
    statusButton.textContent = active ? 'URUCHOMIONA' : 'NIEURUCHOMIONA';
    statusButton.classList.toggle('running', active);
    statusButton.classList.toggle('stopped', !active);
    statusText.textContent = active ? 'Gra jest uruchomiona' : 'Gra nie jest uruchomiona';
  });
}

async function refreshGameStatuses() {
  if (!gamePresets.length) return;
  const running = await window.api.getGameProcesses();
  updateGameTileStatuses(running);
  if (selectedGame && document.getElementById('view-game-detail').classList.contains('active')) {
    checkGameProcess(selectedGame);
  }
}

function openGameDetail(game) {
  selectedGame = game;
  document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  document.getElementById('view-game-detail').classList.add('active');
  document.getElementById('gameDetailTitle').textContent = game.game;
  document.getElementById('gameDetailSubtitle').textContent = `${game.regions.length} gotowe regiony pomiarowe`;
  document.getElementById('gameHeroInitials').textContent = game.game.split(' ').map((word) => word[0]).join('').slice(0, 3);
  const heroImage = document.getElementById('gameHeroImage');
  heroImage.onerror = () => { heroImage.style.display = 'none'; };
  heroImage.src = `assets/games/${game.artwork}`;
  heroImage.style.display = 'block';
  heroImage.alt = `${game.game} artwork`;
  document.getElementById('gameDetailRegion').innerHTML = game.regions.map((region) => `<option value="${region.host}">${region.label}</option>`).join('');
  updateGameHost();
  checkGameProcess(game);
  loadGameHistory(game.id);
}

function updateGameHost() {
  const region = selectedGame?.regions.find((item) => item.host === document.getElementById('gameDetailRegion').value) || selectedGame?.regions[0];
  document.getElementById('gameDetailHost').textContent = region ? `HOST  ${region.host}` : '';
}

async function checkGameProcess(game) {
  const running = await window.api.getGameProcesses();
  const active = running.includes(game.id);
  document.getElementById('gameDetailProcess').textContent = active ? '● Gra aktywna' : '○ Proces nieaktywny';
  document.getElementById('gameDetailProcess').classList.toggle('is-active', active);
  document.getElementById('gamesProcessStatus').textContent = active ? `Aktywna: ${game.game}` : 'Nie wykryto aktywnej gry';
}

document.getElementById('gameDetailRegion').addEventListener('change', updateGameHost);
loadGamePresets();

window.api.getAutostart().then(({ enabled }) => { document.getElementById('autostartToggle').checked = enabled; });
document.getElementById('autostartToggle').addEventListener('change', async (event) => {
  const result = await window.api.setAutostart(event.target.checked);
  if (!result.ok) event.target.checked = !event.target.checked;
});

async function startMonitoring(host, gameId = null) {
  if (host === '__custom__') {
    host = customHost.value.trim();
    if (!host) { customHost.focus(); return; }
  }
  if (document.getElementById('ramAutoSwitch')?.classList.contains('on')) {
    const cleanResult = await window.api.cleanMemory();
    if (!cleanResult.ok) showFeedback(`Automatyczne czyszczenie RAM: ${cleanResult.error}`);
  }
  await window.api.startMonitor(host, gameId);
  currentSession = { host, samples: [] };
  setScanProgress(0);
  document.getElementById('scanProgress').classList.add('active');
  monitoring = true;
  toggleBtn.textContent = 'Zatrzymaj pomiar';
  toggleBtn.classList.add('active');
  document.getElementById('gameDetailMonitor').textContent = 'Zatrzymaj pomiar';
  document.getElementById('gameDetailMonitor').classList.add('active');
  connStatus.textContent = 'Na żywo';
  connStatus.classList.add('live');
  connStatus.classList.remove('idle');
}

async function stopMonitoring() {
  await window.api.stopMonitor();
  monitoring = false;
  toggleBtn.textContent = 'Start pomiaru';
  toggleBtn.classList.remove('active');
  document.getElementById('gameDetailMonitor').textContent = 'Start pomiaru';
  document.getElementById('gameDetailMonitor').classList.remove('active');
  connStatus.textContent = 'Bezczynny';
  connStatus.classList.remove('live');
  connStatus.classList.add('idle');
  document.getElementById('scanProgress').classList.remove('active');
}

function setScanProgress(percent) {
  const progress = Math.max(0, Math.min(100, percent));
  document.getElementById('scanPercent').textContent = `${progress}%`;
  document.getElementById('scanProgress').style.setProperty('--progress', `${progress}%`);
  document.getElementById('scanProgressTitle').textContent = progress >= 100 ? 'Test zakończony' : 'Testowanie połączenia';
  document.getElementById('scanProgressText').textContent = progress >= 100 ? 'Próbki zostały zapisane w historii sesji.' : progress < 35 ? 'Sprawdzam dostępność celu i stabilność odpowiedzi.' : progress < 70 ? 'Analizuję ping, jitter i utratę pakietów.' : 'Kończę pomiar i przygotowuję podsumowanie.';
}

function setFullTestButtons(disabled) {
  const buttons = [document.getElementById('fullTestBtn'), document.getElementById('fullTestHomeBtn')];
  buttons.forEach((button) => { if (button) button.disabled = disabled; });
  document.getElementById('fullTestBtn').textContent = disabled ? 'Test w toku…' : 'Test automatyczny';
}

function renderFullTestReport(result) {
  const report = document.getElementById('fullTestReport');
  report.hidden = false;
  const status = document.getElementById('fullTestStatus');
  if (!result.ok) {
    status.textContent = 'BŁĄD';
    document.getElementById('fullTestConnection').textContent = result.error || 'Nie udało się wykonać testu.';
    document.getElementById('fullTestRecommendation').textContent = 'Spróbuj ponownie lub uruchom pojedyncze testy w Analizie sieci.';
    document.getElementById('fullTestTraceOutput').textContent = '';
    return;
  }
  const ping = result.ping;
  const connection = result.connection;
  const recommendation = result.recommendation;
  status.textContent = 'GOTOWY';
  document.getElementById('fullTestConnection').textContent = connection
    ? `Cel: ${result.host} · ${connection.type} · ${connection.name}${connection.address ? ` · ${connection.address}` : ''}${connection.speed ? ` · ${connection.speed} Mb/s` : ''}${connection.signal !== null && connection.signal !== undefined ? ` · sygnał ${connection.signal} dBm` : ''}`
    : `Cel: ${result.host} · informacje o połączeniu: brak danych`;
  document.getElementById('fullTestPing').textContent = ping.avg === null ? '—' : ping.avg.toFixed(1);
  document.getElementById('fullTestStability').textContent = `${ping.jitter.toFixed(1)} / ${ping.loss}`;
  document.getElementById('fullTestSpeed').textContent = result.speedtest.download?.ok ? result.speedtest.download.mbps.toFixed(1) : '—';
  document.getElementById('fullTestUpload').textContent = result.speedtest.upload?.ok ? result.speedtest.upload.mbps.toFixed(1) : '—';
  document.getElementById('fullTestTrace').textContent = result.traceroute.ok ? 'OK' : 'NIEPEŁNA';
  document.getElementById('fullTestQuality').textContent = getQualityForStats(ping);
  const recommendationElement = document.getElementById('fullTestRecommendation');
  recommendationElement.innerHTML = `<strong>${escapeHtml(recommendation.title)}</strong><span>${escapeHtml(recommendation.detail)}</span>`;
  recommendationElement.className = `full-test-recommendation ${recommendation.category}`;
  document.getElementById('fullTestTraceOutput').textContent = result.traceroute.output || 'Brak surowych danych traceroute.';
}

async function runFullTest() {
  if (fullTestRunning || speedtestRunning) return;
  showView('analyzer');
  await initializeAnalyzer();
  let host = targetSelect.value;
  if (host === '__custom__') {
    host = customHost.value.trim();
    if (!host) { customHost.focus(); showFeedback('Podaj własny adres lub host.'); return; }
  }
  if (monitoring) await stopMonitoring();
  fullTestRunning = true;
  lastFullTest = null;
  setFullTestButtons(true);
  document.getElementById('fullTestReport').hidden = false;
  document.getElementById('fullTestStatus').textContent = 'W TOKU';
  document.getElementById('fullTestConnection').textContent = 'Przygotowuję pomiar…';
  document.getElementById('fullTestQuality').textContent = '—';
  document.getElementById('fullTestSpeed').textContent = '—';
  document.getElementById('fullTestUpload').textContent = '—';
  document.getElementById('fullTestRecommendation').textContent = 'Test obejmuje ping, speedtest, traceroute i informacje o połączeniu.';
  document.getElementById('fullTestTraceOutput').textContent = '';
  document.getElementById('scanProgress').classList.add('active');
  setScanProgress(0);
  try {
    const result = await window.api.fullTest(host);
    if (result.ok) {
      lastFullTest = result;
      currentSession = { host: result.host, samples: result.ping.samples };
      const lastSample = result.ping.samples[result.ping.samples.length - 1];
      lastStats = { ...result.ping, current: lastSample?.time ?? null, alive: Boolean(lastSample?.alive), history: result.ping.samples.map((sample) => sample.time), host: result.host };
      drawChart(lastStats.history);
      updateNetworkRecommendation(lastStats);
    }
    renderFullTestReport(result);
    renderOptimizationComparison(document.getElementById('optimizationComparison'), lastStats);
    setScanProgress(100);
  } catch (error) {
    renderFullTestReport({ ok: false, error: error.message });
  } finally {
    fullTestRunning = false;
    setFullTestButtons(false);
    document.getElementById('scanProgress').classList.remove('active');
  }
}

window.api.onFullTestProgress(({ percent, label }) => {
  if (!fullTestRunning) return;
  setScanProgress(percent);
  if (label) document.getElementById('fullTestConnection').textContent = label;
});

document.getElementById('fullTestBtn').addEventListener('click', runFullTest);
document.getElementById('fullTestHomeBtn').addEventListener('click', runFullTest);

const speedtestModal = document.getElementById('speedtestModal');
const speedtestPanel = speedtestModal.querySelector('.speedtest-panel');
const speedtestCancelButton = document.getElementById('cancelSpeedtest');
const speedtestResultsButton = document.getElementById('viewSpeedtestResults');

function setSpeedtestProgress(percent, label) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  document.getElementById('speedtestPercent').textContent = `${value}%`;
  document.querySelector('.speedtest-orb').style.setProperty('--speedtest-progress', `${value}%`);
  if (label) document.getElementById('speedtestStatus').textContent = label;
}

function setSpeedtestMetric(kind, result) {
  const value = document.getElementById(`speedtest${kind}`);
  const status = document.getElementById(`speedtest${kind}Status`);
  const valid = result && result.ok && typeof result.mbps === 'number' && Number.isFinite(result.mbps);
  value.textContent = valid ? result.mbps.toFixed(1) : 'Brak wyniku';
  status.textContent = valid ? 'Pomiar zakończony' : result?.error || 'Endpoint niedostępny — brak wyniku';
  status.classList.toggle('is-error', !valid);
}

function renderSpeedtestResult(result) {
  lastSpeedtestResult = result;
  speedtestPanel.classList.add('is-complete');
  setSpeedtestMetric('Download', result.download);
  setSpeedtestMetric('Upload', result.upload);
  speedtestPanel.classList.toggle('is-error', !result.download?.ok && !result.upload?.ok);
  document.getElementById('speedtestStatus').textContent = result.cancelled
    ? 'Test anulowany.'
    : result.download?.ok || result.upload?.ok
      ? 'Pomiar zakończony. Niedostępne wartości oznaczono jako brak wyniku.'
      : 'Nie udało się uzyskać wyniku z żadnego endpointu.';
  speedtestResultsButton.disabled = false;
  speedtestCancelButton.disabled = true;
}

async function openSpeedtestPanel(outputElement = diagnosticOutput) {
  if (speedtestRunning || fullTestRunning) return;
  const runId = ++speedtestRunId;
  speedtestRunning = true;
  lastSpeedtestResult = null;
  speedtestPanel.classList.remove('is-error', 'is-complete', 'show-results');
  speedtestModal.classList.add('visible');
  speedtestCancelButton.disabled = false;
  speedtestResultsButton.disabled = true;
  document.getElementById('speedtestTitle').textContent = 'Sprawdzam szybkość internetu';
  document.getElementById('speedtestDownload').textContent = '—';
  document.getElementById('speedtestUpload').textContent = '—';
  document.getElementById('speedtestDownloadStatus').textContent = 'Oczekiwanie';
  document.getElementById('speedtestUploadStatus').textContent = 'Oczekiwanie';
  document.getElementById('speedtestDownloadStatus').classList.remove('is-error');
  document.getElementById('speedtestUploadStatus').classList.remove('is-error');
  setSpeedtestProgress(0, 'Przygotowuję bezpieczny test HTTPS…');
  if (outputElement) outputElement.textContent = 'Test przepustowości w toku…';
  try {
    const connection = await window.api.getConnection().catch(() => null);
    if (runId !== speedtestRunId) return;
    document.getElementById('speedtestConnectionType').textContent = connection
      ? `${connection.type}${connection.name ? ` · ${connection.name}` : ''}`
      : 'Brak danych';
    document.getElementById('speedtestConnectionAddress').textContent = connection?.address || 'Brak danych';
    const result = await window.api.speedtest();
    if (runId !== speedtestRunId) return;
    renderSpeedtestResult(result);
    if (outputElement) {
      const download = result.download?.ok ? `${result.download.mbps.toFixed(1)} Mb/s` : 'brak wyniku';
      const upload = result.upload?.ok ? `${result.upload.mbps.toFixed(1)} Mb/s` : 'brak wyniku';
      outputElement.textContent = `Pobieranie: ${download}\nWysyłanie: ${upload}`;
    }
  } catch (error) {
    if (runId !== speedtestRunId) return;
    renderSpeedtestResult({ ok: false, error: error.message, download: { ok: false, error: error.message }, upload: { ok: false, error: error.message } });
    if (outputElement) outputElement.textContent = `Błąd: ${error.message}`;
  } finally {
    if (runId === speedtestRunId) speedtestRunning = false;
  }
}

async function cancelSpeedtestPanel() {
  if (!speedtestRunning) {
    speedtestModal.classList.remove('visible');
    return;
  }
  speedtestCancelButton.disabled = true;
  document.getElementById('speedtestStatus').textContent = 'Anulowanie testu…';
  await window.api.cancelSpeedtest().catch(() => {});
  speedtestRunId += 1;
  speedtestRunning = false;
  speedtestModal.classList.remove('visible');
}

window.api.onSpeedtestProgress(({ percent, label }) => {
  if (speedtestRunning) setSpeedtestProgress(percent, label);
});
speedtestCancelButton.addEventListener('click', cancelSpeedtestPanel);
document.getElementById('closeSpeedtest').addEventListener('click', cancelSpeedtestPanel);
speedtestModal.addEventListener('click', (event) => { if (event.target === speedtestModal) cancelSpeedtestPanel(); });
speedtestResultsButton.addEventListener('click', () => {
  if (!lastSpeedtestResult) return;
  speedtestPanel.classList.add('show-results');
  document.getElementById('speedtestTitle').textContent = 'Wyniki skanowania połączenia';
  document.getElementById('speedtestStatus').textContent = 'Wyniki pokazują wyłącznie udane pomiary HTTPS.';
});

window.api.onProgress(({ percent }) => setScanProgress(percent));
window.api.onComplete(() => {
  monitoring = false;
  toggleBtn.textContent = 'Start pomiaru';
  toggleBtn.classList.remove('active');
  document.getElementById('gameDetailMonitor').textContent = 'Start pomiaru';
  document.getElementById('gameDetailMonitor').classList.remove('active');
  connStatus.textContent = 'Gotowe';
  connStatus.classList.remove('live');
  connStatus.classList.add('idle');
  setScanProgress(100);
  showNetworkResult();
});

function getQualityForStats(stats) {
  if (!stats || stats.avg === null || stats.loss >= 10 || stats.avg >= 150) return 'ŹLE';
  if (stats.loss >= 3 || stats.avg >= 80 || stats.jitter >= 20) return 'ŚREDNIO';
  return 'DOBRZE';
}

function getCurrentQuality() {
  return getQualityForStats(lastStats);
}

function captureOptimizationBaseline() {
  if (!lastStats || lastStats.avg === null) return false;
  optimizationBaseline = {
    capturedAt: Date.now(),
    host: lastStats.host,
    avg: lastStats.avg,
    min: lastStats.min,
    max: lastStats.max,
    jitter: lastStats.jitter,
    loss: lastStats.loss,
    quality: getQualityForStats(lastStats),
  };
  return true;
}

function getOptimizationComparison(afterStats = lastStats) {
  if (!optimizationBaseline || !afterStats || afterStats.host !== optimizationBaseline.host || afterStats.avg === null) return null;
  return {
    host: afterStats.host,
    before: optimizationBaseline,
    after: {
      avg: afterStats.avg,
      min: afterStats.min,
      max: afterStats.max,
      jitter: afterStats.jitter,
      loss: afterStats.loss,
      quality: getQualityForStats(afterStats),
    },
    deltaAvg: Math.round((afterStats.avg - optimizationBaseline.avg) * 10) / 10,
    deltaLoss: Math.round((afterStats.loss - optimizationBaseline.loss) * 10) / 10,
  };
}

function getCurrentReportData() {
  return lastStats
    ? { ...currentSession, avg: lastStats.avg, min: lastStats.min, max: lastStats.max, jitter: lastStats.jitter, loss: lastStats.loss, quality: getCurrentQuality(), comparison: getOptimizationComparison() }
    : currentSession;
}

function renderOptimizationComparison(element, afterStats = lastStats) {
  const comparison = getOptimizationComparison(afterStats);
  if (!comparison) {
    element.hidden = true;
    element.innerHTML = '';
    return;
  }
  const pingDelta = comparison.deltaAvg > 0 ? `+${comparison.deltaAvg}` : comparison.deltaAvg;
  const lossDelta = comparison.deltaLoss > 0 ? `+${comparison.deltaLoss}` : comparison.deltaLoss;
  element.hidden = false;
  element.innerHTML = `<strong>Porównanie przed / po optymalizacji</strong><span>PRZED: ${comparison.before.avg.toFixed(1)} ms · ${comparison.before.loss}% loss · ${comparison.before.quality}</span><span>PO: ${comparison.after.avg.toFixed(1)} ms · ${comparison.after.loss}% loss · ${comparison.after.quality}</span><small>Zmiana: ${pingDelta} ms ping · ${lossDelta} pp loss</small>`;
}

function showNetworkResult() {
  if (!lastStats || !currentSession.samples.length) return;
  const quality = getCurrentQuality();
  const badge = document.getElementById('networkResultQuality');
  badge.textContent = quality;
  badge.className = `quality-badge ${quality.toLowerCase()}`;
  document.getElementById('networkResultHost').textContent = lastStats.host;
  document.getElementById('resultAvg').textContent = lastStats.avg === null ? '—' : lastStats.avg.toFixed(1);
  document.getElementById('resultJitter').textContent = lastStats.jitter.toFixed(1);
  document.getElementById('resultLoss').textContent = lastStats.loss;
  document.getElementById('networkResultMessage').textContent = quality === 'DOBRZE' ? 'Połączenie wygląda stabilnie.' : quality === 'ŚREDNIO' ? 'Wykryto lekką niestabilność. Warto sprawdzić obciążenie sieci.' : 'Wykryto problem z jakością połączenia. Sprawdź router, Wi-Fi i trasę do celu.';
  renderOptimizationComparison(document.getElementById('networkResultComparison'));
  document.getElementById('networkResultModal').classList.add('visible');
}

function closeNetworkResult() {
  document.getElementById('networkResultModal').classList.remove('visible');
}
document.getElementById('closeNetworkResult').addEventListener('click', closeNetworkResult);
document.getElementById('closeNetworkResultButton').addEventListener('click', closeNetworkResult);
document.getElementById('networkResultModal').addEventListener('click', (event) => { if (event.target.id === 'networkResultModal') closeNetworkResult(); });
document.getElementById('openResultHistory').addEventListener('click', () => {
  closeNetworkResult();
  document.querySelector('[data-view="history"]').click();
});

toggleBtn.addEventListener('click', async () => {
  if (!monitoring) {
    const host = targetSelect.value;
    await startMonitoring(host);
  } else {
    await stopMonitoring();
  }
});

document.getElementById('gameDetailMonitor').addEventListener('click', async () => {
  if (monitoring) {
    return stopMonitoring();
  }
  await startMonitoring(document.getElementById('gameDetailRegion').value, selectedGame?.id || null);
});
document.getElementById('backToGames').addEventListener('click', () => {
  document.querySelector('[data-view="games"]').click();
});

function gameDiagnosticHost() {
  return document.getElementById('gameDetailRegion').value;
}
document.getElementById('gameTrace').addEventListener('click', async () => {
  document.getElementById('gameDiagnosticOutput').textContent = 'Traceroute w toku…';
  const result = await window.api.traceroute(gameDiagnosticHost());
  document.getElementById('gameDiagnosticOutput').textContent = result.output || result.error || 'Brak danych.';
});
document.getElementById('gameSpeed').addEventListener('click', async () => {
  openSpeedtestPanel(document.getElementById('gameDiagnosticOutput'));
});
document.getElementById('gameBenchmark').addEventListener('click', async () => {
  const output = document.getElementById('gameDiagnosticOutput');
  output.textContent = 'Porównuję regiony…';
  const result = await window.api.benchmarkRegions(selectedGame.id);
  output.textContent = result.ok ? result.results.map((region, index) => `${index + 1}. ${region.label} · ${region.avg === null ? 'brak odpowiedzi' : `${region.avg.toFixed(0)} ms`} · ${region.loss}% loss`).join('\n') : `Błąd: ${result.error}`;
});
const gameModeModal = document.getElementById('gameModeModal');
const closeGameModeModal = () => gameModeModal.classList.remove('visible');
document.getElementById('gameMode').addEventListener('click', () => {
  if (!selectedGame) return;
  document.getElementById('gameModeDescription').textContent = `TurekBoost zmieni priorytet wykrytego procesu ${selectedGame.game}.`;
  gameModeModal.classList.add('visible');
});
document.getElementById('closeGameMode').addEventListener('click', closeGameModeModal);
document.getElementById('cancelGameMode').addEventListener('click', closeGameModeModal);
gameModeModal.addEventListener('click', (event) => { if (event.target === gameModeModal) closeGameModeModal(); });
document.getElementById('confirmGameMode').addEventListener('click', async () => {
  const result = await window.api.gameMode(selectedGame.id);
  closeGameModeModal();
  showFeedback(result.ok ? `Game Mode aktywny dla PID ${result.pid}.` : `Błąd: ${result.error || result.output}`);
});
document.getElementById('gameExport').addEventListener('click', async () => {
  if (!currentSession.samples.length) return showFeedback('Najpierw uruchom pomiar.');
  await window.api.exportHistory('json', currentSession);
});

window.api.onSample((stats) => {
  lastStats = stats;
  currentSession.host = stats.host;
  currentSession.samples.push({ t: Date.now(), time: stats.current, alive: stats.alive });
  document.getElementById('mCurrent').textContent = stats.current !== null ? stats.current.toFixed(0) : '—';
  document.getElementById('mAvg').textContent = stats.avg !== null ? stats.avg.toFixed(1) : '—';
  document.getElementById('mJitter').textContent = stats.jitter.toFixed(1);
  document.getElementById('mMinMax').textContent =
    stats.min !== null ? `${stats.min.toFixed(0)} / ${stats.max.toFixed(0)}` : '— / —';
  document.getElementById('mLoss').textContent = stats.loss;
  updateNetworkRecommendation(stats);

  drawChart(stats.history);
  document.getElementById('gamePing').textContent = stats.current !== null ? stats.current.toFixed(0) : '—';
  document.getElementById('gameJitter').textContent = stats.jitter.toFixed(1);
  document.getElementById('gameLoss').textContent = stats.loss;
  document.getElementById('gameDetailStatus').textContent = stats.loss >= 20 || stats.current >= 150 ? 'PROBLEM' : 'DOBRE';
  const diagnosis = document.getElementById('gameDiagnosis');
  if (stats.loss >= 20 || stats.current === null) diagnosis.textContent = 'Możliwy problem z Wi-Fi, routerem albo dostępnością serwera gry.';
  else if (stats.current >= 150 || stats.jitter >= 25) diagnosis.textContent = 'Serwer odpowiada, ale opóźnienie jest wysokie lub niestabilne. Sprawdź trasę i obciążenie sieci.';
  else diagnosis.textContent = 'Połączenie z wybranym regionem wygląda stabilnie.';
});

async function loadGameHistory(gameId) {
  const sessions = (await window.api.getSessions()).filter((session) => session.gameId === gameId).slice(-5).reverse();
  const summary = document.getElementById('gameHistorySummary');
  if (!sessions.length) {
    summary.textContent = 'Brak zapisanych sesji dla tej gry.';
    return;
  }
  summary.innerHTML = sessions.map((session) => {
    const values = session.samples.map((sample) => sample.time).filter((value) => typeof value === 'number');
    const avg = values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(0) : '—';
    const loss = session.samples.length ? Math.round((1 - values.length / session.samples.length) * 100) : 0;
    return `<div class="game-history-row"><span>${new Date(session.startedAt).toLocaleString('pl-PL')}</span><strong>${avg} ms</strong><small>${loss}% loss · ${session.samples.length} próbek</small></div>`;
  }).join('');
}

function updateNetworkRecommendation(stats) {
  const recommendation = document.getElementById('networkRecommendation');
  if (!stats.alive || stats.loss >= 20) recommendation.textContent = 'Problem z dostępnością celu lub duża utrata pakietów. Sprawdź kabel/Wi-Fi i router.';
  else if (stats.avg >= 150) recommendation.textContent = 'Bardzo wysokie opóźnienie. Sprawdź obciążenie sieci i trasę do celu.';
  else if (stats.jitter >= 25) recommendation.textContent = 'Połączenie jest niestabilne. Możliwy bufferbloat albo zakłócenia Wi-Fi.';
  else recommendation.textContent = 'Połączenie wygląda stabilnie. Nie wykryto istotnego problemu w bieżącej sesji.';
  recommendation.className = `network-recommendation ${!stats.alive || stats.loss >= 20 || stats.avg >= 150 ? 'bad' : stats.jitter >= 25 ? 'warn' : 'good'}`;
}

window.api.onAlert(({ loss, time, cpuTemperature, gpuTemperature, reason }) => {
  if (document.getElementById('alertToggle').checked) {
    showFeedback(`Alert: ${reason || `ping ${time ?? 'brak'} ms, utrata ${loss}%`}`);
    const hot = (cpuTemperature !== null && cpuTemperature >= 85) || (gpuTemperature !== null && gpuTemperature >= 85);
    if (hot) {
      document.getElementById('systemStatusText').textContent = 'Wymaga uwagi — wysoka temperatura';
      document.getElementById('systemStatusDot').classList.add('warning');
    }
  }
});

document.getElementById('traceBtn').addEventListener('click', async () => {
  const host = lastStats?.host || customHost.value.trim() || targetSelect.value;
  diagnosticOutput.textContent = 'Traceroute i pomiar hopów w toku…';
  const result = await window.api.traceDetailed(host);
  diagnosticOutput.textContent = result.output || 'Brak surowych danych traceroute.';
  document.getElementById('routeDiagnosis').textContent = result.diagnosis || 'Brak diagnozy.';
  const routeHops = document.getElementById('routeHops');
  routeHops.innerHTML = result.hops?.length ? result.hops.map((hop) => `<div class="route-hop"><span class="hop-number">${hop.hop}</span><span class="hop-address">${hop.address}</span><span>${hop.pingMs === null ? '—' : `${hop.pingMs.toFixed(0)} ms`}</span><span class="hop-loss ${hop.loss ? 'has-loss' : ''}">${hop.loss}% loss</span></div>`).join('') : '<span class="muted">Nie udało się odczytać hopów.</span>';
  document.getElementById('routePanel').classList.add('visible');
});

document.getElementById('speedBtn').addEventListener('click', async () => {
  openSpeedtestPanel(diagnosticOutput);
});

document.getElementById('exportCurrentBtn').addEventListener('click', async () => {
  if (!currentSession.samples.length) return showFeedback('Najpierw uruchom pomiar.');
  const result = await window.api.exportHistory('json', getCurrentReportData());
  showFeedback(result.ok ? 'Sesja wyeksportowana.' : 'Eksport anulowany.');
});

document.getElementById('exportCurrentCsvBtn').addEventListener('click', async () => {
  if (!currentSession.samples.length) return showFeedback('Najpierw uruchom pomiar.');
  const result = await window.api.exportHistory('csv', currentSession);
  showFeedback(result.ok ? 'Sesja wyeksportowana do CSV.' : 'Eksport anulowany.');
});

document.getElementById('reportBtn').addEventListener('click', async () => {
  if (!currentSession.samples.length || !lastStats) return showFeedback('Najpierw uruchom pomiar.');
  const result = await window.api.exportHistory('txt', getCurrentReportData());
  showFeedback(result.ok ? 'Raport dla ISP wyeksportowany.' : 'Eksport anulowany.');
});

async function loadHistory() {
  const sessions = await window.api.getSessions();
  const list = document.getElementById('historyList');
  list.innerHTML = sessions.length ? '' : '<div class="empty-state">Brak zapisanych sesji pomiarowych.</div>';
  sessions.slice().reverse().forEach((session, index) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (index === 0) item.classList.add('selected');
    item.innerHTML = `<div class="history-summary"><input type="checkbox" class="session-check" value="${session.id}"><span><strong>${new Date(session.startedAt).toLocaleString('pl-PL')}</strong><small>${escapeHtml(session.host)} · ${session.samples.length} próbek</small></span><button type="button" class="export-session" data-id="${session.id}">JSON</button><button type="button" class="delete-session" data-id="${session.id}" aria-label="Usuń sesję">Usuń</button></div><div class="session-inline-details"></div>`;
    item.addEventListener('click', (event) => {
      if (event.target.closest('input, button')) return;
      document.querySelectorAll('.history-item').forEach((historyItem) => historyItem.classList.remove('selected'));
      item.classList.add('selected');
      showSessionDetails(item, session);
    });
    list.appendChild(item);
    if (index === 0) showSessionDetails(item, session);
  });
  list.querySelectorAll('.export-session').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    const session = sessions.find((item) => item.id === button.dataset.id);
    await window.api.exportHistory('json', session);
  }));
  list.querySelectorAll('.delete-session').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!window.confirm('Usunąć tę sesję pomiarową?')) return;
    await window.api.deleteSession(button.dataset.id);
    loadHistory();
  }));
  list.querySelectorAll('.session-check').forEach((checkbox) => checkbox.addEventListener('change', updateComparisonCheckboxes));
  updateComparisonCheckboxes();
}

function updateComparisonCheckboxes() {
  const checkboxes = [...document.querySelectorAll('.session-check')];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  checkboxes.forEach((checkbox) => {
    checkbox.disabled = !checkbox.checked && selectedCount >= 2;
  });
}

function getSessionMetrics(session) {
  const values = session.samples.map((sample) => sample.time).filter((value) => typeof value === 'number');
  const loss = session.samples.length ? ((session.samples.length - values.length) / session.samples.length) * 100 : 0;
  const jitterValues = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  return {
    values,
    avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    jitter: jitterValues.length ? jitterValues.reduce((sum, value) => sum + value, 0) / jitterValues.length : 0,
    loss,
  };
}

function showSessionDetails(item, session) {
  document.querySelectorAll('.session-inline-details.visible').forEach((details) => {
    if (details !== item.querySelector('.session-inline-details')) details.classList.remove('visible');
  });
  const metrics = getSessionMetrics(session);
  const quality = metrics.avg === null || metrics.loss >= 10 || metrics.avg >= 150 ? 'ŹLE' : metrics.loss >= 3 || metrics.avg >= 80 || metrics.jitter >= 20 ? 'ŚREDNIO' : 'DOBRZE';
  const details = item.querySelector('.session-inline-details');
  details.innerHTML = `<div class="session-detail-header"><div><p class="eyebrow">Szczegóły sesji</p><h2>${new Date(session.startedAt).toLocaleString('pl-PL')}</h2><p class="subtitle">${escapeHtml(session.host)} · ${session.samples.length} próbek</p></div><span class="quality-badge ${quality.toLowerCase()}">${quality}</span></div><div class="session-metrics"><div><small>Średni ping</small><strong>${metrics.avg === null ? '—' : metrics.avg.toFixed(1)}</strong><em>ms</em></div><div><small>Min / Max</small><strong>${metrics.min === null ? '— / —' : `${metrics.min.toFixed(0)} / ${metrics.max.toFixed(0)}`}</strong><em>ms</em></div><div><small>Jitter</small><strong>${metrics.jitter.toFixed(1)}</strong><em>ms</em></div><div><small>Utrata pakietów</small><strong>${metrics.loss.toFixed(1)}</strong><em>%</em></div></div><div class="panel-title">Ping podczas sesji</div><svg class="session-chart" viewBox="0 0 600 210" preserveAspectRatio="none"></svg>`;
  drawSessionChart(details.querySelector('.session-chart'), session.samples);
  details.classList.add('visible');
}

function drawSessionChart(chartElement, samples) {
  const width = 600; const height = 210; const padding = 12;
  const values = samples.map((sample) => sample.time).filter((value) => typeof value === 'number');
  const max = Math.max(...values, 20);
  if (values.length < 2) {
    chartElement.innerHTML = '';
    return;
  }
  const points = samples.map((sample, index) => sample.time === null ? '' : `${padding + index * ((width - padding * 2) / Math.max(samples.length - 1, 1))},${height - padding - (sample.time / max) * (height - padding * 2)}`).filter(Boolean).join(' ');
  chartElement.innerHTML = `<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(145,162,159,.25)" /><polyline points="${points}" fill="none" stroke="#56e0bd" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
}

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!window.confirm('Usunąć całą historię sesji? Tej operacji nie można cofnąć.')) return;
  await window.api.clearHistory();
  document.getElementById('compareChart').innerHTML = '';
  document.getElementById('compareSummary').textContent = 'Historia została wyczyszczona.';
  loadHistory();
});

document.getElementById('compareBtn').addEventListener('click', async () => {
  const sessions = await window.api.getSessions();
  const selected = [...document.querySelectorAll('.session-check:checked')].slice(0, 2).map((input) => sessions.find((item) => String(item.id) === String(input.value))).filter(Boolean);
  if (selected.length !== 2) return (document.getElementById('compareSummary').textContent = 'Zaznacz dokładnie dwie sesje.');
  const average = (session) => {
    const values = session.samples.map((sample) => sample.time).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  document.getElementById('compareSummary').textContent = `${selected[0].host}: ${average(selected[0])?.toFixed(1) ?? '—'} ms średnio  ·  ${selected[1].host}: ${average(selected[1])?.toFixed(1) ?? '—'} ms średnio`;
  drawCompareChart(selected);
});

function drawCompareChart(sessions) {
  const colors = ['#45d8c2', '#f2b542'];
  const w = 600; const h = 180; const pad = 10;
  const values = sessions.flatMap((session) => session.samples.map((sample) => sample.time).filter((value) => value !== null));
  const max = Math.max(...values, 20);
  document.getElementById('compareChart').innerHTML = sessions.map((session, index) => {
    const points = session.samples.map((sample, pointIndex) => sample.time === null ? '' : `${pad + pointIndex * ((w - pad * 2) / Math.max(session.samples.length - 1, 1))},${h - pad - (sample.time / max) * (h - pad * 2)}`).filter(Boolean).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${colors[index]}" stroke-width="1.6" />`;
  }).join('');
}

const themeToggle = document.getElementById('themeToggle');
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('light-theme');
  themeToggle.textContent = `Motyw: ${document.body.classList.contains('light-theme') ? 'jasny' : 'ciemny'}`;
  localStorage.setItem('turekboost-theme', document.body.classList.contains('light-theme') ? 'light' : 'dark');
});

function drawChart(history) {
  const w = 600;
  const h = 180;
  const pad = 10;
  const values = history.filter((v) => v !== null && v !== undefined);
  if (values.length < 2) {
    chart.innerHTML = '';
    return;
  }
  const max = Math.max(...values, 20);
  const min = 0;
  const stepX = (w - pad * 2) / (history.length - 1);

  let points = [];
  history.forEach((v, i) => {
    const x = pad + i * stepX;
    if (v === null || v === undefined) return;
    const y = h - pad - ((v - min) / (max - min)) * (h - pad * 2);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });

  const polyline = points.join(' ');
  const areaPoints = `${pad},${h - pad} ${polyline} ${w - pad},${h - pad}`;

  chart.innerHTML = `
    <polygon points="${areaPoints}" fill="rgba(69,216,194,0.10)" stroke="none"></polygon>
    <polyline points="${polyline}" fill="none" stroke="#45d8c2" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></polyline>
  `;
}

// ---------- PC Boost ----------
const procBody = document.getElementById('procBody');
const feedback = document.getElementById('actionFeedback');

async function refreshSnapshot() {
  const snap = await window.api.getSnapshot();
  document.getElementById('bCpu').textContent = snap.cpuLoad.toFixed(1);
  document.getElementById('bMem').textContent = `${snap.memUsedGB} / ${snap.memTotalGB}`;
  document.getElementById('bMemPct').textContent = snap.memUsedPct;
  document.getElementById('bCpuTemp').textContent = snap.cpuTemperature === null ? 'Brak sensora' : snap.cpuTemperature.toFixed(0);
  document.getElementById('bGpuTemp').textContent = snap.gpuTemperature === null ? 'Brak sensora' : snap.gpuTemperature.toFixed(0);
  document.getElementById('ramBarUsed').style.width = `${snap.memUsedPct}%`;
  document.getElementById('ramUsedLabel').textContent = `${snap.memUsedGB} GB`;
  document.getElementById('ramFreeLabel').textContent = `${(snap.memTotalGB - snap.memUsedGB).toFixed(1)} GB`;
  document.getElementById('ramTotalLabel').textContent = `${snap.memTotalGB} GB łącznie`;

  procBody.innerHTML = '';
  snap.topProcesses.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${p.pid}</td>
      <td>${p.memMB} MB</td>
      <td>${p.cpu}%</td>
      <td><button class="priority-btn" data-pid="${p.pid}">High</button> <button class="kill-btn" data-pid="${p.pid}">Zakończ</button></td>
    `;
    procBody.appendChild(tr);
  });

  procBody.querySelectorAll('.kill-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.pid;
      if (!window.confirm(`Zakończyć proces PID ${pid}? Niezapisane dane procesu mogą zostać utracone.`)) return;
      const res = await window.api.killProcess(pid);
      showFeedback(res.ok ? `Zakończono proces PID ${pid}.` : `Błąd: ${res.error}`);
      refreshSnapshot();
    });
  });
  procBody.querySelectorAll('.priority-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await window.api.setHighPriority(btn.dataset.pid);
      showFeedback(res.ok ? `Ustawiono wysoki priorytet PID ${btn.dataset.pid}.` : `Błąd: ${res.error || res.output}`);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showFeedback(msg) {
  feedback.textContent = msg;
  setTimeout(() => {
    if (feedback.textContent === msg) feedback.textContent = '';
  }, 5000);
}

document.getElementById('actRefresh').addEventListener('click', refreshSnapshot);
document.getElementById('overlayBtn').addEventListener('click', async (event) => {
  const result = await window.api.toggleOverlay();
  overlayActive = result.visible;
  event.currentTarget.textContent = result.visible ? 'Ukryj overlay ping' : 'Pokaż overlay ping';
});

const boostActions = {
  dns: () => window.api.flushDns(),
  refresh: () => refreshSnapshot(),
};

document.querySelectorAll('[data-boost-action]').forEach((card) => {
  card.addEventListener('click', async (event) => {
    if (event.target.closest('.boost-help')) return;
    card.classList.add('is-working');
    const action = card.dataset.boostAction;
    const boostSwitch = card.querySelector('.boost-switch');
    const enabled = !boostSwitch.classList.contains('on');
    if (action !== 'refresh') captureOptimizationBaseline();
    const result = boostActions[action]
      ? await boostActions[action]()
      : await window.api.applyBoostOption(action, enabled);
    card.classList.remove('is-working');
    if (action === 'refresh') {
      showFeedback('Dane systemu zostały odświeżone.');
      return;
    }
    showFeedback(result.ok ? 'Operacja została wykonana.' : `Błąd: ${result.error || result.output}`);
    if (!result.ok && /administrator|uprawnień|access is denied|odmowa dostępu|requires elevation/i.test(result.error || result.output || '')) showAdminRequired();
    if (result.ok && boostSwitch) boostSwitch.classList.toggle('on', action === 'refresh' || enabled);
    const undoButton = card.querySelector('.boost-undo');
    if (result.ok && undoButton && action !== 'dns') undoButton.disabled = false;
  });
});

document.querySelectorAll('.boost-undo').forEach((button) => {
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const card = button.closest('[data-boost-action]');
    const action = card?.dataset.boostAction;
    if (!action || action === 'dns' || button.disabled) return;
    button.disabled = true;
    const result = await window.api.undoBoostOption(action);
    showFeedback(result.ok ? 'Pojedyncza zmiana została cofnięta.' : `Błąd cofania: ${result.error || result.output}`);
    if (result.ok) {
      card.querySelector('.boost-switch')?.classList.remove('on');
    } else {
      button.disabled = false;
    }
  });
});
window.api.getBoostChanges().then((changes) => {
  Object.entries(changes || {}).forEach(([action, change]) => {
    const card = document.querySelector(`[data-boost-action="${action}"]`);
    if (card) {
      card.querySelector('.boost-undo').disabled = false;
      card.querySelector('.boost-switch').classList.toggle('on', !change.previousEnabled);
    }
  });
}).catch(() => {});

const boostHelpModal = document.getElementById('boostHelpModal');
document.querySelectorAll('.boost-help').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const card = button.closest('.boost-card');
    document.getElementById('boostHelpTitle').textContent = card.dataset.helpTitle;
    document.getElementById('boostHelpText').textContent = card.dataset.help;
    boostHelpModal.classList.add('visible');
  });
});
document.getElementById('closeBoostHelp').addEventListener('click', () => boostHelpModal.classList.remove('visible'));
document.getElementById('closeBoostHelpButton').addEventListener('click', () => boostHelpModal.classList.remove('visible'));
boostHelpModal.addEventListener('click', (event) => { if (event.target === boostHelpModal) boostHelpModal.classList.remove('visible'); });

const adminRequiredModal = document.getElementById('adminRequiredModal');
const showAdminRequired = () => adminRequiredModal.classList.add('visible');
document.getElementById('closeAdminRequired').addEventListener('click', () => adminRequiredModal.classList.remove('visible'));
document.getElementById('closeAdminRequiredButton').addEventListener('click', () => adminRequiredModal.classList.remove('visible'));
document.getElementById('restartAsAdminButton').addEventListener('click', async () => {
  const result = await window.api.restartAsAdmin();
  if (!result.ok) showFeedback(`Nie udało się uruchomić jako administrator: ${result.error}`);
});
adminRequiredModal.addEventListener('click', (event) => { if (event.target === adminRequiredModal) adminRequiredModal.classList.remove('visible'); });

document.querySelectorAll('[data-profile]').forEach((profile) => {
  profile.addEventListener('click', async () => {
    document.querySelectorAll('[data-profile]').forEach((item) => item.classList.remove('active'));
    profile.classList.add('active');
    if (profile.dataset.profile === 'high' || profile.dataset.profile === 'default') {
      const result = profile.dataset.profile === 'high'
        ? await window.api.highPerfPowerPlan()
        : await window.api.applyBoostOption('highPerf', false);
      document.getElementById('boostProfileStatus').textContent = result.ok
        ? profile.dataset.profile === 'high' ? 'Aktywny: plan wysokiej wydajności Windows.' : 'Aktywny: zrównoważony plan Windows.'
        : `Nie udało się ustawić profilu: ${result.error}`;
      if (!result.ok && /administrator|uprawnień|access is denied|odmowa dostępu|requires elevation/i.test(result.error || '')) showAdminRequired();
    } else {
      document.getElementById('boostProfileStatus').textContent = profile.dataset.profile === 'default' ? 'Wybrano ustawienia domyślne Windows.' : 'Własny profil: uruchamiaj wybrane optymalizacje ręcznie.';
    }
  });
});

document.getElementById('backupBoostBtn').addEventListener('click', async () => {
  const result = await window.api.backupBoostSettings();
  showFeedback(result.ok ? 'Kopia ustawień została zapisana.' : `Błąd: ${result.error}`);
  if (!result.ok && /administrator|uprawnień|access is denied|odmowa dostępu/i.test(result.error || '')) showAdminRequired();
});

document.getElementById('restoreBoostBtn').addEventListener('click', async () => {
  const result = await window.api.restoreBoostSettings();
  showFeedback(result.ok ? 'Ustawienia zostały przywrócone.' : `Błąd: ${result.error}`);
  if (!result.ok && /administrator|uprawnień|access is denied|odmowa dostępu/i.test(result.error || '')) showAdminRequired();
});

document.querySelectorAll('[data-boost-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.boost-tab').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    const ramPanel = document.getElementById('ram-cleaner-panel');
    const systemElements = document.querySelectorAll('.boost-profile-bar, .boost-metrics, .boost-grid, .boost-action-row, #view-boost > .chart-panel');
    const isRam = tab.dataset.boostTab === 'ram';
    ramPanel.hidden = !isRam;
    systemElements.forEach((element) => { element.classList.toggle('boost-section-hidden', isRam); });
  });
});

document.getElementById('cleanRamButton').addEventListener('click', async () => {
  const button = document.getElementById('cleanRamButton');
  button.disabled = true;
  document.getElementById('ramCleanStatus').textContent = 'Czyszczenie pamięci…';
  const result = await window.api.cleanMemory();
  button.disabled = false;
  document.getElementById('ramCleanStatus').textContent = result.ok ? `Gotowe, zwolniono około ${result.freedMB} MB` : 'Nie udało się wyczyścić pamięci';
  if (result.ok) document.getElementById('ramLastCleanup').textContent = `Ostatnie czyszczenie: ${new Date().toLocaleString('pl-PL')}`;
  showFeedback(result.ok ? `RAM wyczyszczony. Zwolniono około ${result.freedMB} MB.` : `Błąd: ${result.error}`);
  refreshSnapshot();
});

document.getElementById('ramAutoSwitch').addEventListener('click', () => {
  const switchElement = document.getElementById('ramAutoSwitch');
  const enabled = switchElement.classList.toggle('on');
  switchElement.setAttribute('aria-checked', String(enabled));
});

refreshSnapshot();
setInterval(() => {
  if (document.getElementById('view-boost').classList.contains('active')) {
    refreshSnapshot();
  }
}, 4000);
setInterval(refreshGameStatuses, 5000);
