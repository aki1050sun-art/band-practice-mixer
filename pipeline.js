/**
 * End-to-end stem-separation pipeline.
 *
 * separateStems({
 *   audio: { left: Float32Array, right: Float32Array },
 *   session: ort.InferenceSession,
 *   onProgress: ({ segment, totalSegments, inferMs, etaSec }) => void,
 *   overlapFrac?: 0..0.5,
 *   numWorkers?: 1..N,
 * }) -> Promise<{ [stemName]: Float32Array (planar L0..LN, R0..RN) }>
 *
 * Each chunk runs:  STFT (worker) → ONNX (GPU) → iSTFT (worker)
 * with chunk N's STFT and chunk N-1's iSTFT pipelined behind chunk N's GPU run,
 * so the only wall-clock cost is GPU inference itself.
 */

// Tied to the BS-Roformer-SW checkpoint and the ONNX trace size
// (176400 samples = 4 s @ 44.1 kHz, T=345).
const CHUNK_SAMPLES = 176400;
const N_FFT = 2048;
const HOP_LENGTH = 512;
const WIN_LENGTH = 2048;
const NUM_CHANNELS = 2;
export const STEM_NAMES = ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'];
const NUM_STEMS = STEM_NAMES.length;

/** Spawn N workers and return a queryable handle. */
function spawnWorkerPool(n) {
  const workers = Array.from({ length: n }, () => new Worker('./stft-worker.js', { type: 'module' }));
  const pending = new Map();
  let nextId = 1;
  for (const w of workers) {
    w.addEventListener('message', e => {
      const cb = pending.get(e.data.id);
      if (cb) { pending.delete(e.data.id); cb(e.data); }
    });
  }
  function send(workerIdx, type, payload, transfer) {
    const id = nextId++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      workers[workerIdx].postMessage({ id, type, ...payload }, transfer);
    });
  }
  return {
    n,
    send,
    terminate: () => { for (const w of workers) w.terminate(); },
  };
}

/**
 * Crossfade ramps for the overlap region. Sum fadeIn[k] + fadeOut[k] = 1 so
 * overlapped regions reconstruct exactly.
 */
function makeFades(overlap) {
  const fadeIn = new Float32Array(overlap);
  const fadeOut = new Float32Array(overlap);
  for (let i = 0; i < overlap; i++) {
    fadeIn[i] = i / overlap;
    fadeOut[i] = 1 - i / overlap;
  }
  return { fadeIn, fadeOut };
}

export async function separateStems({ audio, session, ortRuntime, onProgress, overlapFrac = 0.25, numWorkers = 2 }) {
  const N = audio.left.length;
  const OVERLAP = Math.floor(CHUNK_SAMPLES * overlapFrac);
  const STEP = CHUNK_SAMPLES - OVERLAP;
  const numSegments = Math.max(1, Math.ceil((N - OVERLAP) / STEP));

  const stems = Object.fromEntries(STEM_NAMES.map(n => [n, new Float32Array(2 * N)]));
  const { fadeIn, fadeOut } = makeFades(OVERLAP);
  const pool = spawnWorkerPool(numWorkers);

  // STFT goes through a round-robin across workers; iSTFT is split by stem
  // chunks (so all workers run iSTFT in parallel during the GPU's next call).
  let stftWorkerIdx = 0;
  const postStft = planarTA => {
    const w = stftWorkerIdx++ % pool.n;
    return pool.send(w, 'stft', {
      planarBuf: planarTA.buffer,
      nFft: N_FFT, hopLength: HOP_LENGTH, winLength: WIN_LENGTH,
    }, [planarTA.buffer]);
  };
  const postIstftBatch = (realArr, imagArr, F, T, segIdx, segStart, segLen) => {
    const perStemSize = NUM_CHANNELS * F * T;
    const stemsPerWorker = Math.ceil(NUM_STEMS / pool.n);
    const promises = [];
    for (let w = 0; w < pool.n; w++) {
      const stemStart = w * stemsPerWorker;
      const stemEnd = Math.min(stemStart + stemsPerWorker, NUM_STEMS);
      if (stemStart >= stemEnd) continue;
      const numS = stemEnd - stemStart;
      const realSub = realArr.subarray(stemStart * perStemSize, stemEnd * perStemSize).slice();
      const imagSub = imagArr.subarray(stemStart * perStemSize, stemEnd * perStemSize).slice();
      promises.push(pool.send(w, 'istft-batch', {
        realBuf: realSub.buffer, imagBuf: imagSub.buffer,
        numStems: numS, numChannels: NUM_CHANNELS,
        F, T, length: CHUNK_SAMPLES,
        nFft: N_FFT, hopLength: HOP_LENGTH, winLength: WIN_LENGTH,
      }, [realSub.buffer, imagSub.buffer]).then(reply => ({ ...reply, stemStart, numStems: numS })));
    }
    return Promise.all(promises).then(parts => ({ segIdx, segStart, segLen, parts }));
  };

  function buildPlanarChunk(segIdx) {
    const buf = new Float32Array(CHUNK_SAMPLES * 2);
    const start = segIdx * STEP;
    const len = Math.min(CHUNK_SAMPLES, N - start);
    for (let i = 0; i < len; i++) {
      buf[i] = audio.left[start + i];
      buf[CHUNK_SAMPLES + i] = audio.right[start + i];
    }
    return { buf, start, len };
  }

  function mixSegment({ parts, segIdx, segStart, segLen }) {
    for (const p of parts) {
      const arr = new Float32Array(p.audioBuf);
      for (let s = 0; s < p.numStems; s++) {
        const dst = stems[STEM_NAMES[p.stemStart + s]];
        const offL = s * NUM_CHANNELS * CHUNK_SAMPLES;
        const offR = offL + CHUNK_SAMPLES;
        for (let i = 0; i < segLen; i++) {
          const g = segStart + i;
          if (g >= N) break;
          let w = 1;
          if (segIdx > 0 && i < OVERLAP) w = fadeIn[i];
          if (segIdx < numSegments - 1 && i >= CHUNK_SAMPLES - OVERLAP) {
            w = fadeOut[i - (CHUNK_SAMPLES - OVERLAP)];
          }
          dst[g]     += arr[offL + i] * w;
          dst[N + g] += arr[offR + i] * w;
        }
      }
    }
  }

  // Prime the STFT pipeline: chunk 0's STFT begins before the loop's first run.
  let stftPromise = (() => {
    const { buf, start, len } = buildPlanarChunk(0);
    return postStft(buf).then(r => ({ ...r, segStart: start, segLen: len }));
  })();
  let pendingIstft = null;
  let avgInferMs = 0;

  for (let seg = 0; seg < numSegments; seg++) {
    const stft = await stftPromise;
    if (seg + 1 < numSegments) {
      const { buf, start: ns, len: nl } = buildPlanarChunk(seg + 1);
      stftPromise = postStft(buf).then(r => ({ ...r, segStart: ns, segLen: nl }));
    }

    const tIn1 = new ortRuntime.Tensor('float32', new Float32Array(stft.realBuf), [1, NUM_CHANNELS, stft.F, stft.T]);
    const tIn2 = new ortRuntime.Tensor('float32', new Float32Array(stft.imagBuf), [1, NUM_CHANNELS, stft.F, stft.T]);
    const tInfer = performance.now();
    const out = await session.run({ spec_real: tIn1, spec_imag: tIn2 });
    const inferMs = performance.now() - tInfer;
    avgInferMs = avgInferMs === 0 ? inferMs : avgInferMs * 0.8 + inferMs * 0.2;

    // .data is a view into ORT-owned memory; .slice() gives an owned buffer
    // we can transfer to the worker without invalidating ORT's pointer.
    const realCopy = out.out_spec_real.data.slice();
    const imagCopy = out.out_spec_imag.data.slice();
    tIn1.dispose(); tIn2.dispose();
    out.out_spec_real.dispose(); out.out_spec_imag.dispose();

    if (pendingIstft) mixSegment(await pendingIstft);
    pendingIstft = postIstftBatch(realCopy, imagCopy, stft.F, stft.T, seg, stft.segStart, stft.segLen);

    onProgress?.({
      segment: seg + 1,
      totalSegments: numSegments,
      inferMs,
      etaSec: (numSegments - seg - 1) * (avgInferMs / 1000),
    });
  }
  if (pendingIstft) mixSegment(await pendingIstft);
  pool.terminate();

  return stems;
}
