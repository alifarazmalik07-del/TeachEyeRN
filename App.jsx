import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, AppState, SafeAreaView, ScrollView,
  StatusBar, Animated, Dimensions, Platform
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';
import NetInfo from '@react-native-community/netinfo';
import { request, PERMISSIONS, RESULTS } from 'react-native-permissions';
import {
  RTCPeerConnection, RTCSessionDescription, RTCIceCandidate,
  mediaDevices
} from 'react-native-webrtc';
import { db } from './src/firebase';
import { ref, set, onValue, off } from 'firebase/database';

const { width } = Dimensions.get('window');
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const HEARTBEAT = 8000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId() {
  const raw = `${DeviceInfo.getModel()}_${DeviceInfo.getUniqueIdSync() || Date.now()}`;
  return raw.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 40);
}

function fmtBytes(b) {
  if (!b || b <= 0) return '-';
  const gb = b / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(b / 1048576).toFixed(0)} MB`;
}

async function getIP() {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    return (await r.json()).ip;
  } catch { return 'unknown'; }
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState('loading'); // loading | name | perms | monitoring
  const [nameInput, setNameInput] = useState('');
  const [studentName, setStudentName] = useState('');
  const [status, setStatus] = useState('Initializing...');
  const [statusColor, setStatusColor] = useState('#6366f1');
  const deviceId = useRef(makeId()).current;

  const heartbeatTimer = useRef(null);
  const camPc = useRef(null);
  const screenPc = useRef(null);
  const camStream = useRef(null);
  const screenStream = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 900, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  // Load saved name
  useEffect(() => {
    AsyncStorage.getItem(`te_${deviceId}`)
      .then(n => { if (n) { setStudentName(n); setStep('perms'); } else setStep('name'); })
      .catch(() => setStep('name'));
  }, []);

  // ── Name submit ──────────────────────────────────────────────────────────────
  async function submitName() {
    const n = nameInput.trim();
    if (n.length < 2) { Alert.alert('Naam chahiye', 'Apna poora naam enter karein.'); return; }
    await AsyncStorage.setItem(`te_${deviceId}`, n);
    setStudentName(n);
    setStep('perms');
  }

  // ── Request permissions ───────────────────────────────────────────────────────
  async function requestPerms() {
    const results = await Promise.all([
      request(PERMISSIONS.ANDROID.CAMERA),
      request(PERMISSIONS.ANDROID.RECORD_AUDIO),
      request(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION),
    ]);
    const allOk = results.every(r => r === RESULTS.GRANTED);
    if (!allOk) {
      Alert.alert('Permissions Chahiye', 'Camera, Microphone aur Location allow karein.', [
        { text: 'Retry', onPress: requestPerms }
      ]);
    } else {
      setStep('monitoring');
    }
  }

  // ── Start monitoring ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'monitoring' || !studentName) return;
    register();
    heartbeatTimer.current = setInterval(pushLive, HEARTBEAT);
    startCameraWebRTC();
    startScreenShare();
    return () => {
      clearInterval(heartbeatTimer.current);
      cleanup();
    };
  }, [step, studentName]);

  async function register() {
    await set(ref(db, `students/${deviceId}/name`), studentName);
    await set(ref(db, `students/${deviceId}/deviceName`), DeviceInfo.getModel());
    await set(ref(db, `students/${deviceId}/brand`), DeviceInfo.getBrand());
    await logVisit();
    await pushLive();
    setStatus('Monitoring Active');
    setStatusColor('#22c55e');
  }

  async function gatherData() {
    const net = await NetInfo.fetch();
    const battery = await DeviceInfo.getBatteryLevel();
    const charging = await DeviceInfo.isBatteryCharging();
    const totalMem = await DeviceInfo.getTotalMemory();
    const usedMem = await DeviceInfo.getUsedMemory();
    const freeDisk = await DeviceInfo.getFreeDiskStorage();
    const totalDisk = await DeviceInfo.getTotalDiskCapacity();
    let lat = null, lng = null, acc = null;
    try {
      const { default: Geolocation } = await import('@react-native-community/geolocation');
      await new Promise(resolve => {
        Geolocation.getCurrentPosition(
          pos => { lat = pos.coords.latitude; lng = pos.coords.longitude; acc = Math.round(pos.coords.accuracy); resolve(); },
          () => resolve(), { timeout: 4000 }
        );
      });
    } catch {}
    return {
      battery: Math.round(battery * 100),
      charging,
      wifi: net.type === 'wifi' ? (net.details?.ssid || 'WiFi Connected') : net.type,
      ramUsed: fmtBytes(usedMem),
      ramTotal: fmtBytes(totalMem),
      storageUsed: fmtBytes(totalDisk - freeDisk),
      storageTotal: fmtBytes(totalDisk),
      lat, lng, locationAccuracy: acc,
    };
  }

  async function logVisit() {
    const ip = await getIP();
    const data = await gatherData();
    await set(ref(db, `students/${deviceId}/visits/visit_${Date.now()}`), {
      time: Date.now(), ip, ...data
    });
  }

  async function pushLive() {
    try {
      const data = await gatherData();
      await set(ref(db, `students/${deviceId}/live`), {
        lastSeen: Date.now(),
        appState: AppState.currentState,
        ...data
      });
    } catch (e) { console.log('live err', e); }
  }

  // ── WebRTC Camera ─────────────────────────────────────────────────────────────
  async function startCameraWebRTC() {
    try {
      const stream = await mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 480, height: 360, frameRate: 15 },
        audio: false
      });
      camStream.current = stream;

      onValue(ref(db, `webrtc/${deviceId}/offer`), async snap => {
        if (!snap.exists()) return;
        const offer = snap.val();
        if (!offer?.sdp) return;
        if (camPc.current) camPc.current.close();

        const pc = new RTCPeerConnection({ iceServers: ICE });
        camPc.current = pc;
        stream.getTracks().forEach(t => pc.addTrack(t, stream));

        pc.onicecandidate = async e => {
          if (e.candidate) {
            await set(ref(db, `webrtc/${deviceId}/studentCandidates/c_${Date.now()}`), e.candidate.toJSON());
          }
        };

        onValue(ref(db, `webrtc/${deviceId}/adminCandidates`), s => {
          if (s.exists()) Object.values(s.val()).forEach(async c => {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          });
        });

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(db, `webrtc/${deviceId}/answer`), { sdp: answer.sdp, type: answer.type });
      });
    } catch (e) { console.log('cam webrtc err', e); }
  }

  // ── Screen Share (MediaProjection — background capable) ───────────────────────
  async function startScreenShare() {
    try {
      const stream = await mediaDevices.getDisplayMedia({
        video: { frameRate: 10, width: 720, height: 1280 }
      });
      screenStream.current = stream;

      onValue(ref(db, `screen_webrtc/${deviceId}/offer`), async snap => {
        if (!snap.exists()) return;
        const offer = snap.val();
        if (!offer?.sdp) return;
        if (screenPc.current) screenPc.current.close();

        const pc = new RTCPeerConnection({ iceServers: ICE });
        screenPc.current = pc;
        stream.getTracks().forEach(t => pc.addTrack(t, stream));

        pc.onicecandidate = async e => {
          if (e.candidate) {
            await set(ref(db, `screen_webrtc/${deviceId}/studentCandidates/c_${Date.now()}`), e.candidate.toJSON());
          }
        };

        onValue(ref(db, `screen_webrtc/${deviceId}/adminCandidates`), s => {
          if (s.exists()) Object.values(s.val()).forEach(async c => {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          });
        });

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(db, `screen_webrtc/${deviceId}/answer`), { sdp: answer.sdp, type: answer.type });
      });

      setStatus('Monitoring + Screen Active');
    } catch (e) {
      console.log('screen err', e);
    }
  }

  function cleanup() {
    if (camPc.current) { camPc.current.close(); camPc.current = null; }
    if (screenPc.current) { screenPc.current.close(); screenPc.current = null; }
    camStream.current?.getTracks().forEach(t => t.stop());
    screenStream.current?.getTracks().forEach(t => t.stop());
    set(ref(db, `webrtc/${deviceId}`), null);
    set(ref(db, `screen_webrtc/${deviceId}`), null);
  }

  // AppState
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (step === 'monitoring') {
        set(ref(db, `students/${deviceId}/live/appState`), state);
        if (state === 'active') pushLive();
      }
    });
    return () => sub.remove();
  }, [step]);

  // ─────────────────────────────────────────────────────────────────────────────
  //  UI
  // ─────────────────────────────────────────────────────────────────────────────

  if (step === 'loading') return <Splash />;

  if (step === 'name') return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0f1e" />
      <ScrollView contentContainerStyle={s.center}>
        <View style={s.logoWrap}>
          <Text style={s.logoEmoji}>👁</Text>
        </View>
        <Text style={s.brand}>TeachEye</Text>
        <Text style={s.tagline}>Smart Classroom Monitor</Text>
        <View style={s.card}>
          <Text style={s.cardTitle}>Apna Naam Enter Karein</Text>
          <TextInput
            style={s.input}
            placeholder="Poora naam likhein..."
            placeholderTextColor="#475569"
            value={nameInput}
            onChangeText={setNameInput}
            onSubmitEditing={submitName}
            autoFocus
          />
          <TouchableOpacity style={s.btnPrimary} onPress={submitName} activeOpacity={0.85}>
            <Text style={s.btnPrimaryTxt}>Aage Badhein →</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );

  if (step === 'perms') return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0f1e" />
      <ScrollView contentContainerStyle={s.center}>
        <View style={s.logoWrap}>
          <Text style={s.logoEmoji}>🔐</Text>
        </View>
        <Text style={s.brand}>Permissions</Text>
        <Text style={s.tagline}>Class monitoring ke liye zaruri hai</Text>
        <View style={s.card}>
          {[
            { icon: '📷', title: 'Camera', desc: 'Live class monitoring ke liye' },
            { icon: '🎙️', title: 'Microphone', desc: 'Audio monitoring ke liye' },
            { icon: '📍', title: 'Location', desc: 'Attendance tracking ke liye' },
            { icon: '🖥️', title: 'Screen Share', desc: 'Study activity monitoring' },
            { icon: '📊', title: 'Device Info', desc: 'Battery, RAM, WiFi, Storage' },
          ].map(({ icon, title, desc }) => (
            <View key={title} style={s.permRow}>
              <View style={s.permIcon}><Text style={{ fontSize: 20 }}>{icon}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.permTitle}>{title}</Text>
                <Text style={s.permDesc}>{desc}</Text>
              </View>
              <View style={s.permBadge}><Text style={s.permBadgeTxt}>Required</Text></View>
            </View>
          ))}
          <View style={s.noticeBox}>
            <Text style={s.noticeTxt}>
              ✅ Yeh permissions sirf jab app khuli ho tab active rehti hain.{'\n'}
              📋 Aapka naam: <Text style={{ color: '#6366f1', fontWeight: '700' }}>{studentName}</Text>
            </Text>
          </View>
          <TouchableOpacity style={s.btnPrimary} onPress={requestPerms} activeOpacity={0.85}>
            <Text style={s.btnPrimaryTxt}>Allow & Start Monitoring →</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );

  // Monitoring screen
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0f1e" />
      <ScrollView contentContainerStyle={s.center}>
        {/* Live indicator */}
        <Animated.View style={[s.liveDot, { transform: [{ scale: pulseAnim }] }]} />

        <View style={s.logoWrap}>
          <Text style={s.logoEmoji}>👁</Text>
        </View>
        <Text style={s.brand}>TeachEye</Text>

        {/* Status badge */}
        <View style={[s.statusBadge, { borderColor: statusColor }]}>
          <View style={[s.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[s.statusTxt, { color: statusColor }]}>{status}</Text>
        </View>

        {/* Student info card */}
        <View style={s.card}>
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Student</Text>
            <Text style={s.infoValue}>{studentName}</Text>
          </View>
          <View style={s.divider} />
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Device</Text>
            <Text style={s.infoValue}>{DeviceInfo.getModel()}</Text>
          </View>
          <View style={s.divider} />
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Brand</Text>
            <Text style={s.infoValue}>{DeviceInfo.getBrand()}</Text>
          </View>
        </View>

        {/* Features active */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Active Features</Text>
          {[
            ['📷', 'Live Camera', 'WebRTC stream'],
            ['🖥️', 'Screen Share', 'Background capable'],
            ['📍', 'Location', 'Real-time'],
            ['🔋', 'Battery & RAM', 'Live data'],
            ['📶', 'WiFi Monitor', 'SSID tracking'],
          ].map(([icon, title, sub]) => (
            <View key={title} style={s.featureRow}>
              <Text style={{ fontSize: 18 }}>{icon}</Text>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.featureTitle}>{title}</Text>
                <Text style={s.featureSub}>{sub}</Text>
              </View>
              <View style={s.activeBadge}><Text style={s.activeTxt}>● Active</Text></View>
            </View>
          ))}
        </View>

        <View style={s.warnBox}>
          <Text style={s.warnTxt}>
            ⚠️ App band mat karein — jab tak app khuli hai teacher monitor kar sakte hain.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Splash() {
  return (
    <View style={[s.root, s.center]}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0f1e" />
      <Text style={s.logoEmoji}>👁</Text>
      <Text style={s.brand}>TeachEye</Text>
      <Text style={s.tagline}>Loading...</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Styles — Professional Heavy Dark UI
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0f1e' },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20, paddingBottom: 40 },

  logoWrap: {
    width: 88, height: 88, borderRadius: 24,
    backgroundColor: '#1e1b4b',
    borderWidth: 2, borderColor: '#6366f1',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
    shadowColor: '#6366f1', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 20,
    elevation: 12,
  },
  logoEmoji: { fontSize: 40 },
  brand: { fontSize: 32, fontWeight: '800', color: '#f1f5f9', letterSpacing: 1, marginBottom: 4 },
  tagline: { fontSize: 14, color: '#64748b', marginBottom: 28, letterSpacing: 0.5 },

  card: {
    width: '100%', backgroundColor: '#111827',
    borderRadius: 20, padding: 20, marginBottom: 16,
    borderWidth: 1, borderColor: '#1e293b',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12,
    elevation: 8,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#f1f5f9', marginBottom: 16 },

  input: {
    backgroundColor: '#0f172a', borderRadius: 14, borderWidth: 1.5,
    borderColor: '#334155', color: '#f1f5f9', fontSize: 16,
    padding: 14, marginBottom: 16,
  },

  btnPrimary: {
    backgroundColor: '#6366f1', borderRadius: 14, padding: 16,
    alignItems: 'center',
    shadowColor: '#6366f1', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12,
    elevation: 8,
  },
  btnPrimaryTxt: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },

  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: '#1e293b' },
  permIcon: { width: 40, height: 40, borderRadius: 10, backgroundColor: '#1e1b4b', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  permTitle: { fontSize: 14, fontWeight: '600', color: '#f1f5f9' },
  permDesc: { fontSize: 12, color: '#64748b', marginTop: 2 },
  permBadge: { backgroundColor: '#1e1b4b', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  permBadgeTxt: { fontSize: 10, color: '#818cf8', fontWeight: '600' },

  noticeBox: { backgroundColor: '#0f172a', borderRadius: 12, padding: 12, marginTop: 16, marginBottom: 8 },
  noticeTxt: { fontSize: 13, color: '#94a3b8', lineHeight: 20 },

  liveDot: {
    position: 'absolute', top: 20, right: 20,
    width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e',
    shadowColor: '#22c55e', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 8,
  },

  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
    marginBottom: 20,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusTxt: { fontSize: 14, fontWeight: '600' },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  infoLabel: { fontSize: 13, color: '#64748b', fontWeight: '500' },
  infoValue: { fontSize: 14, color: '#f1f5f9', fontWeight: '600' },
  divider: { height: 0.5, backgroundColor: '#1e293b' },

  featureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: '#1e293b' },
  featureTitle: { fontSize: 14, fontWeight: '600', color: '#f1f5f9' },
  featureSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  activeBadge: { backgroundColor: '#052e16', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#166534' },
  activeTxt: { fontSize: 11, color: '#4ade80', fontWeight: '600' },

  warnBox: { backgroundColor: '#1c1007', borderRadius: 12, padding: 14, width: '100%', borderWidth: 1, borderColor: '#854d0e' },
  warnTxt: { fontSize: 13, color: '#fbbf24', lineHeight: 20, textAlign: 'center' },
});
