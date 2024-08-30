import { TalkingTomColors, TalkingTomSizes } from '@/constants/theme';
import { Audio } from 'expo-av';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Rive, { Alignment, Fit, type RiveRef } from 'rive-react-native';

const VAD_THRESHOLD_DB = -38;
const SILENCE_TIMEOUT_MS = 1000;
const POLL_INTERVAL_MS = 120;
const PLAYBACK_RATE = 1.35;
const STATE_MACHINE_NAME = 'State Machine 1';
const RIVE_BACKGROUND_COLOR = '#d8e0e8';

type CharacterPhase = 'idle' | 'listening' | 'replaying' | 'permission-denied' | 'error';

export default function HomeScreen() {
  const [phase, setPhase] = useState<CharacterPhase>('idle');
  const [statusText, setStatusText] = useState('Чекаю голос…');
  const [hasPermission, setHasPermission] = useState(false);

  const mountedRef = useRef(true);
  const riveRef = useRef<RiveRef>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  const startRecordingRef = useRef<() => Promise<void>>(async () => {});
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heardSpeechRef = useRef(false);
  const silenceMsRef = useRef(0);
  const handlingStopRef = useRef(false);

  const animationInputs = useMemo(
    () => ({
      idle: ['Look', 'look_idle'],
      listening: ['Hear', 'hands_hear_start9'],
      replaying: ['Talk', 'hands_hear_stop9'],
    }),
    []
  );

  const clearMonitor = useCallback(() => {
    if (monitorRef.current) {
      clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
  }, []);

  const syncCharacterState = useCallback(
    (nextPhase: CharacterPhase) => {
      const rive = riveRef.current;
      if (!rive) return;

      const fireAll = (names: string[]) => {
        for (const inputName of names) {
          try {
            rive.fireState(STATE_MACHINE_NAME, inputName);
            rive.setInputState(STATE_MACHINE_NAME, inputName, 1);
          } catch {
            // Для этого ассета часть входов может быть trigger, часть boolean/number.
          }
        }
      };

      if (nextPhase === 'listening') {
        fireAll(animationInputs.listening);
      } else if (nextPhase === 'replaying') {
        fireAll(animationInputs.replaying);
      } else if (nextPhase === 'idle') {
        fireAll(animationInputs.idle);
      }
    },
    [animationInputs]
  );

  const stopAndPlayback = useCallback(async () => {
    try {
      const recording = recordingRef.current;
      if (!recording) return;

      await recording.stopAndUnloadAsync();
      const recordedUri = recording.getURI();
      recordingRef.current = null;

      if (!recordedUri || !mountedRef.current) {
        await startRecordingRef.current();
        return;
      }

      setPhase('replaying');
      setStatusText('Повторюю вищим голосом…');
      syncCharacterState('replaying');

      const { sound } = await Audio.Sound.createAsync(
        { uri: recordedUri },
        {
          shouldPlay: true,
          volume: 1,
          rate: PLAYBACK_RATE,
          shouldCorrectPitch: false,
          progressUpdateIntervalMillis: 100,
        }
      );

      playbackRef.current = sound;
      sound.setOnPlaybackStatusUpdate(async (playbackStatus) => {
        if (!playbackStatus.isLoaded || !playbackStatus.didJustFinish) return;

        try {
          await sound.unloadAsync();
        } catch {
          // no-op
        }
        playbackRef.current = null;

        if (!mountedRef.current) return;
        setPhase('idle');
        setStatusText('Чекаю голос…');
        syncCharacterState('idle');
        await startRecordingRef.current();
      });
    } catch {
      if (!mountedRef.current) return;
      setPhase('error');
      setStatusText('Помилка під час відтворення');
      await startRecordingRef.current();
    } finally {
      handlingStopRef.current = false;
    }
  }, [syncCharacterState]);

  const startRecording = useCallback(async () => {
    if (!mountedRef.current || !hasPermission || phase === 'replaying') return;

    clearMonitor();
    heardSpeechRef.current = false;
    silenceMsRef.current = 0;
    handlingStopRef.current = false;

    try {
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
        android: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
          extension: '.m4a',
        },
        ios: {
          ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
          extension: '.m4a',
        },
      });
      await recording.startAsync();
      recordingRef.current = recording;

      setPhase('idle');
      setStatusText('Чекаю голос…');
      syncCharacterState('idle');

      monitorRef.current = setInterval(async () => {
        const activeRecording = recordingRef.current;
        if (!activeRecording || handlingStopRef.current) return;

        const status = await activeRecording.getStatusAsync();
        if (!status.isRecording) return;

        const metering = status.metering ?? -160;
        const isLoudEnough = metering >= VAD_THRESHOLD_DB;

        if (isLoudEnough) {
          heardSpeechRef.current = true;
          silenceMsRef.current = 0;
          if (mountedRef.current && phase !== 'listening') {
            setPhase('listening');
            setStatusText('Слухаю…');
            syncCharacterState('listening');
          }
          return;
        }

        if (heardSpeechRef.current) {
          silenceMsRef.current += POLL_INTERVAL_MS;
          if (silenceMsRef.current >= SILENCE_TIMEOUT_MS) {
            handlingStopRef.current = true;
            clearMonitor();
            await stopAndPlayback();
          }
        }
      }, POLL_INTERVAL_MS);
    } catch {
      if (!mountedRef.current) return;
      setPhase('error');
      setStatusText('Не вдалося стартувати запис');
    }
  }, [clearMonitor, hasPermission, phase, stopAndPlayback, syncCharacterState]);

  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  useEffect(() => {
    const bootstrap = async () => {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const permission = await Audio.requestPermissionsAsync();
      const granted = permission.status === 'granted';
      setHasPermission(granted);

      if (!granted) {
        setPhase('permission-denied');
        setStatusText('Потрібен доступ до мікрофона');
        return;
      }

      await startRecording();
    };

    void bootstrap();

    return () => {
      mountedRef.current = false;
      clearMonitor();
      if (recordingRef.current) {
        void recordingRef.current.stopAndUnloadAsync();
      }
      if (playbackRef.current) {
        void playbackRef.current.unloadAsync();
      }
    };
  }, [clearMonitor, startRecording]);

  return (
    <View style={styles.container}>
      <Rive
        ref={riveRef}
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        source={require('../../assets/rive/wave-hear-and-talk.riv')}
        artboardName="Artboard"
        stateMachineName={STATE_MACHINE_NAME}
        autoplay
        fit={Fit.Contain}
        alignment={Alignment.Center}
        style={styles.character}
      />
      <View style={styles.footer}>
        <Text style={styles.status}>{statusText}</Text>
        <View style={styles.buttonsRow}>
          <Pressable style={styles.actionButton}>
            <Text style={styles.actionButtonLabel}>Слушать</Text>
          </Pressable>
          <Pressable style={styles.actionButton}>
            <Text style={styles.actionButtonLabel}>Повтор</Text>
          </Pressable>
          <Pressable style={styles.actionButton}>
            <Text style={styles.actionButtonLabel}>Стоп</Text>
          </Pressable>
        </View>
      </View>
      {Platform.OS === 'web' ? (
        <Text style={styles.hint}>Для коректної роботи використовуйте dev build на iOS/Android.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: RIVE_BACKGROUND_COLOR,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  character: {
    width: '100%',
    flex: 1,
    maxHeight: '78%',
  },
  footer: {
    width: '100%',
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  status: {
    marginTop: TalkingTomSizes.statusMarginTop,
    color: TalkingTomColors.primaryText,
    fontSize: TalkingTomSizes.statusFontSize,
    fontWeight: '600',
    textAlign: 'center',
  },
  buttonsRow: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: '#2e3951',
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionButtonLabel: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    marginTop: TalkingTomSizes.hintMarginTop,
    color: TalkingTomColors.secondaryText,
    fontSize: TalkingTomSizes.hintFontSize,
    textAlign: 'center',
  },
});
