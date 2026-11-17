/**
 * ai-agent-engine/speech.js
 * ハウルの鳴き声（Pixabay のフリー音源を再生）。
 * 人間の声での読み上げは廃止済み。返事の内容は吹き出しテキストで表示し、
 * 音はリアクションに合わせた3種の鳴き声から選ぶ:
 *   howl  … 遠吠え「ワオン！」（挨拶）
 *   bark  … 2連吠え「バウワウ！」（発見・喜び）
 *   wuff  … 短い相槌「ワフッ」（通常の返事・考え中）
 * 音源は Pixabay Sound Effects（クレジット表記不要のフリー音源）。
 * GitHub API 経由の公開はテキストファイルのみ対応のため、MP3 は base64 で
 * sound-data.js に埋め込み、実行時に Blob URL 化して再生する。
 * 音源の読み込み・再生に失敗した場合は、WebAudio 合成音にフォールバックする。
 */
import { SOUND_DATA } from './sound-data.js?v=20261118-2';

const urlCache = {};

function soundUrl(type) {
  if (urlCache[type]) return urlCache[type];
  const b64 = SOUND_DATA[type];
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    urlCache[type] = url;
    return url;
  } catch {
    return null;
  }
}

let currentAudio = null;

/** 鳴き声を鳴らす。cry: 'howl' | 'bark' | 'wuff' */
export function speak(cry = 'wuff') {
  const url = soundUrl(cry);
  if (url) {
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      }
      const audio = new Audio(url);
      currentAudio = audio;
      audio.volume = 0.9;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => synthCry(cry));
      return;
    } catch { /* 合成音にフォールバックする */ }
  }
  synthCry(cry);
}

// --- フォールバック: WebAudio 合成（音源が使えない時の従来実装） ---
let audioCtx = null;
let currentOut = null;

function getContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// 1回分の鳴き声。基音が うねるように上がって下がる。
function howlOnce(ctx, out, t0, dur, base) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(base * 0.8, t0);
  osc.frequency.exponentialRampToValueAtTime(base * 1.5, t0 + dur * 0.35);
  osc.frequency.exponentialRampToValueAtTime(base * 0.75, t0 + dur);

  // ビブラート
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 9;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = base * 0.03;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1600;
  filter.Q.value = 2;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.22, t0 + dur * 0.25);
  gain.gain.setValueAtTime(0.22, t0 + dur * 0.6);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  osc.start(t0);
  lfo.start(t0);
  osc.stop(t0 + dur + 0.05);
  lfo.stop(t0 + dur + 0.05);
}

function synthCry(cry) {
  const ctx = getContext();
  if (!ctx) return;
  // 前の鳴き声が残っていたら止めてから鳴らす。
  if (currentOut) {
    const old = currentOut;
    try {
      old.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03);
      setTimeout(() => { try { old.disconnect(); } catch { /* noop */ } }, 150);
    } catch { /* noop */ }
  }
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(ctx.destination);
  currentOut = out;
  const t = ctx.currentTime + 0.02;
  switch (cry) {
    case 'howl': // 遠吠え：長い1声
      howlOnce(ctx, out, t, 0.95, 480);
      break;
    case 'wuff': // ワフッ：短い1声
      howlOnce(ctx, out, t, 0.24, 520);
      break;
    default: // bark「バウワウ」：2連
      howlOnce(ctx, out, t, 0.42, 520);
      howlOnce(ctx, out, t + 0.5, 0.5, 470);
      break;
  }
}
