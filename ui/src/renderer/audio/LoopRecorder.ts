export class LoopRecorder {
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private resolveStop: ((buf: AudioBuffer) => void) | null = null;
  private rejectStop: ((e: Error) => void) | null = null;
  isRecording = false;

  constructor(private ctx: AudioContext) {}

  async start(): Promise<void> {
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: this.ctx.sampleRate,
      },
    });

    const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : {};

    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = async () => {
      const blob = new Blob(this.chunks, { type: this.mediaRecorder?.mimeType ?? 'audio/webm' });
      const arrayBuf = await blob.arrayBuffer();
      try {
        const decoded = await this.ctx.decodeAudioData(arrayBuf);
        this.resolveStop?.(decoded);
      } catch (e) {
        this.rejectStop?.(e as Error);
      } finally {
        this.resolveStop = null;
        this.rejectStop = null;
        this.releaseStream();
      }
    };

    this.mediaRecorder.start(100);
    this.isRecording = true;
  }

  stop(): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || !this.isRecording) {
        reject(new Error('Not recording'));
        return;
      }
      this.resolveStop = resolve;
      this.rejectStop = reject;
      this.isRecording = false;
      this.mediaRecorder.stop();
    });
  }

  cancel(): void {
    this.isRecording = false;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.releaseStream();
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
