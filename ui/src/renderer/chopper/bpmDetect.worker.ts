/// <reference lib="webworker" />
/**
 * BPM-estimator worker. Receives detached channel data + sample rate,
 * returns the integer BPM. See bpmDetect.ts for the algorithm.
 */

import { estimateBPMFromChannels } from './bpmDetect';

interface Msg {
  ch0: Float32Array;
  ch1: Float32Array;
  sampleRate: number;
  length: number;
  durationSec: number;
  isMono: boolean;
}

self.addEventListener('message', (e: MessageEvent<Msg>) => {
  const { ch0, ch1, sampleRate, length, durationSec, isMono } = e.data;
  const right = isMono ? ch0 : ch1;
  const bpm = estimateBPMFromChannels(ch0, right, sampleRate, length, durationSec);
  (self as DedicatedWorkerGlobalScope).postMessage({ bpm });
});
