import { useCallback, useEffect, useRef, useState } from 'react'

const ENABLED_STORAGE_KEY = 'humanllm:notification-sound-enabled'
const VOLUME_STORAGE_KEY = 'humanllm:notification-volume'
const SOUND_TYPE_STORAGE_KEY = 'humanllm:notification-sound-type'
const MIN_GAIN = 0.0001

export type SoundType = 'chime' | 'bell' | 'alarm' | 'retro'

type Preset = (context: AudioContext, peak: number) => void

function scheduleChime(context: AudioContext, peak: number) {
  if (peak <= 0) return
  const start = context.currentTime
  const gain = context.createGain()
  gain.connect(context.destination)
  gain.gain.setValueAtTime(MIN_GAIN, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(MIN_GAIN, start + 0.42)

  const oscillator = context.createOscillator()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(740, start)
  oscillator.frequency.setValueAtTime(988, start + 0.16)
  oscillator.connect(gain)
  oscillator.start(start)
  oscillator.stop(start + 0.43)
}

function scheduleBell(context: AudioContext, peak: number) {
  if (peak <= 0) return
  const start = context.currentTime
  const harmonics = [
    { frequency: 880, level: 1 },
    { frequency: 1760, level: 0.28 },
    { frequency: 2640, level: 0.14 },
  ]

  for (const { frequency, level } of harmonics) {
    const gain = context.createGain()
    gain.connect(context.destination)
    gain.gain.setValueAtTime(MIN_GAIN, start)
    gain.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, peak * level), start + 0.01)
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, start + 1.18)

    const oscillator = context.createOscillator()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(frequency, start)
    oscillator.connect(gain)
    oscillator.start(start)
    oscillator.stop(start + 1.2)
  }
}

function scheduleAlarm(context: AudioContext, peak: number) {
  if (peak <= 0) return
  const start = context.currentTime

  for (let i = 0; i < 3; i += 1) {
    const noteStart = start + i * 0.2
    const gain = context.createGain()
    gain.connect(context.destination)
    gain.gain.setValueAtTime(MIN_GAIN, noteStart)
    gain.gain.exponentialRampToValueAtTime(peak, noteStart + 0.008)
    gain.gain.setValueAtTime(peak, noteStart + 0.1)
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, noteStart + 0.12)

    const oscillator = context.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(880, noteStart)
    oscillator.connect(gain)
    oscillator.start(noteStart)
    oscillator.stop(noteStart + 0.125)
  }
}

function scheduleRetro(context: AudioContext, peak: number) {
  if (peak <= 0) return
  const start = context.currentTime
  const frequencies = [523, 659, 784, 1047]

  frequencies.forEach((frequency, index) => {
    const noteStart = start + index * 0.07
    const gain = context.createGain()
    gain.connect(context.destination)
    gain.gain.setValueAtTime(MIN_GAIN, noteStart)
    gain.gain.exponentialRampToValueAtTime(peak, noteStart + 0.006)
    gain.gain.exponentialRampToValueAtTime(MIN_GAIN, noteStart + 0.065)

    const oscillator = context.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(frequency, noteStart)
    oscillator.connect(gain)
    oscillator.start(noteStart)
    oscillator.stop(noteStart + 0.07)
  })
}

const PRESETS: Record<SoundType, Preset> = {
  chime: scheduleChime,
  bell: scheduleBell,
  alarm: scheduleAlarm,
  retro: scheduleRetro,
}

function playPreset(context: AudioContext, type: SoundType, gainPeak: number) {
  PRESETS[type](context, gainPeak)
}

function readStoredVolume(): number {
  const stored = Number(localStorage.getItem(VOLUME_STORAGE_KEY) ?? '0.5')
  return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.5
}

function readStoredSoundType(): SoundType {
  const stored = localStorage.getItem(SOUND_TYPE_STORAGE_KEY)
  return stored && stored in PRESETS ? stored as SoundType : 'chime'
}

export function useNotificationSound() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(ENABLED_STORAGE_KEY) !== 'false')
  const [volume, setVolumeState] = useState(readStoredVolume)
  const [soundType, setSoundTypeState] = useState<SoundType>(readStoredSoundType)
  const contextRef = useRef<AudioContext | null>(null)

  const getContext = useCallback(() => {
    if (!contextRef.current) {
      contextRef.current = new AudioContext()
    }
    return contextRef.current
  }, [])

  const unlock = useCallback(async () => {
    const context = getContext()
    if (context.state === 'suspended') await context.resume()
    return context
  }, [getContext])

  useEffect(() => {
    if (!enabled) return

    const unlockFromGesture = () => {
      void unlock().catch(() => {})
    }
    window.addEventListener('pointerdown', unlockFromGesture, { once: true })
    window.addEventListener('keydown', unlockFromGesture, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlockFromGesture)
      window.removeEventListener('keydown', unlockFromGesture)
    }
  }, [enabled, unlock])

  useEffect(() => () => {
    void contextRef.current?.close()
  }, [])

  const play = useCallback(() => {
    if (!enabled) return
    const gainPeak = 0.9 * volume ** 2
    void unlock()
      .then((context) => playPreset(context, soundType, gainPeak))
      .catch(() => {
        console.info('[notification] Browser blocked audio until the operator page is clicked')
      })
  }, [enabled, soundType, unlock, volume])

  const toggle = useCallback(() => {
    const next = !enabled
    setEnabled(next)
    localStorage.setItem(ENABLED_STORAGE_KEY, String(next))
    if (next) {
      const gainPeak = 0.9 * volume ** 2
      void unlock().then((context) => playPreset(context, soundType, gainPeak)).catch(() => {})
    }
  }, [enabled, soundType, unlock, volume])

  const setVolume = useCallback((nextVolume: number) => {
    const next = Math.min(1, Math.max(0, nextVolume))
    setVolumeState(next)
    localStorage.setItem(VOLUME_STORAGE_KEY, String(next))
  }, [])

  const setSoundType = useCallback((nextType: SoundType) => {
    setSoundTypeState(nextType)
    localStorage.setItem(SOUND_TYPE_STORAGE_KEY, nextType)
  }, [])

  return {
    enabled,
    toggle,
    play,
    preview: play,
    volume,
    setVolume,
    soundType,
    setSoundType,
  }
}
