import React, { useRef, useEffect, useCallback } from 'react';
import { AudioEngine } from '../audio/AudioEngine';

interface Props {
  engine: AudioEngine;
  loopProgress: number;
  isPlaying: boolean;
  mode: 'waveform' | 'spectrum';
}

export function WaveformDisplay({ engine, loopProgress, isPlaying, mode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { width: W, height: H } = canvas;

    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(0,255,136,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo((W * i) / 4, 0); ctx.lineTo((W * i) / 4, H); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    if (mode === 'spectrum') {
      const data = engine.getSpectrum();
      const barW = W / data.length;
      for (let i = 0; i < data.length; i++) {
        const barH = (data[i] / 255) * H;
        const hue = 150 + (data[i] / 255) * 60;
        ctx.fillStyle = `hsl(${hue}, 100%, 55%)`;
        ctx.fillRect(i * barW, H - barH, barW - 1, barH);
      }
    } else {
      const data = engine.getWaveform();
      ctx.beginPath();
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#00ff88';
      const step = W / data.length;
      for (let i = 0; i < data.length; i++) {
        const y = ((data[i] - 128) / 128) * (H / 2) + H / 2;
        i === 0 ? ctx.moveTo(i * step, y) : ctx.lineTo(i * step, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Loop progress line
    if (isPlaying) {
      const x = loopProgress * W;
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#00ffff';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.shadowBlur = 0;
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [engine, loopProgress, isPlaying, mode]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={120}
      className="waveform-canvas"
    />
  );
}
