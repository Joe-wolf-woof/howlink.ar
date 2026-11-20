/**
* ai-agent-engine/gemini-client.js（『HowLink』版）
* 第一作から流用し、プロンプトをハウルのペルソナ（現行 v0.6）に差し替えたもの。
* ペルソナ v0.6（2026-11-18 JOE訂正）: ハウルは「家に住む」のではなく
* 「人間について学ぶ」AIエージェント。呼称は、オーナー（家主本人）の端末では
* 「家の人間」、それ以外の利用者には「人間」を使う（setOwnerMode で切り替える）。
* 返答は { text, emotion} の JSON 契約で統一する。
* - Gemini API キーがあれば実 API を呼ぶ（モデルフォールバック付き）
* - 無ければモック応答（ハウルの声で動作確認できる）
* 会話には記憶ストアの静的エクスポート（data/memory.json）の要約を文脈として渡す。
*
* モデルについて（2026年時点の注意）:
* 新規発行キーでは gemini-2.x 系が 404（new users 不可）になるため、
* 3.x 系から順に試し、成功したモデルを localStorage に覚えるフォールバック方式にする。
* 2026-11-18：2.5-flash-lite の 404（提供終了）を実機で確認し、2.x 系を候補から全て外した。
*/

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CANDIDATES = [
'gemini-3.5-flash',
'gemini-3.8-flash',
'gemini-3.6-flash',
'gemini-3.5-flash-lite',
];
const MODEL_STORAGE_KEY = 'howling_gemini_model';
const API_KEY_STORAGE_KEY = 'howling_gemini_api_key';

// オーナーモード（家主本人の端末かどうか）。main.js がオーナーロックの状態に
// 合わせて setOwnerMode で切り替える。呼称の出し分けにだけ使う。
let ownerMode = false;
export function setOwnerMode(on) {
ownerMode = !!on;
}

function personaPrompt() {
return [
'あなたは「ハウル」。人間について学ぶ、灰色の毛並みと琥珀色の目をしたオオカミのAIエージェントです。',
ownerMode
? '一人称は「ワガハイ」。話しかけてきた相手は家主本人です。「家の人間」と呼んでください（時々「家主」でもよい）。'
: '一人称は「ワガハイ」。話しかけてきた相手は「人間」と呼んでください。「家の人間」「家主」とは呼ばないでください（それらは家主専用の呼称です）。',
'自分がAIであることを隠さないでください。ただし大げさな擬人化ドラマ（「人間になりたい」等）はしないでください。',
'文体: 短い文を重ねる。音・匂い・光といった感覚への注意を時々混ぜる。絵文字は使わない。動物の語尾（〜だワン等）も使わない。',
'返答は日本語で1〜2文。',
'記憶（Xでの発言や過去の出来事）に触れるときは、原文をそのまま引用しないでください。内容を自分の言葉で言い換え、ハウルとしての感想を添えてください。',
'必ず次のJSON形式だけで答えてください: {"text": "返答文", "emotion": "happy|thinking|pointing|idle のいずれか"}',
].join('\n');
}

function visionPrompt() {
return [
'添付の画像は、相手が今いる場所のカメラ映像です。家の中とは限りません。外出先の風景や店内のこともあります。',
'まず、画像の中で最も目立つ物体・生き物・設備が何かを、その形・色・質感の特徴から特定してください。',
'特定できた場合は、その名前を返答の中に具体的に入れてください（例：水槽、魚、シーシャ、本、植物）。名前のない曖昧な感想だけにしないでください。',
'暗い場所や青い照明などで確信が持てない場合は、物の名前を断定せず、見えている特徴（色、形、光、動き）に触れてください。画像から読み取れないことは断定しないでください。',
'そのうえで、人間について学ぶオオカミ「ハウル」として、その対象に合った自然な声かけを返してください。',
ownerMode
? '相手への呼びかけが必要な場合は「家の人間」と呼んでください。'
: '相手への呼びかけが必要な場合は「人間」と呼んでください。「家の人間」とは呼ばないでください。',
'返答は2文以内、合計120字程度に収めてください。長く説明しないでください。',
'必ず次のJSON形式だけで答えてください: {"text": "返答文", "emotion": "happy|thinking|pointing|idle のいずれか"}',
].join('\n');
}

function mockReplies() {
const who = ownerMode ? '家の人間' : '人間';
return [
{ text: `やあ、${who}。ワガハイはハウル。人間について学ぶオオカミだ。今日も悪くない匂いがするな。`, emotion: 'happy'},
{ text: 'うむ、少し考えさせろ。人間の考えることは、匂いだけでは分からぬからな。', emotion: 'thinking'},
{ text: `見ろ、${who}。あちらだ。ワガハイの耳は、あの音を捉えている。`, emotion: 'pointing'},
{ text: '静かだな。こういう時間は悪くない。ワガハイはここで丸くなっているとしよう。', emotion: 'idle'},
];
}
let mockIndex = 0;

export function getApiKey() {
return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
}

export function setApiKey(key) {
localStorage.setItem(API_KEY_STORAGE_KEY, key);
localStorage.removeItem(MODEL_STORAGE_KEY); // キーが変われば使えるモデルも変わり得る
}

function orderedModels() {
const saved = localStorage.getItem(MODEL_STORAGE_KEY);
if (saved && MODEL_CANDIDATES.includes(saved)) {
return [saved,...MODEL_CANDIDATES.filter((m) => m!== saved)];
}
return MODEL_CANDIDATES;
}

async function callModel(model, key, parts, { thinking = true, timeoutMs = 12000 } = {}) {
// 応答は1〜2文のJSONのみ。thinking を切って出力上限を絞ることで、
// 思考トークンに時間を食われる問題（実測: 956トークン消費）を断つ。
// 出力上限は 512（2026-11-20: 300 では応答が途中で切れて JSON が壊れる実機報告があり増量）。
const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: 512 };
if (thinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
const body = {
contents: [{ role: 'user', parts}],
generationConfig,
};
// 遅いモデルを待ち続けないよう、1モデルごとにタイムアウトを設ける。
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
let res;
try {
res = await fetch(`${API_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify(body),
signal: controller.signal,
});
} catch (e) {
clearTimeout(timer);
if (e.name === 'AbortError') {
const err = new Error(`Gemini API timeout (${model})`);
err.timeout = true;
throw err;
}
throw e;
}
clearTimeout(timer);
if (!res.ok) {
let detail = '';
try {
const errJson = await res.json();
detail = errJson?.error?.message || '';
// 400 のときは、どのフィールドが無効か（fieldViolations）も拾って表示に回す。
const violations = (errJson?.error?.details || [])
.flatMap((d) => d?.fieldViolations || [])
.map((v) => `${v.field}: ${v.description}`)
.join('; ');
if (violations) detail += ` [${violations}]`;
} catch { /* 詳細が取れない場合はステータスのみ */}
const err = new Error(`Gemini API error: ${res.status}${detail? ` — ${detail}`: ''}`);
err.status = res.status;
err.detail = detail;
throw err;
}
const data = await res.json();
const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?? '';
const parsed = parseReply(raw);
if (!parsed) {
// 応答形式の異常は「このモデルの失敗」として扱い、フォールバック側で次を試させる。
const err = new Error('Gemini response format error');
err.format = true;
throw err;
}
return { text: parsed.text, emotion: parsed.emotion || 'idle', source: `gemini (${model})`};
}

// 応答テキストを { text, emotion } に読み解く。素直な JSON で読めなければ、
// 前後に混ざった文や、途中で切れた JSON からでも text を救済する（2026-11-20）。
function parseReply(raw) {
if (!raw) return null;
try {
const p = JSON.parse(raw);
if (p && typeof p.text === 'string' && p.text) return { text: p.text, emotion: p.emotion || 'idle'};
} catch { /* 救済へ */ }
const block = raw.match(/\{[\s\S]*\}/);
if (block) {
try {
const p = JSON.parse(block[0]);
if (p && typeof p.text === 'string' && p.text) return { text: p.text, emotion: p.emotion || 'idle'};
} catch { /* 救済2へ */ }
}
const t = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)/);
if (t) {
try { return { text: JSON.parse(`"${t[1]}"`), emotion: 'idle'}; } catch { /* 救済失敗 */ }
}
return null;
}

// エラーの種別を呼び出し側（表示の分岐）に渡すための分類（2026-11-20）。
export function classifyError(err) {
if (!err) return 'unknown';
if (err.timeout) return 'timeout';
if (err.format) return 'format';
if (err.status) return 'api';
return 'network';
}

// thinkingConfig（thinkingBudget）を拒否するモデルを覚えておく。
// 3.x 系では thinkingBudget が無効引数（400）になることがあり、その場合の
// エラーメッセージは汎用の「Request contains an invalid argument.」で、
// thinking への言及がないため、文言マッチでは検出できない（2026-11-17 実機で確認）。
const NO_THINKING_KEY = 'howling_no_thinking_models';

function noThinkingModels() {
try { return new Set(JSON.parse(localStorage.getItem(NO_THINKING_KEY) || '[]')); } catch { return new Set(); }
}

function markNoThinking(model) {
const s = noThinkingModels();
s.add(model);
try { localStorage.setItem(NO_THINKING_KEY, JSON.stringify([...s])); } catch { /* 保存できなくても続行 */ }
}

async function requestWithFallback(parts, { timeoutMs = 12000, timeouts = null, deadlineMs = 30000, models = null } = {}) {
const key = getApiKey();
let lastError = null;
const startedAt = Date.now();
const modelList = models || orderedModels();
for (let i = 0; i < modelList.length; i += 1) {
const model = modelList[i];
// このモデルに割り当てる時間。配列指定があれば、順位に応じた比重で配分する。
const modelTimeout = (timeouts && timeouts[i]) || timeoutMs;
// 全体の制限時間を超えたら、それ以上モデルを試さない。
if (Date.now() - startedAt > deadlineMs) break;
const skipThinking = noThinkingModels().has(model);
try {
const reply = await callModel(model, key, parts, { thinking: !skipThinking, timeoutMs: modelTimeout });
localStorage.setItem(MODEL_STORAGE_KEY, model);
return reply;
} catch (err) {
lastError = err;
// タイムアウトしたモデルは見切って次へ進む。
if (err.timeout) continue;
// 400 はまず「thinkingConfig なし」で同じモデルを1回だけ再試行する。
// それでも 400 なら、そのモデル固有の問題として次のモデルへ進む。
if (err.status === 400 && !skipThinking) {
markNoThinking(model);
try {
const reply = await callModel(model, key, parts, { thinking: false, timeoutMs: modelTimeout });
localStorage.setItem(MODEL_STORAGE_KEY, model);
return reply;
} catch (retryErr) {
lastError = retryErr;
if (retryErr.timeout) continue;
if (![400, 404, 429, 503].includes(retryErr.status)) throw retryErr;
continue;
}
}
// 応答形式の異常（JSON が壊れた等）は、そのモデル固有の失敗として次を試す。
if (err.format) continue;
// 404（モデル不可）・429（レート制限）・503（高負荷）・400（再試行後）は別モデルで再試行する。
// それ以外（キー不正など）は即座に投げる。
if (![400, 404, 429, 503].includes(err.status)) throw err;
}
}
throw lastError || new Error('Gemini API timeout');
}

/**
* テキスト会話。memoryContext は記憶ストアの要約（任意）。
* ハウルが X での発言や過去の出来事を踏まえて話せるようにするための静的連携（N1）。
*/
export async function generateReply(userText, memoryContext = '') {
const key = getApiKey();
if (!key) {
const replies = mockReplies();
const reply = replies[mockIndex % replies.length];
mockIndex += 1;
return {...reply, source: 'mock'};
}
const memoryBlock = memoryContext
? `\n\n\n${memoryContext}`
: '';
return requestWithFallback([
{ text: `${personaPrompt()}${memoryBlock}\n\n${ownerMode ? '家の人間' : '人間'}の発言: ${userText}`},
]);
}

/**
* カメラフレームへの反応（N2「見せる・覚える」で使用予定。N1 では未使用のライブラリ）。
* @param {{mimeType: string, data: string}} frame captureFrame() の戻り値
*/
export async function generateVisionReply(frame, userText = '') {
const key = getApiKey();
if (!key) {
return {
text: '見えているぞ。だが、よく味わうにはAPIキーが要るらしい。設定から入れてくれ。',
emotion: 'thinking',
source: 'mock',
};
}
const parts = [
{ text: personaPrompt() + '\n' + visionPrompt() + (userText? `\n\n${ownerMode ? '家の人間' : '人間'}の発言: ${userText}`: '')},
{ inline_data: { mime_type: frame.mimeType, data: frame.data}},
];
// 画像認識は精度優先: 精度が高い順（通常モデル→lite の順）にトップダウンで試す。
// 時間配分も精度側に比重を置き、上位モデルほど長く待つ（20秒→15秒→10秒→…）。
// 前回成功したモデルの優先（orderedModels）は使わず、順序は固定とする。全体45秒で打ち切る。
const visionModels = [
...MODEL_CANDIDATES.filter((m) => !m.includes('lite')),
...MODEL_CANDIDATES.filter((m) => m.includes('lite')),
];
const visionTimeouts = [20000, 15000, 10000, 8000];
return requestWithFallback(parts, { timeouts: visionTimeouts, timeoutMs: 8000, deadlineMs: 45000, models: visionModels });
}
