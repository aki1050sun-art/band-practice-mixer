const stemDefs = [
  { key: "vocals", label: "ボーカル", file: "vocals", modelRow: 3 },
  { key: "guitar", label: "ギター", file: "guitar", modelRow: 4 },
  { key: "bass", label: "ベース", file: "bass", modelRow: 1 },
  { key: "drums", label: "ドラム", file: "drums", modelRow: 0 },
  { key: "piano", label: "キーボード", file: "piano", modelRow: 5 },
  { key: "other", label: "その他", file: "other", modelRow: 2 }
];

const MODEL_URL = "https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx/resolve/main/htdemucs_6s.onnx";
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";
const ORT_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const SAMPLE_RATE = 44100;
const N_SAMPLES = Math.round(7.8 * SAMPLE_RATE);
const OVERLAP = Math.floor(N_SAMPLES / 4);
const HALF_OVERLAP = Math.floor(OVERLAP / 2);
const STRIDE = N_SAMPLES - OVERLAP;
const MP3_KBPS = 192;

const songPackInput = document.querySelector("#songPack");
const packStatus = document.querySelector("#packStatus");
const sourceFileInput = document.querySelector("#sourceFile");
const sourceInfo = document.querySelector("#sourceInfo");
const separateBtn = document.querySelector("#separateBtn");
const aiProgress = document.querySelector("#aiProgress");
const aiStatus = document.querySelector("#aiStatus");
const backendInfo = document.querySelector("#backendInfo");
const fileInput = document.querySelector("#stemFiles");
const loadStatus = document.querySelector("#loadStatus");
const stemStatus = document.querySelector("#stemStatus");
const mixerSection = document.querySelector("#mixerSection");
const mixers = document.querySelector("#mixers");
const playPause = document.querySelector("#playPause");
const seek = document.querySelector("#seek");
const timeEl = document.querySelector("#time");
const songTitle = document.querySelector("#songTitle");
const bpmInput = document.querySelector("#bpm");
const countBars = document.querySelector("#countBars");
const countDisplay = document.querySelector("#countDisplay");
const saveSongBtn = document.querySelector("#saveSong");
const saveStatus = document.querySelector("#saveStatus");
const savedSongs = document.querySelector("#savedSongs");
const savedCount = document.querySelector("#savedCount");

let selectedSourceFile = null;
let audioCtx = null;
let ortModule = null;
let demucsSession = null;
let backendName = "";
const gains = new Map();
const mediaEls = new Map();
const mediaSources = new Map();
const objectUrls = new Map();
let currentFiles = new Map();
let clickNodes = [];
let isPlaying = false;
let isCounting = false;
let offset = 0;
let startedAt = 0;
let duration = 0;
let rafId = null;
let countTimers = [];
const volumeValues = new Map(stemDefs.map(d => [d.key, 100]));

function formatTime(sec) {
  if (!Number.isFinite(sec)) return "0:00";
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function guessTitle(name) {
  return name.replace(/\.(mp3|wav)$/i, "");
}

function setAiProgress(value, message) {
  aiProgress.value = Math.max(0, Math.min(100, value));
  aiStatus.textContent = message;
}

function renderStemStatus(found = new Map()) {
  stemStatus.innerHTML = "";
  for (const def of stemDefs) {
    const div = document.createElement("div");
    const file = found.get(def.key);
    div.className = "stem-chip" + (file ? " ok" : "");
    div.textContent = file ? `✓ ${def.label}: ${file.name}` : `○ ${def.label}: 未選択`;
    stemStatus.appendChild(div);
  }
}

function buildMixer() {
  mixers.innerHTML = "";
  for (const def of stemDefs) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = def.label;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(volumeValues.get(def.key) ?? 100);
    slider.dataset.stem = def.key;
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = `${slider.value}%`;
    slider.addEventListener("input", () => {
      const n = Number(slider.value);
      volumeValues.set(def.key, n);
      value.textContent = `${n}%`;
      const gain = gains.get(def.key);
      if (gain) gain.gain.value = n / 100;
    });
    row.append(label, slider, value);
    mixers.appendChild(row);
  }
}

function ensureAudioGraph() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  for (const def of stemDefs) {
    if (!gains.has(def.key)) {
      const gain = audioCtx.createGain();
      gain.gain.value = (volumeValues.get(def.key) ?? 100) / 100;
      gain.connect(audioCtx.destination);
      gains.set(def.key, gain);
    }
  }
}

function stopSources() {
  for (const audio of mediaEls.values()) {
    try { audio.pause(); } catch (_) {}
  }
}

function stopCountIn() {
  isCounting = false;
  for (const t of countTimers) clearTimeout(t);
  countTimers = [];
  for (const node of clickNodes) {
    try { node.stop(); } catch (_) {}
  }
  clickNodes = [];
  countDisplay.textContent = "";
}

function stopEverything() {
  stopCountIn();
  stopSources();
}

async function scheduleStemPlayback(position) {
  stopSources();
  const startPos = Math.min(Math.max(0, position), duration);
  for (const audio of mediaEls.values()) {
    try { audio.currentTime = Math.min(startPos, Math.max(0, (audio.duration || duration) - 0.02)); } catch (_) {}
  }
  await Promise.all(Array.from(mediaEls.values()).map(a => a.play().catch(err => { throw err; })));
  offset = startPos;
  startedAt = performance.now() / 1000;
  isPlaying = true;
  playPause.textContent = "⏸ 一時停止";
  tick();
}

function scheduleClick(when, accent) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = accent ? 1320 : 880;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.30 : 0.20, when + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(when);
  osc.stop(when + 0.08);
  clickNodes.push(osc);
}

async function playFrom(position, withCount = false) {
  if (!mediaEls.size) return;
  ensureAudioGraph();
  await audioCtx.resume();
  stopEverything();

  const startPos = Math.min(Math.max(0, position), duration);
  const bpm = Math.min(300, Math.max(30, Number(bpmInput.value) || 120));
  bpmInput.value = String(bpm);
  const bars = Math.min(2, Math.max(0, Number(countBars.value) || 0));
  const doCount = withCount && startPos < 0.05 && bars > 0;

  if (!doCount) {
    await scheduleStemPlayback(startPos);
    return;
  }

  const beatSec = 60 / bpm;
  const beats = bars * 4;
  const countStart = audioCtx.currentTime + 0.12;
  const songStart = countStart + beats * beatSec;
  isCounting = true;
  playPause.textContent = "■ カウント停止";

  for (let i = 0; i < beats; i++) {
    const beatInBar = i % 4;
    const when = countStart + i * beatSec;
    scheduleClick(when, beatInBar === 0);
    const delay = Math.max(0, (when - audioCtx.currentTime) * 1000);
    countTimers.push(setTimeout(() => {
      if (isCounting) countDisplay.textContent = String(beatInBar + 1);
    }, delay));
  }

  const endDelay = Math.max(0, (songStart - audioCtx.currentTime) * 1000);
  countTimers.push(setTimeout(async () => {
    if (!isCounting) return;
    isCounting = false;
    countDisplay.textContent = "";
    try {
      await scheduleStemPlayback(0);
    } catch (err) {
      console.error(err);
      playPause.textContent = "▶ 再生";
    }
  }, endDelay));
}

function currentPosition() {
  if (!isPlaying) return offset;
  const master = mediaEls.get("drums") || mediaEls.values().next().value;
  if (master && Number.isFinite(master.currentTime)) return Math.min(duration, master.currentTime);
  return Math.min(duration, offset + Math.max(0, performance.now() / 1000 - startedAt));
}

function pausePlayback() {
  if (isCounting) {
    stopEverything();
    isPlaying = false;
    offset = 0;
    playPause.textContent = "▶ 再生";
    if (rafId) cancelAnimationFrame(rafId);
    updateTransport();
    return;
  }
  offset = currentPosition();
  isPlaying = false;
  stopSources();
  playPause.textContent = "▶ 再生";
  if (rafId) cancelAnimationFrame(rafId);
  updateTransport();
}

function resetPlayback() {
  isPlaying = false;
  stopEverything();
  offset = 0;
  playPause.textContent = "▶ 再生";
  if (rafId) cancelAnimationFrame(rafId);
  updateTransport();
}

function updateTransport() {
  const pos = currentPosition();
  seek.value = duration ? Math.round((pos / duration) * 1000) : 0;
  timeEl.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
}

function tick() {
  if (!isPlaying) return;
  const pos = currentPosition();
  const master = mediaEls.get("drums") || mediaEls.values().next().value;
  if (master) {
    for (const audio of mediaEls.values()) {
      if (audio !== master && Math.abs(audio.currentTime - master.currentTime) > 0.05) {
        try { audio.currentTime = master.currentTime; } catch (_) {}
      }
    }
  }
  updateTransport();
  if (pos >= duration - 0.03) {
    resetPlayback();
    return;
  }
  rafId = requestAnimationFrame(tick);
}

async function decodeAndLoad(found, title = "") {
  resetPlayback();
  currentFiles = new Map(found);
  mixerSection.hidden = false;
  playPause.disabled = true;
  seek.disabled = true;
  loadStatus.textContent = "6ファイルを読み込み中…";
  if (title) songTitle.value = title;

  try {
    ensureAudioGraph();

    // Release previous blob URLs/media.
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
    mediaEls.clear();

    let done = 0;
    let maxDuration = 0;
    for (const def of stemDefs) {
      const file = found.get(def.key);
      loadStatus.textContent = `読み込み中… ${done + 1}/6（${def.label}）`;
      const url = URL.createObjectURL(file);
      objectUrls.set(def.key, url);
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      audio.playsInline = true;

      await new Promise((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const ng = () => { cleanup(); reject(new Error(def.label + "の音源を読み込めません")); };
        const cleanup = () => {
          audio.removeEventListener("loadedmetadata", ok);
          audio.removeEventListener("error", ng);
        };
        audio.addEventListener("loadedmetadata", ok, { once: true });
        audio.addEventListener("error", ng, { once: true });
        audio.load();
      });

      maxDuration = Math.max(maxDuration, audio.duration || 0);
      mediaEls.set(def.key, audio);

      if (!mediaSources.has(def.key)) {
        const src = audioCtx.createMediaElementSource(audio);
        src.connect(gains.get(def.key));
        mediaSources.set(def.key, src);
      } else {
        // createMediaElementSource cannot be reused with a new element.
        // Replace the connection record with the new element source.
        const src = audioCtx.createMediaElementSource(audio);
        src.connect(gains.get(def.key));
        mediaSources.set(def.key, src);
      }
      done += 1;
    }

    duration = maxDuration;
    offset = 0;
    updateTransport();
    buildMixer();
    loadStatus.textContent = `準備完了：6パート読み込み済み（${formatTime(duration)}）`;
    playPause.disabled = false;
    seek.disabled = false;
  } catch (err) {
    console.error(err);
    loadStatus.textContent = "読み込みに失敗しました。音源ファイルを確認してください。";
    playPause.disabled = true;
    seek.disabled = true;
    throw err;
  }
}

async function loadOrtAndModel() {
  if (demucsSession) return demucsSession;
  setAiProgress(4, "AI実行環境を読み込み中…");
  if (!ortModule) {
    ortModule = await import(ORT_URL);
    ortModule.env.wasm.wasmPaths = ORT_WASM_PATH;
    ortModule.env.wasm.numThreads = 1;
  }

  if (!("gpu" in navigator)) {
    throw new Error("このブラウザではWebGPUを利用できません。AndroidのChrome最新版で開いてください。");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPUアダプターを取得できません。AndroidのChrome最新版で開いてください。");
  }
  backendName = "WebGPU";
  backendInfo.textContent = "AI処理: WebGPU";
  setAiProgress(8, "WebGPU対応AIモデルを読み込み中… 初回は約285MBです");
  demucsSession = await ortModule.InferenceSession.create(MODEL_URL, {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "all"
  });
  return demucsSession;
}

async function decodeSourceTo44100(file) {
  ensureAudioGraph();
  await audioCtx.resume();
  setAiProgress(10, "元の曲を読み込み中…");
  const arr = await file.arrayBuffer();
  let decoded = await audioCtx.decodeAudioData(arr);
  if (decoded.sampleRate === SAMPLE_RATE && decoded.numberOfChannels >= 2) return decoded;

  setAiProgress(12, "44.1kHzへ変換中…");
  const outLength = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(2, outLength, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  decoded = await offline.startRendering();
  return decoded;
}

function makeStereoChannels(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return [left, right];
}

function floatToInt16(src, from, to) {
  const out = new Int16Array(to - from);
  for (let i = from, j = 0; i < to; i++, j++) {
    const x = Math.max(-1, Math.min(1, src[i] || 0));
    out[j] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
  }
  return out;
}

function appendMp3(encoder, left, right, parts) {
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const mp3buf = encoder.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
    if (mp3buf.length) parts.push(new Uint8Array(mp3buf));
  }
}

async function encodePlanarMp3(planar, sampleRate = 44100, kbps = 192) {
  const N = Math.floor(planar.length / 2);
  const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps);
  const parts = [];
  const block = 1152;
  for (let from = 0; from < N; from += block) {
    const to = Math.min(N, from + block);
    const l16 = new Int16Array(to - from);
    const r16 = new Int16Array(to - from);
    for (let i = from, j = 0; i < to; i++, j++) {
      const l = Math.max(-1, Math.min(1, planar[i] || 0));
      const r = Math.max(-1, Math.min(1, planar[N + i] || 0));
      l16[j] = l < 0 ? Math.round(l * 32768) : Math.round(l * 32767);
      r16[j] = r < 0 ? Math.round(r * 32768) : Math.round(r * 32767);
    }
    const b = enc.encodeBuffer(l16, r16);
    if (b.length) parts.push(new Uint8Array(b));
    if ((from / block) % 32 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts, { type: "audio/mpeg" });
}

async function separateOnDevice(file) {
  if (!window.lamejs?.Mp3Encoder) throw new Error("MP3 encoder could not be loaded");
  separateBtn.disabled = true;
  sourceFileInput.disabled = true;
  try {
    setAiProgress(1, "高速分離エンジンを準備中…");
    const { separateFast } = await import("./fast-separator.js?v=2");
    const result = await separateFast(file, p => {
      if (p.phase === "model") {
        setAiProgress(Math.max(2, Math.round((p.fraction || 0) * 10)), p.text);
      } else if (p.phase === "session" || p.phase === "decode") {
        setAiProgress(12, p.text);
      } else if (p.phase === "separate") {
        setAiProgress(15 + Math.round((p.fraction || 0) * 70), p.text);
      }
    });

    backendName = result.backend;
    backendInfo.textContent = "AI処理: 高速6分離 / " + backendName;
    setAiProgress(87, "分離結果をMP3に変換中…");

    const found = new Map();
    const base = guessTitle(file.name);
    for (let i = 0; i < stemDefs.length; i++) {
      const def = stemDefs[i];
      const planar = result.stems[def.file];
      if (!planar) throw new Error(def.file + " の分離結果がありません");
      const blob = await encodePlanarMp3(planar, result.sampleRate, MP3_KBPS);
      found.set(def.key, new File([blob], def.file + ".mp3", { type: "audio/mpeg" }));
      setAiProgress(87 + Math.round(((i + 1) / stemDefs.length) * 8), "MP3変換中… " + (i + 1) + "/6");
    }

    renderStemStatus(found);
    songTitle.value = base;
    setAiProgress(96, "ミキサーへ読み込み中…");
    await decodeAndLoad(found, base);
    setAiProgress(100, "分離完了（高速モード）");
    loadStatus.textContent = "AI分離完了：6パート（MP3 " + MP3_KBPS + "kbps）";

    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
      const stems = {};
      for (const def of stemDefs) {
        const f = found.get(def.key);
        stems[def.key] = { blob: f, name: f.name, type: f.type };
      }
      const volumes = Object.fromEntries(stemDefs.map(d => [d.key, volumeValues.get(d.key) ?? 100]));
      await putSong({
        title: base,
        bpm: Math.min(300, Math.max(30, Number(bpmInput.value) || 120)),
        countBars: Math.min(2, Math.max(0, Number(countBars.value) || 0)),
        stems,
        volumes,
        savedAt: Date.now(),
        autoSaved: true
      });
      saveStatus.textContent = "分離結果を自動保存しました。";
      await renderSavedSongs();
    } catch (saveErr) {
      console.error(saveErr);
      saveStatus.textContent = "自動保存できませんでした。ブラウザの保存容量を確認してください。";
    }
  } finally {
    separateBtn.disabled = !selectedSourceFile;
    sourceFileInput.disabled = false;
  }
}


async function importSongPack(file) {
  if (!window.JSZip) throw new Error("ZIP読込機能を読み込めません");
  packStatus.textContent = "曲パックを読み込み中…";
  const zip = await JSZip.loadAsync(file);
  const found = new Map();

  let meta = {};
  const metaEntry = Object.values(zip.files).find(x => !x.dir && /(^|\/)metadata\.json$/i.test(x.name));
  if (metaEntry) {
    try { meta = JSON.parse(await metaEntry.async("text")); } catch (_) {}
  }

  for (const def of stemDefs) {
    const entry = Object.values(zip.files).find(x =>
      !x.dir && new RegExp("(^|/)"+def.file+"\\.(mp3|wav)$","i").test(x.name)
    );
    if (!entry) throw new Error(def.label + " がZIP内にありません");
    const ext = entry.name.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
    const type = ext === "wav" ? "audio/wav" : "audio/mpeg";
    const blob = await entry.async("blob");
    found.set(def.key, new File([blob], def.file + "." + ext, { type }));
  }

  const fallbackTitle = file.name.replace(/\.zip$/i, "");
  const title = meta.title || fallbackTitle;
  songTitle.value = title;
  bpmInput.value = String(meta.bpm || 120);
  countBars.value = String(meta.countBars ?? 1);
  renderStemStatus(found);
  await decodeAndLoad(found, title);

  const stems = {};
  for (const def of stemDefs) {
    const f = found.get(def.key);
    stems[def.key] = { blob: f, name: f.name, type: f.type };
  }
  const volumes = Object.fromEntries(stemDefs.map(d => [d.key, 100]));
  await putSong({
    title,
    bpm: Number(bpmInput.value) || 120,
    countBars: Number(countBars.value) || 0,
    stems,
    volumes,
    savedAt: Date.now(),
    importedPack: true
  });
  await renderSavedSongs();
  packStatus.textContent = "読み込み・保存完了。下の「保存した曲」に追加しました。";
}

songPackInput.addEventListener("change", async () => {
  const file = songPackInput.files?.[0];
  if (!file) return;
  try {
    await importSongPack(file);
  } catch (err) {
    console.error(err);
    packStatus.textContent = "曲パックを読み込めませんでした：" + String(err?.message || err);
  }
});

function syncSelectedSource() {
  selectedSourceFile = sourceFileInput.files?.[0] || null;
  aiProgress.value = 0;
  aiStatus.textContent = "待機中";
  if (!selectedSourceFile) {
    sourceInfo.textContent = "未選択";
    separateBtn.disabled = true;
    return false;
  }
  const ok = /\.(mp3|wav)$/i.test(selectedSourceFile.name) ||
    ["audio/mpeg", "audio/wav", "audio/x-wav"].includes(selectedSourceFile.type);
  if (!ok) {
    sourceInfo.textContent = "MP3またはWAVを選択してください。";
    selectedSourceFile = null;
    separateBtn.disabled = true;
    return false;
  }
  sourceInfo.textContent = `${selectedSourceFile.name}（${(selectedSourceFile.size / 1024 / 1024).toFixed(1)}MB）`;
  songTitle.value = guessTitle(selectedSourceFile.name);
  separateBtn.disabled = false;
  return true;
}

sourceFileInput.addEventListener("change", syncSelectedSource);

separateBtn.addEventListener("click", async () => {
  // Android/Edge may visually retain the chosen filename after a page reload
  // even though the in-memory JS variable was reset. Read the file input again here.
  if (!selectedSourceFile && !syncSelectedSource()) {
    sourceInfo.textContent = "もう一度「ファイルの選択」から曲を選んでください。";
    return;
  }
  try {
    await separateOnDevice(selectedSourceFile);
  } catch (err) {
    console.error(err);
    setAiProgress(0, "AI分離に失敗しました。");
    const msg = String(err?.message || err);
    backendInfo.textContent = `エラー: ${msg.slice(0, 180)}`;
  }
});

function detectFiles(files) {
  const found = new Map();
  for (const file of files) {
    const lower = file.name.toLowerCase();
    for (const def of stemDefs) {
      if (lower.startsWith(def.file + ".") || lower === def.file) found.set(def.key, file);
    }
  }
  return found;
}

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  const found = detectFiles(files);
  renderStemStatus(found);
  const missing = stemDefs.filter(d => !found.has(d.key));
  if (missing.length) {
    loadStatus.textContent = `6ファイル中 ${6 - missing.length}個を認識。未認識: ${missing.map(x => x.label).join("、")}`;
    return;
  }
  await decodeAndLoad(found, songTitle.value);
});

playPause.addEventListener("click", async () => {
  if (isPlaying || isCounting) pausePlayback();
  else {
    if (offset >= duration) offset = 0;
    await playFrom(offset, offset < 0.05);
  }
});

seek.addEventListener("input", () => {
  if (!duration) return;
  const newPos = (Number(seek.value) / 1000) * duration;
  offset = newPos;
  timeEl.textContent = `${formatTime(newPos)} / ${formatTime(duration)}`;
});

seek.addEventListener("change", async () => {
  if (!duration) return;
  const newPos = (Number(seek.value) / 1000) * duration;
  if (isPlaying) {
    stopSources();
    isPlaying = false;
    await playFrom(newPos, false);
  } else {
    for (const audio of mediaEls.values()) {
      try { audio.currentTime = newPos; } catch (_) {}
    }
    offset = newPos;
    updateTransport();
  }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("BandPracticeMixerDB", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllSongs() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("songs", "readonly").objectStore("songs").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putSong(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("songs", "readwrite").objectStore("songs").put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteSong(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("songs", "readwrite").objectStore("songs").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}


function sanitizeFileName(name) {
  return String(name || "song")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "song";
}

async function exportSongZip(song) {
  if (!window.JSZip) throw new Error("ZIP作成機能を読み込めません");
  const zip = new JSZip();

  for (const def of stemDefs) {
    const item = song.stems?.[def.key];
    if (!item?.blob) throw new Error(def.label + " の保存データがありません");
    const ext = (item.name || "").toLowerCase().endsWith(".wav") ? "wav" : "mp3";
    zip.file(def.file + "." + ext, item.blob);
  }

  const metadata = {
    title: song.title || "無題",
    bpm: Number(song.bpm) || 120,
    countBars: Number.isFinite(Number(song.countBars)) ? Number(song.countBars) : 1
  };
  zip.file("metadata.json", JSON.stringify(metadata, null, 2));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeFileName(song.title || "song") + "_bandmix.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function renderSavedSongs() {
  try {
    const songs = await getAllSongs();
    savedSongs.innerHTML = "";
    if (savedCount) savedCount.textContent = songs.length + "曲";
    if (!songs.length) {
      savedSongs.innerHTML = '<div class="empty-saved">保存した曲はありません。</div>';
      return;
    }

    songs.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    for (const song of songs) {
      const card = document.createElement("article");
      card.className = "saved-card";

      const head = document.createElement("div");
      head.className = "saved-card-head";

      const titleWrap = document.createElement("div");
      titleWrap.className = "saved-card-title";
      const title = document.createElement("strong");
      title.textContent = song.title || "無題";
      titleWrap.appendChild(title);

      const badges = document.createElement("div");
      badges.className = "saved-badges";
      const bpmBadge = document.createElement("span");
      bpmBadge.className = "badge";
      bpmBadge.textContent = "BPM " + (song.bpm || 120);
      const countBadge = document.createElement("span");
      countBadge.className = "badge";
      countBadge.textContent = song.countBars === 0 ? "カウントなし" : "カウント " + (song.countBars || 1) + "小節";
      badges.append(bpmBadge, countBadge);

      if (song.savedAt) {
        const date = document.createElement("span");
        date.className = "saved-date";
        const d = new Date(song.savedAt);
        date.textContent = d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) + "保存";
        badges.appendChild(date);
      }

      titleWrap.appendChild(badges);

      const actions = document.createElement("div");
      actions.className = "saved-actions";

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "primary";
      loadBtn.textContent = "▶ 開く";
      loadBtn.addEventListener("click", async () => {
        loadBtn.disabled = true;
        loadBtn.textContent = "読み込み中…";
        try {
          const found = new Map();
          for (const def of stemDefs) {
            const item = song.stems[def.key];
            found.set(def.key, new File([item.blob], item.name, { type: item.type || "audio/mpeg" }));
          }
          renderStemStatus(found);
          songTitle.value = song.title || "";
          bpmInput.value = String(song.bpm || 120);
          countBars.value = String(song.countBars ?? 1);
          for (const def of stemDefs) volumeValues.set(def.key, song.volumes?.[def.key] ?? 100);
          await decodeAndLoad(found, song.title || "");
          mixerSection.scrollIntoView({ behavior: "smooth", block: "start" });
        } finally {
          loadBtn.disabled = false;
          loadBtn.textContent = "▶ 開く";
        }
      });

      const exportBtn = document.createElement("button");
      exportBtn.type = "button";
      exportBtn.className = "secondary";
      exportBtn.textContent = "ZIPを書き出す";
      exportBtn.addEventListener("click", async () => {
        exportBtn.disabled = true;
        const originalText = exportBtn.textContent;
        exportBtn.textContent = "作成中…";
        try {
          await exportSongZip(song);
        } catch (err) {
          console.error(err);
          alert("ZIPを書き出せませんでした：" + String(err?.message || err));
        } finally {
          exportBtn.disabled = false;
          exportBtn.textContent = originalText;
        }
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "danger subtle";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`「${song.title || "無題"}」をこのブラウザから削除しますか？`)) return;
        await deleteSong(song.id);
        await renderSavedSongs();
      });

      actions.append(loadBtn, exportBtn, delBtn);
      head.append(titleWrap, actions);
      card.appendChild(head);
      savedSongs.appendChild(card);
    }
  } catch (err) {
    console.error(err);
    if (savedCount) savedCount.textContent = "";
    savedSongs.innerHTML = '<span class="note">保存曲の一覧を読み込めませんでした。</span>';
  }
}

saveSongBtn.addEventListener("click", async () => {
  if (currentFiles.size !== 6) {
    saveStatus.textContent = "先に6パートを準備してください。";
    return;
  }
  const title = songTitle.value.trim() || "無題";
  const bpm = Math.min(300, Math.max(30, Number(bpmInput.value) || 120));
  const bars = Math.min(2, Math.max(0, Number(countBars.value) || 0));
  const stems = {};
  for (const def of stemDefs) {
    const file = currentFiles.get(def.key);
    stems[def.key] = { blob: file, name: file.name, type: file.type };
  }
  const volumes = Object.fromEntries(stemDefs.map(d => [d.key, volumeValues.get(d.key) ?? 100]));
  saveSongBtn.disabled = true;
  saveStatus.textContent = "保存中…";
  try {
    await putSong({ title, bpm, countBars: bars, stems, volumes, savedAt: Date.now() });
    saveStatus.textContent = "保存しました。次回は「保存した曲」から読み込めます。";
    await renderSavedSongs();
  } catch (err) {
    console.error(err);
    saveStatus.textContent = "保存できませんでした。ブラウザの保存容量を確認してください。";
  } finally {
    saveSongBtn.disabled = false;
  }
});

async function detectBackend() {
  if ("gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        backendInfo.textContent = "WebGPUを利用できます。Android端末内で6分離を試せます。";
        return;
      }
    } catch (_) {}
  }
  backendInfo.textContent = "WebGPUを利用できません。AndroidのChrome最新版で開いてください。";
}

buildMixer();
renderStemStatus();
renderSavedSongs();
detectBackend();


window.addEventListener("pageshow", () => {
  if (sourceFileInput.files && sourceFileInput.files.length) syncSelectedSource();
});
