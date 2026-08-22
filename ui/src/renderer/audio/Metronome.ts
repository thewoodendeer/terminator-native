/**
 * Sample-accurate metronome using Web Audio API scheduler lookahead.
 * Never uses setInterval for timing — only for scheduling ahead.
 */
export class Metronome {
  private nextBeatTime = 0;
  private beatIndex = 0;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private output: GainNode;

  private readonly lookahead = 0.1;   // seconds to schedule ahead
  private readonly scheduleMs = 25;   // how often the scheduler runs (ms)

  enabled = false;

  constructor(private ctx: AudioContext, destination: AudioNode) {
    this.output = ctx.createGain();
    this.output.gain.value = 0.7;
    this.output.connect(destination);
  }

  start(bpm: number): void {
    if (this.enabled) return;
    this.enabled = true;
    this.beatIndex = 0;
    this.nextBeatTime = this.ctx.currentTime + 0.05;
    this.schedule(bpm);
  }

  stop(): void {
    this.enabled = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  updateBPM(bpm: number): void {
    // BPM change takes effect on next scheduled beat naturally
    if (this.enabled) {
      this.stop();
      this.start(bpm);
    }
  }

  countIn(bpm: number, beats: number): void {
    const beatDuration = 60 / bpm;
    const start = this.ctx.currentTime + 0.05;
    for (let i = 0; i < beats; i++) {
      this.playClick(start + i * beatDuration, i === 0);
    }
  }

  private schedule(bpm: number): void {
    const beatDuration = 60 / bpm;

    while (this.nextBeatTime < this.ctx.currentTime + this.lookahead) {
      this.playClick(this.nextBeatTime, this.beatIndex % 4 === 0);
      this.beatIndex++;
      this.nextBeatTime += beatDuration;
    }

    this.timerId = setTimeout(() => {
      if (this.enabled) this.schedule(bpm);
    }, this.scheduleMs);
  }

  private playClick(when: number, accent: boolean): void {
    // Sine burst — short envelope, accent is higher pitch
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = accent ? 1800 : 1000;

    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(accent ? 1 : 0.55, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.04);

    osc.connect(env);
    env.connect(this.output);
    osc.start(when);
    osc.stop(when + 0.05);

    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
  }
}
