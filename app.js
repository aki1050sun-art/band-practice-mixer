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

let selectedSourceFile = null;
let audioCtx = null;
let ortModule = null;
let demucsSession = null;
let backendName = "";
const buffers = new Map();
const gains = new Map();
let currentFiles = new Map();
let sources = [];
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
  for (const source of sources) {
    try { source.stop(); } catch (_) {}
  }
  sources = [];
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

function scheduleStemPlayback(position, when) {
  stopSources();
  for (const def of stemDefs) {
    const buffer = buffers.get(def.key);
    if (!buffer || position >= buffer.duration) continue;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(gains.get(def.key));
    source.start(when, position);
    sources.push(source);
  }
  offset = position;
  startedAt = when;
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
  if (!buffers.size) return;
  ensureAudioGraph();
  await audioCtx.resume();
  stopEverything();

  const startPos = Math.min(Math.max(0, position), duration);
  const bpm = Math.min(300, Math.max(30, Number(bpmInput.value) || 120));
  bpmInput.value = String(bpm);
  const bars = Math.min(2, Math.max(0, Number(countBars.value) || 0));
  const doCount = withCount && startPos < 0.05 && bars > 0;

  if (!doCount) {
    scheduleStemPlayback(startPos, audioCtx.currentTime + 0.05);
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

  scheduleStemPlayback(0, songStart);
  playPause.textContent = "■ カウント停止";
  const endDelay = Math.max(0, (songStart - audioCtx.currentTime) * 1000);
  countTimers.push(setTimeout(() => {
    if (!isCounting) return;
    isCounting = false;
    countDisplay.textContent = "";
    playPause.textContent = "⏸ 一時停止";
  }, endDelay));
}

function currentPosition() {
  if (!isPlaying || !audioCtx) return offset;
  return Math.min(duration, offset + Math.max(0, audioCtx.currentTime - startedAt));
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
  updateTransport();
  if (pos >= duration - 0.03) {
    resetPlayback();
    return;
  }
  rafId = requestAnimationFrame(tick);
}

async function decodeAndLoad(found, title = "") {
  resetPlayback();
  buffers.clear();
  currentFiles = new Map(found);
  mixerSection.hidden = false;
  playPause.disabled = true;
  seek.disabled = true;
  loadStatus.textContent = "6ファイルを読み込み中…";
  if (title) songTitle.value = title;

  try {
    ensureAudioGraph();
    let done = 0;
    for (const def of stemDefs) {
      const file = found.get(def.key);
      loadStatus.textContent = `読み込み中… ${done + 1}/6（${def.label}）`;
      const arrayBuffer = await file.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      buffers.set(def.key, decoded);
      done += 1;
    }
    duration = Math.max(...Array.from(buffers.values()).map(b => b.duration));
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

async function separateOnDevice(file) {
  if (!window.lamejs?.Mp3Encoder) throw new Error("MP3 encoder could not be loaded");
  separateBtn.disabled = true;
  sourceFileInput.disabled = true;
  try {
    const sessionPromise = loadOrtAndModel();
    let sourceBuffer = await decodeSourceTo44100(file);
    const session = await sessionPromise;
    const [left, right] = makeStereoChannels(sourceBuffer);
    const total = left.length;
    const nChunks = Math.max(1, Math.ceil(Math.max(1, total - N_SAMPLES) / STRIDE) + 1);

    const encoders = {};
    const mp3Parts = {};
    for (const def of stemDefs) {
      encoders[def.key] = new lamejs.Mp3Encoder(2, SAMPLE_RATE, MP3_KBPS);
      mp3Parts[def.key] = [];
    }

    setAiProgress(15, `6パート分離を開始します（${nChunks}区間）`);
    const chunkBuf = new Float32Array(2 * N_SAMPLES);

    for (let ci = 0; ci < nChunks; ci++) {
      const start = ci * STRIDE;
      if (start >= total) break;
      const end = Math.min(start + N_SAMPLES, total);
      const clen = end - start;
      chunkBuf.fill(0);
      chunkBuf.subarray(0, clen).set(left.subarray(start, end));
      chunkBuf.subarray(N_SAMPLES, N_SAMPLES + clen).set(right.subarray(start, end));

      const tensor = new ortModule.Tensor("float32", chunkBuf, [1, 2, N_SAMPLES]);
      const result = await session.run({ mix: tensor });
      const stemsTensor = result.stems || result[session.outputNames[0]];
      if (!stemsTensor?.data) throw new Error("AI output not found");
      const stemData = stemsTensor.data;

      const emitFrom = ci === 0 ? 0 : HALF_OVERLAP;
      const emitTo = (ci === nChunks - 1 || end === total)
        ? clen
        : Math.min(clen, N_SAMPLES - HALF_OVERLAP);

      for (const def of stemDefs) {
        const rowBase = def.modelRow * 2 * N_SAMPLES;
        const l16 = floatToInt16(stemData, rowBase + emitFrom, rowBase + emitTo);
        const r16 = floatToInt16(stemData, rowBase + N_SAMPLES + emitFrom, rowBase + N_SAMPLES + emitTo);
        appendMp3(encoders[def.key], l16, r16, mp3Parts[def.key]);
      }

      const pct = 15 + Math.round(((ci + 1) / nChunks) * 75);
      setAiProgress(pct, `AI分離中… ${ci + 1}/${nChunks}（${pct}%）`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    setAiProgress(92, "MP3にまとめています…");
    sourceBuffer = null;
    const found = new Map();
    const base = guessTitle(file.name);
    for (const def of stemDefs) {
      const last = encoders[def.key].flush();
      if (last.length) mp3Parts[def.key].push(new Uint8Array(last));
      const blob = new Blob(mp3Parts[def.key], { type: "audio/mpeg" });
      found.set(def.key, new File([blob], `${def.file}.mp3`, { type: "audio/mpeg" }));
    }

    renderStemStatus(found);
    songTitle.value = base;
    setAiProgress(96, "ミキサーへ読み込み中…");
    await decodeAndLoad(found, base);
    setAiProgress(100, `分離完了（${backendName}）`);
    loadStatus.textContent = `AI分離完了：6パート（MP3 ${MP3_KBPS}kbps）`;
  } finally {
    separateBtn.disabled = !selectedSourceFile;
    sourceFileInput.disabled = false;
  }
}

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
  if (isPlaying) await playFrom(newPos, false);
  else {
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

async function renderSavedSongs() {
  try {
    const songs = await getAllSongs();
    savedSongs.innerHTML = "";
    if (!songs.length) {
      savedSongs.innerHTML = '<span class="note">保存した曲はありません。</span>';
      return;
    }
    songs.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    for (const song of songs) {
      const row = document.createElement("div");
      row.className = "saved-song";
      const meta = document.createElement("div");
      meta.innerHTML = `<strong></strong><small>BPM ${song.bpm}・カウント ${song.countBars === 0 ? "なし" : song.countBars + "小節"}</small>`;
      meta.querySelector("strong").textContent = song.title || "無題";

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.textContent = "読み込む";
      loadBtn.addEventListener("click", async () => {
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
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "danger";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`「${song.title || "無題"}」をこのブラウザから削除しますか？`)) return;
        await deleteSong(song.id);
        await renderSavedSongs();
      });
      row.append(meta, loadBtn, delBtn);
      savedSongs.appendChild(row);
    }
  } catch (err) {
    console.error(err);
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
