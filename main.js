/**
 * main.js（『HowLink』N1：殻と登場 ＋ N2：見せる・覚える）
 * 配線：登場（スタート画面→カメラ→挨拶）／会話／見せる／タップ配置／撮影モード。
 *
 * 設計原則（コンセプト設計 v0.2）:
 * - 数値を見せない：計測パネルは持ち込まない。状態はハウルの振る舞いで伝える
 * - イベント駆動の知覚：常時推論はしない。N1 では検知自体を持ち込まない
 * - すぐ始まる：モデルは MB 級のみ（仮モデル 7.1MB）
 * - キャラが主役の UI：吹き出し＋大きなボタン
 *
 * 挨拶は記憶ストアの静的エクスポート（data/memory.json）を参照する（静的連携）。
 * モデルは仮モデル（TRELLIS.2 生成＋afk.ai リグ、Walk/Trot/Run）。
 * 12月に Tripo Pro 生成モデルへ差し替える前提で、差し替えは avatar.glb の置換のみで済む。
 */
import * as THREE from 'three';
import { createScene, tryLoadAvatarModel } from './ar-viewer/scene.js?v=20261118-1';
import { createPlaceholderAvatar, createGlbAvatar } from './ar-viewer/avatar.js';
import { CameraManager } from './ar-viewer/camera.js?v=20261118-2';
import { generateReply, generateVisionReply, getApiKey, setApiKey } from './ai-agent-engine/gemini-client.js?v=20261117-5';
import { speak } from './ai-agent-engine/speech.js?v=20261118-4';
import { MotionController } from './motion-controller/motion-controller.js?v=20261113-9';
import { loadMemory, buildGreeting, memoryContext } from './memory/greeting.js?v=20261115-1';

const stage = document.getElementById('stage');
const container = document.getElementById('canvas-container');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const stageNote = document.getElementById('stage-note');
const startOverlay = document.getElementById('start-overlay');
const startButton = document.getElementById('start-button');
const cameraVideo = document.getElementById('camera-video');
const userInput = document.getElementById('user-input');
const talkButton = document.getElementById('talk-button');
const photoButton = document.getElementById('photo-button');
const showButton = document.getElementById('show-button');
const cameraButton = document.getElementById('camera-button');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings-panel');
const apiKeyInput = document.getElementById('api-key-input');
const saveKeyButton = document.getElementById('save-key-button');
const exportButton = document.getElementById('export-button');
const ghTokenInput = document.getElementById('gh-token-input');
const saveGhTokenButton = document.getElementById('save-gh-token-button');
const ownerPassInput = document.getElementById('owner-pass-input');
const setOwnerPassButton = document.getElementById('set-owner-pass-button');
const toggleOwnerButton = document.getElementById('toggle-owner-button');
const ownerStatus = document.getElementById('owner-status');
const syncStatus = document.getElementById('sync-status');
const statusLine = document.getElementById('status-line');
const photoUi = document.getElementById('photo-ui');
const photoExit = document.getElementById('photo-exit');
const shutterButton = document.getElementById('shutter-button');
const photoPreview = document.getElementById('photo-preview');
const photoImg = document.getElementById('photo-img');
const photoDownload = document.getElementById('photo-download');
const photoShowButton = document.getElementById('photo-show-button');
const photoReaction = document.getElementById('photo-reaction');
const galleryButton = document.getElementById('gallery-button');
const galleryEl = document.getElementById('gallery');
const galleryClose = document.getElementById('gallery-close');
const galleryGrid = document.getElementById('gallery-grid');
const galleryEmpty = document.getElementById('gallery-empty');
const galleryDetail = document.getElementById('gallery-detail');
const galleryDetailImg = document.getElementById('gallery-detail-img');
const galleryDetailDate = document.getElementById('gallery-detail-date');
const galleryShowButton = document.getElementById('gallery-show-button');
const galleryDeleteButton = document.getElementById('gallery-delete-button');
const galleryBackButton = document.getElementById('gallery-back-button');
const galleryReaction = document.getElementById('gallery-reaction');
const photoClose = document.getElementById('photo-close');

const { renderer, scene, camera, ground } = createScene(container);

// 通常モードのカメラの定位置。WebXR セッション中、three.js はこのカメラの
// position/quaternion を頭の姿勢で上書きし、終了しても元に戻さない。
// そのため終了時にここへ復元しないと、通常モードで視点が頭の最後の位置に
// 残り、オオカミが巨大化したり画面の端に張り付いたりする（2026-11-13 実機報告）。
const CAM_HOME_POS = camera.position.clone();
const CAM_HOME_QUAT = camera.quaternion.clone();

// 配置用アンカー：タップ配置で動かすのは外側のこのグループ。
// 感情モーションは内側のアバター本体に掛かるため競合しない（第一作の構成を踏襲）。
const anchor = new THREE.Group();
scene.add(anchor);

const placeholder = createPlaceholderAvatar();
placeholder.group.visible = false; // 起動直後にロボット（仮モデル）が見えないよう隠す。本モデルが来たら差し替え、失敗した時だけ出す
anchor.add(placeholder.group);
const motion = new MotionController(placeholder);

tryLoadAvatarModel().then((gltf) => {
  if (!gltf) {
    placeholder.group.visible = true; // 本モデルを読めなかった場合のフォールバック
    return;
  }
  const glbAvatar = createGlbAvatar(gltf);
  anchor.remove(placeholder.group);
  anchor.add(glbAvatar.group);
  motion.setAvatar(glbAvatar);
  headBone = null;
  glbAvatar.group.traverse((o) => {
    if (!headBone && o.isBone && o.name.toLowerCase() === 'head') headBone = o;
  });
  applyHeadCorrectionOnce();
});

// 仮モデル（TRELLIS.2生成）の顔は右下向きに焼き込まれているため、読み込み時に
// Headボーンの静止姿勢へ +32度 のヨー補正を一度だけ焼き込む（形状実測＋レンダ検証済み）。
// 毎フレーム合成は累積・競合の温床になるため行わない。ミキサーはこの姿勢を
// 「元の姿勢」として保持するので、静止時は常に補正が効いた状態になる。
// 12月にモデルを差し替えたら、この補正は外すこと。
const HEAD_YAW_CORRECTION = THREE.MathUtils.degToRad(32);
let headBone = null;
const _hq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _cq = new THREE.Quaternion();
const _upAxis = new THREE.Vector3(0, 1, 0);
function applyHeadCorrectionOnce() {
  if (!headBone || !headBone.parent) return;
  headBone.getWorldQuaternion(_hq);
  _cq.setFromAxisAngle(_upAxis, HEAD_YAW_CORRECTION).multiply(_hq);
  headBone.parent.getWorldQuaternion(_pq);
  headBone.quaternion.copy(_pq.invert().multiply(_cq));
  headBone.updateMatrixWorld(true);
}

statusLine.textContent = 'build 20261113-16';

// --- 記憶（静的連携） ---
let memory = { posts: [], episodes: [] };
let memCtx = '';
loadMemory().then((m) => {
  memory = m;
  refreshMemCtx();
});

// --- オーナーロック（「見せた記憶」はオーナーの端末でのみ記録する） ---
// 公開リンクから他人が開いた場合、その端末では合言葉が未設定のため記憶は一切残らない。
// 合言葉は SHA-256 ハッシュのみを localStorage に保存する（平文は保存しない）。
const OWNER_HASH_KEY = 'howling_owner_hash';
const OWNER_UNLOCK_KEY = 'howling_owner_unlocked';

function getOwnerHash() {
  try { return localStorage.getItem(OWNER_HASH_KEY) || ''; } catch { return ''; }
}

async function hashPassphrase(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`howlink-owner:${pw}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 記憶が有効か：合言葉が設定済みで、かつこの端末で解除されている場合のみ true */
function memoryEnabled() {
  if (!getOwnerHash()) return false;
  try { return localStorage.getItem(OWNER_UNLOCK_KEY) === '1'; } catch { return false; }
}

function setOwnerUnlocked(on) {
  try {
    if (on) localStorage.setItem(OWNER_UNLOCK_KEY, '1');
    else localStorage.removeItem(OWNER_UNLOCK_KEY);
  } catch { /* 保存できなくても体験は止めない */ }
  refreshOwnerStatus();
}

function refreshOwnerStatus() {
  if (!ownerStatus || !toggleOwnerButton) return;
  if (!getOwnerHash()) {
    ownerStatus.textContent = 'オーナーの合言葉が未設定です。この端末では「見せた記憶」は残りません。';
    toggleOwnerButton.textContent = 'オーナーモードを解除する';
  } else if (memoryEnabled()) {
    ownerStatus.textContent = 'オーナーモード：ON（見せた物は記憶されます）';
    toggleOwnerButton.textContent = 'オーナーモードをロックする';
  } else {
    ownerStatus.textContent = 'オーナーモード：ロック中（見せた物は記憶されません）';
    toggleOwnerButton.textContent = 'オーナーモードを解除する';
  }
}

// --- 見せた記憶（ローカルエピソード。N2「覚える」） ---
// 「見せる」で得た反応を localStorage に残し、会話の文脈へ合流させる。
// howl-agent の記憶ストアとの同期は N3。ここではローカル完結＋書き出しまで。
const EPISODES_KEY = 'howling_episodes';
const MAX_LOCAL_EPISODES = 50;

function loadLocalEpisodes() {
  try {
    const arr = JSON.parse(localStorage.getItem(EPISODES_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveShownEpisode(text, userText) {
  if (!memoryEnabled()) return; // オーナーモードでない端末では記憶しない（反応はするが残さない）
  const episodes = loadLocalEpisodes();
  episodes.push({
    id: `ep_${Date.now().toString(36)}${Math.floor(Math.random() * 10000)}`,
    date: new Date().toISOString(),
    kind: 'shown',
    text,
    userText: userText || '',
  });
  try {
    localStorage.setItem(EPISODES_KEY, JSON.stringify(episodes.slice(-MAX_LOCAL_EPISODES)));
  } catch { /* 保存できなくても体験は止めない */ }
  scheduleSync();
}

/** 直近の「見せた記憶」最大3件を、会話の文脈に足すためのテキスト */
function shownContext() {
  return loadLocalEpisodes()
    .slice(-3)
    .map((e) => `見せてもらった物への反応（${(e.date || '').slice(0, 10)}）: ${e.text}`)
    .join('\n');
}

/** 静的メモリ＋見せた記憶を合わせた会話文脈を memCtx に反映する */
function refreshMemCtx() {
  memCtx = [memoryContext(memory), shownContext()].filter(Boolean).join('\n');
}

// --- 見せた記憶の自動同期（GitHub Contents API → howlink.ar リポジトリの data/shown-episodes.json） ---
// howl-agent が投稿前に同ファイルを取得して中央ストアへ取り込む。
// トークンは Gemini キーと同じく localStorage にのみ保存し、ソースには含めない。
const GH_TOKEN_KEY = 'howling_github_token';
const SHOWN_REPO_API = 'https://api.github.com/repos/Joe-wolf-woof/howlink.ar/contents/data/shown-episodes.json';

function getGhToken() {
  try { return localStorage.getItem(GH_TOKEN_KEY) || ''; } catch { return ''; }
}

function setGhToken(v) {
  try {
    if (v) localStorage.setItem(GH_TOKEN_KEY, v);
    else localStorage.removeItem(GH_TOKEN_KEY);
  } catch { /* 保存できなくても体験は止めない */ }
}

function b64EncodeUtf8(s) { return btoa(unescape(encodeURIComponent(s))); }

function b64DecodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function setSyncStatus(text) {
  if (syncStatus) syncStatus.textContent = text;
}

let syncTimer = null;
let syncRunning = false;

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncShownEpisodes, 1200);
}

async function syncShownEpisodes() {
  const token = getGhToken();
  if (!token || syncRunning) return;
  if (!memoryEnabled()) return; // オーナーモードでない端末からは同期しない
  syncRunning = true;
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };
    let remote = [];
    let sha = null;
    const res = await fetch(SHOWN_REPO_API, { headers });
    if (res.ok) {
      const j = await res.json();
      sha = j.sha || null;
      try {
        const parsed = JSON.parse(b64DecodeUtf8(j.content || ''));
        if (Array.isArray(parsed)) remote = parsed;
      } catch { remote = []; }
    } else if (res.status !== 404) {
      throw new Error(`GitHub GET ${res.status}`);
    }
    const norm = (list) => list
      .filter((i) => i && i.date && i.text)
      .map((i) => ({ date: i.date, kind: 'shown', text: i.text }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const seen = new Set();
    const merged = [];
    for (const item of norm([...remote, ...loadLocalEpisodes()])) {
      const key = `${String(item.date).slice(0, 10)}|${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    if (JSON.stringify(merged) === JSON.stringify(norm(remote))) {
      setSyncStatus(`見せた記憶は同期済み（${merged.length}件）。`);
      return;
    }
    const put = await fetch(SHOWN_REPO_API, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Sync shown episodes from HowLink app',
        content: b64EncodeUtf8(JSON.stringify(merged, null, 2)),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) throw new Error(`GitHub PUT ${put.status}`);
    setSyncStatus(`見せた記憶を${merged.length}件同期した。`);
  } catch {
    setSyncStatus('見せた記憶の同期に失敗した（次回また試す）。');
  } finally {
    syncRunning = false;
  }
}

scheduleSync();

// --- 吹き出しと小さな通知 ---
let noteTimer = null;
function showNote(text, ms = 3200) {
  stageNote.textContent = text;
  stageNote.classList.remove('hidden');
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => stageNote.classList.add('hidden'), ms);
}

function showBubble(text) {
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
}

/** 感情タグ → 鳴き声の種類（speech.js の2種プリセットに対応） */
function cryForEmotion(emotion) {
  switch (emotion) {
    case 'happy': return 'bark'; // 発見・喜び → バウワウ（2連吠え）
    case 'pointing': return 'bark'; // 「見ろ、あちらだ」の発見も吠えで
    default: return 'wuff'; // 通常の返事・考え中 → 短い相槌ワフッ
  }
}

function say(text, emotion = 'idle', { speakIt = true, cry = null } = {}) {
  showBubble(text);
  motion.play(emotion);
  if (speakIt) speak(cry || cryForEmotion(emotion));
}

// --- 接地：タップした地面の位置へハウルが移動する（第一作 Phase 3-C を踏襲） ---
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const placeTarget = new THREE.Vector3();
let hasPlaceTarget = false;
let journeyMode = 'walk'; // タップ時点の総距離で決める移動モード（途中では切り替えない）
let photoMode = false;
let lastPhotoFrame = null; // 撮影した静止画（カメラのみ）—「写真を見せる」の認識用
let photoShowBusy = false;

const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.22, 40),
  new THREE.MeshBasicMaterial({
    color: 0xffd166, transparent: true, opacity: 0,
    side: THREE.DoubleSide, depthWrite: false,
  })
);
marker.rotation.x = -Math.PI / 2;
scene.add(marker);
let markerShownAt = -Infinity;

/** 移動目標をセットする（通常モードのタップと XR の select で共用） */
function setPlaceTarget(hit, { clamp = true } = {}) {
  const p = hit.clone();
  if (clamp) {
    p.x = THREE.MathUtils.clamp(p.x, -2.0, 2.0);
    p.z = THREE.MathUtils.clamp(p.z, -1.2, 1.8);
  }
  placeTarget.copy(p);
  hasPlaceTarget = true;
  // 残り距離ではなく「旅の総距離」で trot/walk を決める。
  // 残り距離判定だと閾値を超えるタップが少なく、超えても接近と同時に walk へ落ちてしまう。
  const journey = Math.hypot(p.x - anchor.position.x, p.z - anchor.position.z);
  journeyMode = journey > 0.85 ? 'trot' : 'walk';
  marker.position.set(p.x, floorY + 0.01, p.z);
  markerShownAt = performance.now();
}

// --- WebXR：実際の床に合わせる（対応端末のみ。通常モードはそのまま残す） ---
let xrSupported = false;
let xrActive = false;
let xrSession = null;
let hitTestSource = null;
let xrPlaced = false;
let xrHitSeen = false; // ヒットテストが一度でも床を捉えたか（診断用）
let lastHitAt = -Infinity; // 最後に床を捉えた時刻（レティクルの保持用）
let floorY = 0; // 現在の床の高さ（通常モードは 0、XR ではヒットテストで決まる）
let lastStageTapAt = -Infinity;

const reticleGeo = new THREE.RingGeometry(0.14, 0.2, 40);
reticleGeo.rotateX(-Math.PI / 2); // 姿勢クォータニオンで面に沿わせるため、法線を +Y にしておく
const reticle = new THREE.Mesh(
  reticleGeo,
  new THREE.MeshBasicMaterial({ color: 0x7ee2a8, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
);
reticle.visible = false;
scene.add(reticle);

let xrSupportNote = '';
let xrSupportPromise = null;
if (navigator.xr?.isSessionSupported) {
  xrSupportPromise = navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
    xrSupported = !!ok;
    if (xrSupported) {
      document.querySelector('.start-note').innerHTML =
        'カメラを使うと、あなたの部屋にハウルが現れます。<br />ARでは、実際の床の上にハウルが現れます。';
    } else {
      xrSupportNote = 'この端末・ブラウザではAR（WebXR）が使えないため、通常モードで開きます。';
      document.querySelector('.start-note').innerHTML += `<br />${xrSupportNote}`;
    }
    return xrSupported;
  }).catch((err) => {
    xrSupportNote = `AR対応の確認でエラー: ${err.name || err}`;
    document.querySelector('.start-note').innerHTML += `<br />${xrSupportNote}`;
    return false;
  });
} else {
  xrSupportNote = 'このブラウザはWebXRに未対応です（Chromeで開くとARが使えます）。';
}

async function startXR() {
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.body },
    });
    xrSession = session;
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    session.addEventListener('select', onXRSelect);
    session.addEventListener('end', onXRSessionEnd);
    xrActive = true;
    firstHitStableAt = -Infinity;
    anchor.visible = false; // 配置するまでは姿を見せない（原点＝目の高さに浮いて見えるため）
    document.body.classList.add('xr-on');
    cameraButton.textContent = 'AR終了';
    setTimeout(() => {
      if (xrActive && !xrHitSeen) {
        showNote('床が検出できていない。明るい場所で床を映し、ゆっくり動かして。', 7000);
      }
    }, 6000);
    return true;
  } catch (err) {
    xrSession = null;
    hitTestSource = null;
    showNote(`ARを開始できなかった（${err.name || 'Error'}: ${err.message || err}）。通常モードで開く。`, 9000);
    return false;
  }
}

/** AR：指定した床の点にハウルを立たせる（初回配置の共通処理） */
function placeWolfAt(point) {
  anchor.visible = true;
  anchor.position.copy(point);
  floorY = point.y;
  ground.position.y = floorY;
  // AR では通常モードの「見え方」に合わせる。通常モードは 4.6m 先から見た姿で、
  // 実寸 1.5m のままだと近くで巨大に見えるため、体長 約0.83m に縮小する（JOE指定）。
  anchor.scale.setScalar(0.55);
  xrPlaced = true;
  reticle.visible = false;
}

// 自動配置：床が安定して検出できたら、最低でもこの距離（m）だけ離して立たせる。
// 開始直後の見え方を「少し離れて立った」画角に統一するため（2026-11-18 JOE指定）。
const AR_AUTO_PLACE_MIN_DIST = 2.2;
let firstHitStableAt = -Infinity;

function onXRSelect(ev) {
  if (!xrActive) return;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!ev.frame || !refSpace) return;
  if (!xrPlaced) {
    // 配置前：レティクルの位置（実床のヒット点）に立たせる
    if (!reticle.visible) return;
    placeWolfAt(reticle.position);
    showNote('ハウルが床に立った。床をタップすると、そこへ移動する。');
    return;
  }
  // 配置後：タップのレイと床面の交点へ移動する。
  // UIボタンへのタップでも select は発火するため、ステージ自体へのタップと時刻で照合する。
  if (performance.now() - lastStageTapAt > 600) return;
  const pose = ev.frame.getPose(ev.inputSource.targetRaySpace, refSpace);
  if (!pose) return;
  const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
  if (Math.abs(dir.y) < 0.05) return;
  const t = (floorY - origin.y) / dir.y;
  if (t < 0.2 || t > 7) return;
  const target = origin.add(dir.multiplyScalar(t));
  target.y = floorY;
  setPlaceTarget(target, { clamp: false });
}

function onXRSessionEnd() {
  xrActive = false;
  xrPlaced = false;
  xrHitSeen = false;
  firstHitStableAt = -Infinity;
  anchor.visible = true;
  xrSession = null;
  if (hitTestSource) {
    hitTestSource.cancel();
    hitTestSource = null;
  }
  reticle.visible = false;
  floorY = 0;
  ground.position.y = 0;
  anchor.position.set(0, 0, 0);
  anchor.rotation.y = 0;
  anchor.scale.setScalar(1);
  // XR が上書きしたカメラの姿勢を通常モードの定位置へ復元する（上の CAM_HOME 参照）。
  camera.position.copy(CAM_HOME_POS);
  camera.quaternion.copy(CAM_HOME_QUAT);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  hasPlaceTarget = false;
  document.body.classList.remove('xr-on');
  cameraButton.textContent = cameraManager.isRunning ? 'カメラ切' : 'カメラ入';
  showNote('ARを終了した。通常モードに戻った。');
  // AR を抜けたら通常モードのカメラを自動で再開する。開始直後は AR に入るため
  // カメラが止まったままで、「見せる」が「カメラを入れて」と弾く食い違いが起きていた。
  // ラベルは startCamera 側が更新する（失敗したら「カメラ入」のまま）。
  startCamera();
}

container.addEventListener('pointerdown', (ev) => {
  if (!started || photoMode) return;
  lastStageTapAt = performance.now();
  if (xrActive) return; // XR中は select イベント側で処理する
  const rect = container.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) {
    hit.set(ndc.x * 2.4, 0, -1.2);
  }
  setPlaceTarget(hit);
});

const _camPos = new THREE.Vector3();

/** 角度の最短差分で滑らかに近づける */
function dampAngle(current, target, lambda, dt) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * (1 - Math.exp(-lambda * dt));
}

let lastLoopAt = performance.now();
function loop(now, frame) {
  const dt = Math.min((now - lastLoopAt) / 1000, 0.05);
  lastLoopAt = now;

  // XR 配置前：ヒットテストで実床の位置にレティクルを出す。
  // 床を見失っても 0.6 秒は残す（チラつき防止と、タップの狙いを付けやすくするため）。
  if (xrActive && !xrPlaced && hitTestSource && frame) {
    const refSpace = renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length) {
      xrHitSeen = true;
      lastHitAt = now;
      if (refSpace) {
        const pose = hits[0].getPose(refSpace);
        if (pose) {
          reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
          reticle.quaternion.set(
            pose.transform.orientation.x, pose.transform.orientation.y,
            pose.transform.orientation.z, pose.transform.orientation.w
          );
          reticle.visible = true;
          // 自動配置：床が 0.4 秒安定して検出できたら、タップを待たずに立たせる。
          // ヒット点が近すぎる場合は、開始直後の画角を統一するため最低距離まで離す。
          if (firstHitStableAt < 0) firstHitStableAt = now;
          if (now - firstHitStableAt >= 400) {
            const p = reticle.position.clone();
            camera.getWorldPosition(_camPos);
            const dx = p.x - _camPos.x;
            const dz = p.z - _camPos.z;
            const d = Math.hypot(dx, dz);
            if (d > 0.001 && d < AR_AUTO_PLACE_MIN_DIST) {
              const k = AR_AUTO_PLACE_MIN_DIST / d;
              p.x = _camPos.x + dx * k;
              p.z = _camPos.z + dz * k;
            }
            placeWolfAt(p);
            showNote('ハウルが床に立った。床をタップすると、そこへ移動する。');
          }
        }
      }
    } else if (now - lastHitAt > 600) {
      reticle.visible = false;
      firstHitStableAt = -Infinity;
    }
  }

  let mode = 'idle';
  if (hasPlaceTarget && !photoMode) {
    const dx = placeTarget.x - anchor.position.x;
    const dz = placeTarget.z - anchor.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.03) {
      mode = dist < 0.3 ? 'walk' : journeyMode; // 到着間際だけ walk に落として自然に減速
      const speed = mode === 'trot' ? 3.6 : 2.0;
      const step = Math.min(dist, speed * dt);
      anchor.position.x += (dx / dist) * step;
      anchor.position.z += (dz / dist) * step;
      anchor.rotation.y = dampAngle(anchor.rotation.y, Math.atan2(dx, dz), 12, dt);
    } else {
      // 着いたらカメラ（XR中はユーザー本人）の方を向く
      camera.getWorldPosition(_camPos);
      const faceYaw = Math.atan2(_camPos.x - anchor.position.x, _camPos.z - anchor.position.z);
      anchor.rotation.y = dampAngle(anchor.rotation.y, faceYaw, 6, dt);
    }
  } else if (photoMode) {
    // 撮影中はカメラ（正面）を向く
    anchor.rotation.y = dampAngle(anchor.rotation.y, 0, 6, dt);
  }
  motion.setLocomotion(mode);

  const mt = (now - markerShownAt) / 1400;
  if (mt < 1) {
    marker.material.opacity = 0.9 * (1 - mt);
    const s = 1 + mt * 0.9;
    marker.scale.set(s, s, 1);
  } else {
    marker.material.opacity = 0;
  }

  motion.update(now);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop); // XR 提示中も回り続けるよう、rAF ではなくこちらを使う

// --- カメラ ---
const cameraManager = new CameraManager(cameraVideo);

async function startCamera() {
  if (cameraManager.isRunning) return true;
  try {
    await cameraManager.start();
    document.body.classList.add('camera-on');
    cameraButton.textContent = 'カメラ切';
    return true;
  } catch {
    return false;
  }
}

function stopCamera() {
  cameraManager.stop();
  document.body.classList.remove('camera-on');
  cameraButton.textContent = 'カメラ入';
}

cameraButton.addEventListener('click', async () => {
  if (xrActive) {
    // AR 中はこのボタンが「AR終了」になる（通常モードへ戻る出口）。
    // セッションを終えると 'end' イベント経由で onXRSessionEnd が後片付けする。
    const session = xrSession;
    if (session) {
      try {
        await session.end();
      } catch {
        if (xrActive) onXRSessionEnd();
      }
    } else {
      onXRSessionEnd();
    }
    return;
  }
  if (cameraManager.isRunning) {
    stopCamera();
    showNote('カメラを止めた。ワガハイはここにいる。');
  } else if (!(await startCamera())) {
    showNote('カメラを始められなかった。許可を確認してくれ。');
  }
});

// --- 登場：スタート画面 → （AR or カメラ） → 記憶を踏まえた挨拶 ---
let started = false;
async function ensureMemory() {
  // 記憶の読み込みが終わっていない場合は少し待つ（挨拶に使うため）
  if (!memCtx && memory.posts.length === 0 && memory.episodes.length === 0) {
    await loadMemory().then((m) => { memory = m; refreshMemCtx(); });
  }
}
function dismissStartOverlay() {
  startOverlay.classList.add('fading');
  setTimeout(() => startOverlay.classList.add('hidden'), 700);
}

async function beginWithCamera() {
  const cameraOk = await startCamera();
  if (!cameraOk) showNote('カメラなしでも会える。部屋の様子は見えていないがな。');
  await ensureMemory();
  say(buildGreeting(memory), 'happy', { cry: 'wuff' }); // 挨拶も短い相槌ワフッ
}

// 開始ボタンは1つに統一（2026-11-18 JOE指定）。対応端末では AR で開始し、
// 床が検出できたら自動で少し離れた位置に立たせることで、開始直後の画角を
// 「通常モード→AR で離れて立った」見え方に統一する。AR が使えない端末・
// 開始に失敗した場合は通常モード（カメラ）で開始する。
startButton.addEventListener('click', async () => {
  if (started) return;
  started = true;
  dismissStartOverlay();
  const supported = xrSupportPromise ? await xrSupportPromise : xrSupported;
  if (supported && (await startXR())) {
    showNote('床にスマホを向けて。ハウルが床に立つ。');
    await ensureMemory();
    say(buildGreeting(memory), 'happy', { cry: 'wuff' }); // 挨拶も短い相槌ワフッ
    return;
  }
  await beginWithCamera();
});

// --- 会話 ---
let talkBusy = false;
async function talk() {
  if (talkBusy) return;
  const text = userInput.value.trim() || 'こんにちは';
  talkBusy = true;
  talkButton.disabled = true;
  showBubble('……');
  motion.play('thinking'); // 待っている間も「考えている」ことが見えるように
  try {
    const reply = await generateReply(text, memCtx);
    say(reply.text, reply.emotion);
    userInput.value = '';
  } catch (err) {
    say('うまく考えがまとまらなかった。もう一度言ってくれ。', 'thinking', { speakIt: false });
    statusLine.textContent = `エラー: ${err.message}`;
  } finally {
    talkBusy = false;
    talkButton.disabled = false;
  }
}
talkButton.addEventListener('click', talk);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') talk();
});

// --- 見せる（体験B：カメラ越しに物を見せると反応し、その反応が記憶に残る） ---
let showBusy = false;
async function showToHowl() {
  if (showBusy || talkBusy) return;
  if (xrActive) {
    showNote('見せるは通常モードで使ってくれ。戻るには「AR終了」を押して。');
    return;
  }
  if (!cameraManager.isRunning) {
    showNote('カメラが止まっている。「カメラ入」を押してから見せてくれ。');
    return;
  }
  const frame = cameraManager.captureFrame();
  if (!frame) {
    showNote('まだ映像が届いていない。少し待ってから見せて。');
    return;
  }
  const userText = userInput.value.trim();
  showBusy = true;
  showButton.disabled = true;
  showBubble('……');
  motion.play('thinking'); // 待っている間も「見ている」ことが伝わるように
  try {
    const reply = await generateVisionReply(frame, userText);
    say(reply.text, reply.emotion);
    saveShownEpisode(reply.text, userText); // 覚える：反応をエピソードとして保存
    refreshMemCtx(); // 以後の会話で「前に見せてもらった物」に触れられるようにする
    if (userText) userInput.value = '';
  } catch (err) {
    say('よく見えなかった。もう一度見せてくれ。', 'thinking', { speakIt: false });
    statusLine.textContent = `エラー: ${err.message}`;
  } finally {
    showBusy = false;
    showButton.disabled = false;
  }
}
showButton.addEventListener('click', showToHowl);

// --- 設定（APIキー） ---
apiKeyInput.value = getApiKey();
settingsButton.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});
saveKeyButton.addEventListener('click', () => {
  setApiKey(apiKeyInput.value.trim());
  statusLine.textContent = 'キーを保存した。次に話すときから使う。';
});
ghTokenInput.value = getGhToken();
saveGhTokenButton.addEventListener('click', async () => {
  setGhToken(ghTokenInput.value.trim());
  statusLine.textContent = 'GitHubトークンを保存した。';
  await syncShownEpisodes();
});

// --- 設定（オーナーロック） ---
refreshOwnerStatus();
setOwnerPassButton.addEventListener('click', async () => {
  const pw = ownerPassInput.value.trim();
  if (!pw) { statusLine.textContent = '合言葉を入力して。'; return; }
  const h = await hashPassphrase(pw);
  try { localStorage.setItem(OWNER_HASH_KEY, h); } catch { /* 保存できなくても体験は止めない */ }
  ownerPassInput.value = '';
  setOwnerUnlocked(true);
  statusLine.textContent = '合言葉を設定した。この端末では見せた物を記憶する。';
  scheduleSync();
});
toggleOwnerButton.addEventListener('click', async () => {
  if (memoryEnabled()) {
    setOwnerUnlocked(false);
    statusLine.textContent = 'オーナーモードをロックした。';
    return;
  }
  if (!getOwnerHash()) { statusLine.textContent = '先に合言葉を設定して。'; return; }
  const pw = ownerPassInput.value.trim();
  if (!pw) { statusLine.textContent = '合言葉を入力してから解除して。'; return; }
  const h = await hashPassphrase(pw);
  if (h === getOwnerHash()) {
    ownerPassInput.value = '';
    setOwnerUnlocked(true);
    statusLine.textContent = 'オーナーモードを解除した。見せた物を記憶する。';
    scheduleSync();
  } else {
    statusLine.textContent = '合言葉が違う。';
  }
});

// --- 見せた記憶の書き出し（将来 howl-agent のエピソード記憶へ取り込む連携フォーマット） ---
exportButton.addEventListener('click', () => {
  const episodes = loadLocalEpisodes();
  if (!episodes.length) {
    statusLine.textContent = '見せた記憶はまだない。';
    return;
  }
  const data = episodes.map((e) => ({ date: e.date, kind: 'shown', text: e.text }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'howling-episodes.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  statusLine.textContent = `見せた記憶を${data.length}件書き出した。`;
});

// --- 撮った写真の蓄積（IndexedDB） ---
// 写真はこの端末のブラウザ内に貯まる。合成写真（表示用）と、カメラだけの
// フレーム（後から「見せる」用）を一緒に保存する。
const PHOTO_DB_NAME = 'howlink-photos';
const PHOTO_STORE_NAME = 'photos';
const MAX_STORED_PHOTOS = 100;
let photoDbPromise = null;

function openPhotoDb() {
  if (!photoDbPromise) {
    photoDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(PHOTO_DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(PHOTO_STORE_NAME, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return photoDbPromise;
}

async function listPhotos() {
  const db = await openPhotoDb();
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(PHOTO_STORE_NAME, 'readonly').objectStore(PHOTO_STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return all.sort((a, b) => (a.date < b.date ? 1 : -1)); // 新しい順
}

async function storePhoto(record) {
  const db = await openPhotoDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE_NAME, 'readwrite');
    tx.objectStore(PHOTO_STORE_NAME).add(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  // 上限を超えたら古いものから消す。
  const all = await listPhotos();
  if (all.length > MAX_STORED_PHOTOS) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PHOTO_STORE_NAME);
      all.slice(MAX_STORED_PHOTOS).forEach((p) => store.delete(p.id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}

async function deleteStoredPhoto(id) {
  const db = await openPhotoDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE_NAME, 'readwrite');
    tx.objectStore(PHOTO_STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// --- 写真一覧（ギャラリー） ---
let currentGalleryPhoto = null;
let galleryShowBusy = false;

async function renderGallery() {
  const photos = await listPhotos().catch(() => []);
  galleryGrid.innerHTML = '';
  galleryEmpty.classList.toggle('hidden', photos.length > 0);
  galleryDetail.classList.add('hidden');
  galleryGrid.classList.remove('hidden');
  currentGalleryPhoto = null;
  photos.forEach((photo) => {
    const item = document.createElement('button');
    item.className = 'gallery-item';
    const img = document.createElement('img');
    img.src = photo.image;
    img.alt = '保存した写真';
    img.loading = 'lazy';
    item.appendChild(img);
    item.addEventListener('click', () => openGalleryDetail(photo));
    galleryGrid.appendChild(item);
  });
}

function openGalleryDetail(photo) {
  currentGalleryPhoto = photo;
  galleryDetailImg.src = photo.image;
  galleryDetailDate.textContent = new Date(photo.date).toLocaleString('ja-JP');
  galleryReaction.textContent = '';
  galleryShowButton.disabled = !photo.frame;
  galleryGrid.classList.add('hidden');
  galleryDetail.classList.remove('hidden');
}

galleryButton.addEventListener('click', () => {
  galleryEl.classList.remove('hidden');
  renderGallery();
});
galleryClose.addEventListener('click', () => galleryEl.classList.add('hidden'));
galleryBackButton.addEventListener('click', () => renderGallery());
galleryDeleteButton.addEventListener('click', async () => {
  if (!currentGalleryPhoto) return;
  await deleteStoredPhoto(currentGalleryPhoto.id).catch(() => {});
  renderGallery();
});
galleryShowButton.addEventListener('click', async () => {
  const photo = currentGalleryPhoto;
  if (!photo || !photo.frame || galleryShowBusy) return;
  galleryShowBusy = true;
  galleryShowButton.disabled = true;
  galleryReaction.textContent = 'じっくり見ている。人間は興味深い…。';
  try {
    const reply = await generateVisionReply(photo.frame, '');
    galleryReaction.textContent = reply.text;
    say(reply.text, reply.emotion);
    saveShownEpisode(reply.text, ''); // 覚える（記録はオーナーモードの端末のみ）
    refreshMemCtx();
  } catch (err) {
    galleryReaction.textContent = `よく見えなかった。もう一度試してくれ。（${err.message}）`;
  } finally {
    galleryShowBusy = false;
    galleryShowButton.disabled = false;
  }
});

// --- 撮影モード（体験C） ---
function enterPhotoMode() {
  photoMode = true;
  hasPlaceTarget = false;
  document.body.classList.add('photo-mode');
  photoUi.classList.remove('hidden');
}
function exitPhotoMode() {
  photoMode = false;
  document.body.classList.remove('photo-mode');
  photoUi.classList.add('hidden');
}
photoButton.addEventListener('click', () => {
  if (xrActive) {
    showNote('写真は通常モードで撮ってくれ。戻るには「AR終了」を押して。');
    return;
  }
  enterPhotoMode();
});
photoExit.addEventListener('click', exitPhotoMode);

function capturePhoto() {
  renderer.render(scene, camera);
  const gl = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = gl.width;
  out.height = gl.height;
  const ctx = out.getContext('2d');

  if (cameraManager.isRunning && cameraVideo.readyState >= 2) {
    // <video> の object-fit: cover と同じ見え方で合成する
    const vw = cameraVideo.videoWidth;
    const vh = cameraVideo.videoHeight;
    const scale = Math.max(out.width / vw, out.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(cameraVideo, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, out.height);
    grad.addColorStop(0, '#2a3348');
    grad.addColorStop(1, '#141926');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(gl, 0, 0);

  // 認識用に、カメラだけのフレームも別に残す（合成写真にはオオカミが写り込むため）。
  // ライブ映像の「見せる」より静止画の方がブレず、認識が安定する。
  lastPhotoFrame = null;
  if (cameraManager.isRunning && cameraVideo.readyState >= 2 && cameraVideo.videoWidth) {
    const vw = cameraVideo.videoWidth;
    const vh = cameraVideo.videoHeight;
    const pScale = Math.min(1, 1024 / Math.max(vw, vh));
    const pc = document.createElement('canvas');
    pc.width = Math.round(vw * pScale);
    pc.height = Math.round(vh * pScale);
    pc.getContext('2d').drawImage(cameraVideo, 0, 0, pc.width, pc.height);
    const purl = pc.toDataURL('image/jpeg', 0.8);
    lastPhotoFrame = { mimeType: 'image/jpeg', data: purl.split(',')[1] };
  }
  photoReaction.textContent = '';
  photoShowButton.disabled = !lastPhotoFrame;

  // 蓄積用に、合成写真を縮小JPEGでも保存する（一覧で見返し、後から見せ直せるように）。
  try {
    const sScale = Math.min(1, 1280 / Math.max(out.width, out.height));
    const sc = document.createElement('canvas');
    sc.width = Math.round(out.width * sScale);
    sc.height = Math.round(out.height * sScale);
    sc.getContext('2d').drawImage(out, 0, 0, sc.width, sc.height);
    const storedImage = sc.toDataURL('image/jpeg', 0.82);
    storePhoto({ date: new Date().toISOString(), image: storedImage, frame: lastPhotoFrame }).catch(() => {});
  } catch { /* 保存に失敗しても撮影自体は続ける */ }

  const url = out.toDataURL('image/png');
  photoImg.src = url;
  photoDownload.href = url;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  photoDownload.download = `howling-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  photoPreview.classList.remove('hidden');
}
shutterButton.addEventListener('click', capturePhoto);
photoClose.addEventListener('click', () => {
  photoPreview.classList.add('hidden');
});

// --- 写真を見せる（撮影した静止画を認識・記憶する） ---
photoShowButton.addEventListener('click', async () => {
  if (!lastPhotoFrame || photoShowBusy) return;
  photoShowBusy = true;
  photoShowButton.disabled = true;
  photoReaction.textContent = 'じっくり見ている。人間は興味深い…。';
  try {
    const reply = await generateVisionReply(lastPhotoFrame, '');
    photoReaction.textContent = reply.text;
    say(reply.text, reply.emotion);
    saveShownEpisode(reply.text, ''); // 覚える（記録はオーナーモードの端末のみ）
    refreshMemCtx();
  } catch (err) {
    photoReaction.textContent = `よく見えなかった。もう一度試してくれ。（${err.message}）`;
  } finally {
    photoShowBusy = false;
    photoShowButton.disabled = false;
  }
});
