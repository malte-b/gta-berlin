/**
 * Game sounds, synthesised with WebAudio so nothing has to be downloaded.
 * The context is created on the first call, which always follows a click
 * (choosing a mode), as browsers require.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
export let muted = false;

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  if (m && ctx) void ctx.suspend();
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.5): void {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + start;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(start: number, dur: number, vol: number, hp: number): void {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + start;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

const NOTE = (n: number) => 440 * 2 ** ((n - 69) / 12);

export const sfx = {
  /** A target reached: a rising arpeggio. */
  collect(): void {
    [72, 76, 79, 84].forEach((n, i) => tone(NOTE(n), i * 0.06, 0.25, 'triangle', 0.4));
  },
  /** Sleigh bells and a chord. */
  jingle(): void {
    for (let i = 0; i < 6; i++) noise(i * 0.07, 0.12, 0.25, 6000);
    [76, 79, 83, 88].forEach((n, i) => tone(NOTE(n), 0.05 + i * 0.05, 0.5, 'sine', 0.3));
  },
  tick(): void { tone(NOTE(84), 0, 0.08, 'square', 0.12); },
  go(): void { tone(NOTE(79), 0, 0.12, 'square', 0.2); tone(NOTE(91), 0.12, 0.35, 'square', 0.2); },
  splash(): void { noise(0, 0.5, 0.35, 900); tone(NOTE(60), 0, 0.3, 'sine', 0.3); },
  /** Water running, called repeatedly while pouring or pumping. */
  pour(): void { noise(0, 0.18, 0.12, 1800); },
  pump(): void { tone(NOTE(43), 0, 0.12, 'sawtooth', 0.12); noise(0.05, 0.15, 0.1, 1200); },
  chomp(): void { noise(0, 0.08, 0.3, 300); noise(0.14, 0.08, 0.3, 300); tone(NOTE(55), 0.3, 0.2, 'triangle', 0.25); },
  warn(): void { tone(NOTE(70), 0, 0.15, 'square', 0.15); tone(NOTE(70), 0.2, 0.15, 'square', 0.15); },
  win(): void {
    [72, 76, 79, 84, 79, 84].forEach((n, i) => tone(NOTE(n), i * 0.12, 0.3, 'triangle', 0.35));
  },
  lose(): void {
    [67, 63, 60, 55].forEach((n, i) => tone(NOTE(n), i * 0.18, 0.35, 'sawtooth', 0.18));
  },
};
