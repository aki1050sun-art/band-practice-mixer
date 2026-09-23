const stemDefs = [
  { key: "vocals", label: "ボーカル", file: "vocals" },
  { key: "guitar", label: "ギター", file: "guitar" },
  { key: "bass", label: "ベース", file: "bass" },
  { key: "drums", label: "ドラム", file: "drums" },
  { key: "piano", label: "キーボード", file: "piano" },
  { key: "other", label: "その他", file: "other" }
];

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

let audioCtx = null;
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

  const endDelay = Math.max(0, (songStart - audioCtx.currentTime) * 1000);
  countTimers.push(setTimeout(() => {
    if (!isCounting) return;
    isCounting = false;
    countDisplay.textContent = "";
    scheduleStemPlayback(0, songStart);
  }, endDelay));
}

function currentPosition() {
  if (!isPlaying || !audioCtx) return offset;
  return Math.min(duration, offset + Math.max(0, audioCtx.currentTime - startedAt));
}

function pausePlayback() {
  if (isCounting) {
    stopCountIn();
    playPause.textContent = "▶ 再生";
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
    loadStatus.textContent = "読み込みに失敗しました。WAV/MP3ファイルを確認してください。";
    playPause.disabled = true;
    seek.disabled = true;
  }
}

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
    loadStatus.textContent = `6ファイル中 ${6 - missing.length}個を認識しました。未認識: ${missing.map(x => x.label).join("、")}`;
    mixerSection.hidden = true;
    playPause.disabled = true;
    seek.disabled = true;
    return;
  }

  const parentGuess = files[0].webkitRelativePath ? files[0].webkitRelativePath.split("/")[0] : "";
  if (!songTitle.value) songTitle.value = parentGuess;
  await decodeAndLoad(found, songTitle.value);
});

playPause.addEventListener("click", async () => {
  if (isPlaying || isCounting) {
    pausePlayback();
  } else {
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
    await playFrom(newPos, false);
  } else {
    offset = newPos;
    updateTransport();
  }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("BandPracticeMixerDB", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("songs")) {
        db.createObjectStore("songs", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllSongs() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("songs", "readonly");
    const req = tx.objectStore("songs").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putSong(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("songs", "readwrite");
    const req = tx.objectStore("songs").put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteSong(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("songs", "readwrite");
    const req = tx.objectStore("songs").delete(id);
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
        loadStatus.textContent = "保存曲を読み込み中…";
        const found = new Map();
        for (const def of stemDefs) {
          const item = song.stems[def.key];
          const file = new File([item.blob], item.name, { type: item.type || "audio/wav" });
          found.set(def.key, file);
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
    saveStatus.textContent = "先に6パートを読み込んでください。";
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
  saveStatus.textContent = "保存中…（WAVは容量が大きいため少し時間がかかることがあります）";
  try {
    await putSong({ title, bpm, countBars: bars, stems, volumes, savedAt: Date.now() });
    saveStatus.textContent = "保存しました。次回は「保存した曲」から読み込めます。";
    await renderSavedSongs();
  } catch (err) {
    console.error(err);
    saveStatus.textContent = "保存できませんでした。ブラウザの保存容量が不足している可能性があります。";
  } finally {
    saveSongBtn.disabled = false;
  }
});

buildMixer();
renderStemStatus();
renderSavedSongs();
