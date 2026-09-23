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

let audioCtx = null;
const buffers = new Map();
const gains = new Map();
let sources = [];
let isPlaying = false;
let offset = 0;
let startedAt = 0;
let duration = 0;
let rafId = null;

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
    slider.value = "100";
    slider.dataset.stem = def.key;

    const value = document.createElement("span");
    value.className = "value";
    value.textContent = "100%";

    slider.addEventListener("input", () => {
      value.textContent = `${slider.value}%`;
      const gain = gains.get(def.key);
      if (gain) gain.gain.value = Number(slider.value) / 100;
    });

    row.append(label, slider, value);
    mixers.appendChild(row);
  }
}

function ensureAudioGraph() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  for (const def of stemDefs) {
    if (!gains.has(def.key)) {
      const gain = audioCtx.createGain();
      gain.gain.value = 1;
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

async function playFrom(position) {
  if (!buffers.size) return;
  ensureAudioGraph();
  await audioCtx.resume();
  stopSources();

  const startPos = Math.min(Math.max(0, position), duration);
  const when = audioCtx.currentTime + 0.05;

  for (const def of stemDefs) {
    const buffer = buffers.get(def.key);
    if (!buffer || startPos >= buffer.duration) continue;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(gains.get(def.key));
    source.start(when, startPos);
    sources.push(source);
  }

  offset = startPos;
  startedAt = when;
  isPlaying = true;
  playPause.textContent = "⏸ 一時停止";
  tick();
}

function currentPosition() {
  if (!isPlaying || !audioCtx) return offset;
  return Math.min(duration, offset + Math.max(0, audioCtx.currentTime - startedAt));
}

function pausePlayback() {
  offset = currentPosition();
  isPlaying = false;
  stopSources();
  playPause.textContent = "▶ 再生";
  if (rafId) cancelAnimationFrame(rafId);
  updateTransport();
}

function resetPlayback() {
  isPlaying = false;
  stopSources();
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

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;

  const found = new Map();
  for (const file of files) {
    const lower = file.name.toLowerCase();
    for (const def of stemDefs) {
      if (lower.startsWith(def.file + ".") || lower === def.file) {
        found.set(def.key, file);
      }
    }
  }

  renderStemStatus(found);
  const missing = stemDefs.filter(d => !found.has(d.key));

  if (missing.length) {
    loadStatus.textContent = `6ファイル中 ${6 - missing.length}個を認識しました。未認識: ${missing.map(x => x.label).join("、")}`;
    mixerSection.hidden = true;
    playPause.disabled = true;
    seek.disabled = true;
    return;
  }

  resetPlayback();
  buffers.clear();
  mixerSection.hidden = false;
  playPause.disabled = true;
  seek.disabled = true;
  loadStatus.textContent = "6ファイルを読み込み中…";

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
    loadStatus.textContent = `準備完了：6パート読み込み済み（${formatTime(duration)}）`;
    playPause.disabled = false;
    seek.disabled = false;
  } catch (err) {
    console.error(err);
    loadStatus.textContent = "読み込みに失敗しました。WAV/MP3ファイルを確認してください。";
    playPause.disabled = true;
    seek.disabled = true;
  }
});

playPause.addEventListener("click", async () => {
  if (isPlaying) {
    pausePlayback();
  } else {
    if (offset >= duration) offset = 0;
    await playFrom(offset);
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
    await playFrom(newPos);
  } else {
    offset = newPos;
    updateTransport();
  }
});

buildMixer();
renderStemStatus();
