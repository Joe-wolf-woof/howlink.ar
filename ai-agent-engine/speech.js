/**
 * ai-agent-engine/speech.js
 * ハウルの鳴き声（WebAudio で合成）。
 * 人間の声での読み上げはやめ、返事のたびに狼の鳴き声「バウワウ」を鳴らす。
 * セリフの内容は吹き出しのテキストで表示される。
 * 鳴き声は、音程が上がって下がる短い遠吠えを2連で合成したもの。
 * ビブラートとローパスで、電子音すぎない粗さを付けている。
 */
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

export function speak() {
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
  // 「バウワウ」— 2連の鳴き声
  howlOnce(ctx, out, t, 0.42, 520);
  howlOnce(ctx, out, t + 0.5, 0.5, 470);
}
