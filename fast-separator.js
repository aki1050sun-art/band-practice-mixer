import { getModelBytes } from './model-cache.js';
import { decodeAudio } from './audio-io.js';
import { separateStems, STEM_NAMES } from './pipeline.js';

const ORT_SCRIPT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.0-dev.20251116-b39e144322/dist/ort.all.min.js';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.0-dev.20251116-b39e144322/dist/';
const MODEL_URL = 'https://huggingface.co/elicwhite/bs-roformer-sw-6stem-onnx/resolve/main/bs_roformer_sw_6stem_fp16.onnx';
const MODEL_KEY = 'bs_roformer_sw_6stem_fp16.onnx';

let sessionPromise = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.ort) return resolve();
    const existing = document.querySelector('script[data-fast-ort="1"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.fastOrt = '1';
    s.onload = resolve;
    s.onerror = () => reject(new Error('ONNX Runtimeの読み込みに失敗しました'));
    document.head.appendChild(s);
  });
}

async function getSession(onProgress) {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    await loadScriptOnce(ORT_SCRIPT);
    const ort = globalThis.ort;
    ort.env.wasm.wasmPaths = ORT_WASM;
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    ort.env.logLevel = 'warning';

    const bytes = await getModelBytes({
      url: MODEL_URL,
      key: MODEL_KEY,
      onProgress: ({ phase, loaded, total, etaSec }) => {
        if (phase === 'ready') {
          onProgress?.({ phase: 'model', fraction: 1, text: '高速AIモデル準備完了' });
        } else {
          const fraction = total ? loaded / total : 0;
          const mb = (loaded / 1024 / 1024).toFixed(0);
          const totalText = total ? ' / ' + (total / 1024 / 1024).toFixed(0) + 'MB' : 'MB';
          const eta = etaSec ? ' 残り約' + Math.ceil(etaSec) + '秒' : '';
          onProgress?.({ phase: 'model', fraction, text: 'AIモデル取得中 ' + mb + totalText + eta });
        }
      }
    });

    onProgress?.({ phase: 'session', fraction: 0, text: 'WebGPUを準備中…' });
    const eps = ('gpu' in navigator) ? ['webgpu','wasm'] : ['wasm'];
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: eps,
      graphOptimizationLevel: 'disabled'
    });
    return { session, ort, backend: eps[0] === 'webgpu' ? 'WebGPU' : 'WASM' };
  })();
  return sessionPromise;
}

export async function separateFast(file, onProgress) {
  const modelPromise = getSession(onProgress);
  onProgress?.({ phase: 'decode', fraction: 0, text: '元の曲を読み込み中…' });
  const audio = await decodeAudio(file);
  const { session, ort, backend } = await modelPromise;
  const workers = Math.max(1, Math.min(2, navigator.hardwareConcurrency || 2));

  const stems = await separateStems({
    audio,
    session,
    ortRuntime: ort,
    overlapFrac: 0.15,
    numWorkers: workers,
    onProgress: ({ segment, totalSegments, etaSec }) => {
      onProgress?.({
        phase: 'separate',
        fraction: segment / totalSegments,
        text: '高速AI分離中… ' + segment + '/' + totalSegments +
          (Number.isFinite(etaSec) ? ' 残り約' + Math.ceil(etaSec) + '秒' : '')
      });
    }
  });

  return { stems, stemNames: STEM_NAMES, backend, sampleRate: 44100 };
}
