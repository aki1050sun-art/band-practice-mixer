/**
 * Audio decode + WAV encode helpers.
 *
 * decodeAudio: any browser-supported file (mp3 / wav / flac / m4a) → 44.1 kHz
 *              stereo Float32. Returns {left, right} as planar arrays.
 * encodeWAV16: planar [L0..LN, R0..RN] stereo Float32 → 16-bit PCM WAV Blob.
 */

export async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  // decodeAudioData needs an AudioContext for the codec, but the sample-rate
  // resampling is done by rendering through an OfflineAudioContext at 44.1 kHz.
  const probe = new (self.OfflineAudioContext || self.webkitOfflineAudioContext)(2, 44100, 44100);
  const decoded = await probe.decodeAudioData(buf.slice(0));
  if (decoded.sampleRate === 44100 && decoded.numberOfChannels === 2) {
    return {
      left: decoded.getChannelData(0).slice(),
      right: decoded.getChannelData(1).slice(),
    };
  }
  const ren = new OfflineAudioContext(2, Math.ceil(decoded.duration * 44100), 44100);
  const src = ren.createBufferSource();
  src.buffer = decoded;
  src.connect(ren.destination);
  src.start(0);
  const out = await ren.startRendering();
  return {
    left: out.getChannelData(0).slice(),
    right: out.getChannelData(1).slice(),
  };
}

export function encodeWAV16(planarLR, sampleRate) {
  const N = planarLR.length / 2;
  const buf = new ArrayBuffer(44 + N * 4);
  const dv = new DataView(buf);
  let p = 0;
  const ws = s => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
  const w32 = v => { dv.setUint32(p, v, true); p += 4; };
  const w16 = v => { dv.setUint16(p, v, true); p += 2; };
  ws('RIFF'); w32(36 + N * 4); ws('WAVE'); ws('fmt ');
  w32(16); w16(1); w16(2); w32(sampleRate); w32(sampleRate * 4); w16(4); w16(16);
  ws('data'); w32(N * 4);
  for (let i = 0; i < N; i++) {
    const l = Math.max(-1, Math.min(1, planarLR[i]));
    const r = Math.max(-1, Math.min(1, planarLR[N + i]));
    dv.setInt16(p, l * 0x7fff, true); p += 2;
    dv.setInt16(p, r * 0x7fff, true); p += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
