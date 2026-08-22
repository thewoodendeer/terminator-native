// ─────────────────────────────────────────────────────────────────────────────
// WATCHING, IN THE ROOM — the viewer's end of a live show's audio.
//
// Victor, 2026-08-12: "the person watching live should have an option to listen
// to room audio or direct audio without room effects. and if you listening to
// room effects then whatever camera you're on will be in a real 3D stereo field
// so it's like you're listening to the audio coming from that camera as if it
// were really in the room."
//
// It costs nothing on the wire, because the viewer is already RENDERING the
// host's studio: they have the geometry, the speaker positions and the camera.
// Only the audio was bypassing all of it — the stream went straight to an
// <audio> element, i.e. dead centre in your head no matter where you stood.
//
// So the received mix is treated as what it actually is: the signal ARRIVING AT
// THE HOST'S MONITORS. Split it, put each side on a PannerNode at that cabinet,
// and let the shared AudioListener — which already follows the camera every
// frame — do the rest. The per-camera stereo field is not implemented per
// camera; it FALLS OUT, because moving the listener is the whole mechanism.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO, both of which reusing `RoomAudio`
// wholesale would have got wrong:
//  · NO AMBIENCE. RoomAudio also runs the AC, the console hiss and the room
//    tone into the hub. The viewer's own board is already running all three;
//    a second copy is not "more room", it is two rooms.
//  · NO HUB. Its `out` goes where the caller says, and main.ts points it at
//    `ctx.destination` rather than `busOutput()` — so the stream stays audible
//    but is not reachable from `tapRoom()`, `tapMaster()` or any export. The
//    <audio>-element rule ("somebody else's finished mix is not a source to be
//    processed") survives the move into the graph.
// ─────────────────────────────────────────────────────────────────────────────

export type LiveListenMode = 'room' | 'direct';

export interface LiveRoomPoint { x: number; y: number; z: number }

function norm(v: LiveRoomPoint): LiveRoomPoint {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

/** Same geometry the room's own monitors use — see room.ts `makePanner`. If
 *  those numbers move, these have to move with them or a viewer hears a
 *  different studio from the one they are looking at. */
function speakerPanner(ctx: AudioContext, pos: LiveRoomPoint, aim: LiveRoomPoint): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = 1.1;
  p.rolloffFactor = 0.9;
  p.maxDistance = 30;
  p.coneInnerAngle = 70;
  p.coneOuterAngle = 230;
  p.coneOuterGain = 0.3;
  p.positionX.value = pos.x;
  p.positionY.value = pos.y;
  p.positionZ.value = pos.z;
  const d = norm({ x: aim.x - pos.x, y: aim.y - pos.y, z: aim.z - pos.z });
  p.orientationX.value = d.x;
  p.orientationY.value = d.y;
  p.orientationZ.value = d.z;
  return p;
}

export class LiveRoomAudio {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private src: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  /** ROOM path. */
  private readonly split: ChannelSplitterNode;
  private readonly gL: GainNode;
  private readonly gR: GainNode;
  private readonly panL: PannerNode;
  private readonly panR: PannerNode;
  private readonly roomIn: GainNode;
  /** DIRECT path — a straight wire, deliberately. */
  private readonly directIn: GainNode;
  private mode: LiveListenMode = 'room';
  private shut = false;

  constructor(
    ctx: AudioContext,
    spkL: LiveRoomPoint,
    spkR: LiveRoomPoint,
    aim: LiveRoomPoint,
    dest: AudioNode,
    /** Start on this path, with NO crossfade. Both gains are born at 1, so
     *  letting the constructor ramp meant the first ~100ms of every show played
     *  BOTH paths at once — the same programme twice, ~6dB up. Inaudible if you
     *  are not listening for it, and completely avoidable. */
    mode: LiveListenMode = 'room',
  ) {
    this.ctx = ctx;
    this.mode = mode;
    this.out = ctx.createGain();
    this.out.connect(dest);

    this.roomIn = ctx.createGain();
    this.split = ctx.createChannelSplitter(2);
    this.gL = ctx.createGain();
    this.gR = ctx.createGain();
    this.panL = speakerPanner(ctx, spkL, aim);
    this.panR = speakerPanner(ctx, spkR, aim);
    this.roomIn.connect(this.split);
    this.split.connect(this.gL, 0);
    this.split.connect(this.gR, 1);
    this.gL.connect(this.panL);
    this.gR.connect(this.panR);
    // the same make-up the room's own speaker path uses: an equalpower panner
    // pair lands ~2.7dB under a straight wire at this geometry, and a mode
    // switch that also changes the LEVEL is a switch nobody can judge
    const makeup = ctx.createGain();
    makeup.gain.value = 1.36;
    this.panL.connect(makeup);
    this.panR.connect(makeup);
    makeup.connect(this.out);

    this.directIn = ctx.createGain();
    this.directIn.connect(this.out);

    this.applyMode(true);
  }

  /** Point it at the show. Safe to call again — a re-negotiated track replaces
   *  the old source rather than stacking a second one on the same output. */
  setStream(stream: MediaStream): void {
    if (this.shut || this.stream === stream) return;
    this.dropSource();
    this.stream = stream;
    try {
      this.src = this.ctx.createMediaStreamSource(stream);
    } catch (_) {
      this.src = null;                 // no audio track yet; a later call retries
      return;
    }
    this.src.connect(this.roomIn);
    this.src.connect(this.directIn);
  }

  setMode(m: LiveListenMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.applyMode();
  }

  get listenMode(): LiveListenMode { return this.mode; }

  /** Crossfaded rather than switched: a hard cut between two paths carrying the
   *  same programme clicks, and this is a control somebody will A/B. */
  private applyMode(instant = false): void {
    const t = this.ctx.currentTime;
    const room = this.mode === 'room' ? 1 : 0;
    if (instant) {
      // Construction: nothing is playing yet, so there is nothing to click.
      this.roomIn.gain.value = room;
      this.directIn.gain.value = 1 - room;
      return;
    }
    this.roomIn.gain.setTargetAtTime(room, t, 0.04);
    this.directIn.gain.setTargetAtTime(1 - room, t, 0.04);
  }

  /** Probe: what the graph is actually doing, not what it was asked to do. */
  state(): { mode: LiveListenMode; hasSource: boolean; roomGain: number; directGain: number } {
    return {
      mode: this.mode,
      hasSource: !!this.src,
      roomGain: +this.roomIn.gain.value.toFixed(3),
      directGain: +this.directIn.gain.value.toFixed(3),
    };
  }

  private dropSource(): void {
    if (!this.src) return;
    try { this.src.disconnect(); } catch (_) { /* already gone */ }
    this.src = null;
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.dropSource();
    this.stream = null;
    try { this.out.disconnect(); } catch (_) { /* already gone */ }
  }
}
