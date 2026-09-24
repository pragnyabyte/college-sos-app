/* Emergency Audio Alarm using Web Audio API */

let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let sirenInterval = null;
let isPlaying = false;
let isMuted = false;

export function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

export function playEmergencyAlarm(durationSeconds = 15) {
  if (isMuted) return;

  try {
    initAudio();
    if (!audioCtx) return;

    if (isPlaying) {
      stopEmergencyAlarm();
    }

    sirenOsc = audioCtx.createOscillator();
    sirenGain = audioCtx.createGain();

    sirenOsc.type = 'sawtooth';
    sirenOsc.frequency.setValueAtTime(800, audioCtx.currentTime);

    // Initial volume ramp up
    sirenGain.gain.setValueAtTime(0.01, audioCtx.currentTime);
    sirenGain.gain.exponentialRampToValueAtTime(0.5, audioCtx.currentTime + 0.1);

    sirenOsc.connect(sirenGain);
    sirenGain.connect(audioCtx.destination);

    sirenOsc.start();
    isPlaying = true;

    // Siren alternating frequency: 880Hz to 620Hz
    let high = true;
    sirenInterval = setInterval(() => {
      if (!audioCtx || !sirenOsc) return;
      const targetFreq = high ? 620 : 880;
      high = !high;
      sirenOsc.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.08);
    }, 400);

    // Auto-stop after duration
    if (durationSeconds > 0) {
      setTimeout(() => {
        if (isPlaying) stopEmergencyAlarm();
      }, durationSeconds * 1000);
    }
  } catch (e) {
    console.warn('[Audio] Emergency alarm failed to play:', e.message);
  }
}

export function stopEmergencyAlarm() {
  try {
    if (sirenInterval) {
      clearInterval(sirenInterval);
      sirenInterval = null;
    }
    if (sirenOsc) {
      try { sirenOsc.stop(); } catch {}
      try { sirenOsc.disconnect(); } catch {}
      sirenOsc = null;
    }
    if (sirenGain) {
      try { sirenGain.disconnect(); } catch {}
      sirenGain = null;
    }
  } catch {}
  isPlaying = false;
}

export function toggleMute() {
  isMuted = !isMuted;
  if (isMuted && isPlaying) {
    stopEmergencyAlarm();
  }
  return isMuted;
}

export function getAudioState() {
  return { isPlaying, isMuted };
}
