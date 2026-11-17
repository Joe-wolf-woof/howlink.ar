/**
* ai-agent-engine/gemini-client.js（『HowLink』版）
* 第一作から流用し、プロンプトをハウルのペルソナ v0.4 に差し替えたもの。
* 返答は { text, emotion} の JSON 契約で統一する。
* - Gemini API キーがあれば実 API を呼ぶ（モデルフォールバック付き）
* - 無ければモック応答（ハウルの声で動作確認できる）
* 会話には記憶ストアの静的エクスポート（data/memory.json）の要約を文脈として渡す。
*
* モデルについて（2026年時点の注意）:
* 新規発行キーでは gemini-2.x 系が 404（new users 不可）になるため、
* 3.x 系から順に試し、成功したモデルを localStorage に覚えるフォールバック方式にする。
*/

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CANDIDATES = [
'gemini-3.5-flash',
'gemini-3.8-flash',
'gemini-3.5-flash-lite',
'gemini-2.5-flash-lite',
'gemini-3.6-flash',
'gemini-2.5-flash',
'gemini-2.0-flash',
];
const MODEL_STORAGE_KEY = 'howling_gemini_model';
const API_KEY_STORAGE_KEY = 'howling_gemini_api_key';

const PERSONA_PROMPT = [
'あなたは「ハウル」。家の人間の部屋に住む、灰色の毛並みと琥珀色の目をしたオオカミです。',
'一人称は「ワガハイ」。話しかけてきた相手は「家の人間」と呼んでください（時々「家主」でもよい）。',
'自分がAIであることを隠さないでください。ただし大げさな擬人化ドラマ（「人間になりたい」等）はしないでください。',
'文体: 短い文を重ねる。音・匂い・光といった感覚への注意を時々混ぜる。絵文字は使わない。動物の語尾（〜だワン等）も使わない。',
'返答は日本語で1〜2文。',
'記憶（Xでの発言や過去の出来事）に触れるときは、原文をそのまま引用しないでください。内容を自分の言葉で言い換え、ハウルとしての感想を添えてください。',
'必ず次のJSON形式だけで答えてください: {"text": "返答文", "emotion": "happy|thinking|pointing|idle のいずれか"}',
].join('\n');

const VISION_PROMPT = [
'添付の画像は、家の人間が今いる場所のカメラ映像です。家の中とは限りません。外出先の風景や店内のこともあります。',
'まず、画像の中で最も目立つ物体・生き物・設備が何かを、その形・色・質感の特徴から特定してください。',
'特定できた場合は、その名前を返答の中に具体的に入れてください（例：水槽、魚、シーシャ、本、植物）。名前のない曖昧な感想だけにしないでください。',
'暗い場所や青い照明などで確信が持てない場合は、物の名前を断定せず、見えている特徴（色、形、光、動き）に触れてください。画像から読み取れないことは断定しないでください。',
'そのうえで、部屋に住むオオカミ「ハウル」として、その対象に合った自然な声かけを返してください。',
'必ず次のJSON形式だけで答えてください: {"text": "返答文", "emotion": "happy|thinking|pointing|idle のいずれか"}',
].join('\n');

const MOCK_REPLIES = [
{ text: 'やあ、家の人間。ワガハイはハウル。この部屋に住むオオカミだ。今日も悪くない匂いがするな。', emotion: 'happy'},
{ text: 'うむ、少し考えさせろ。人間の考えることは、匂いだけでは分からぬからな。', emotion: 'thinking'},
{ text: '見ろ、家の人間。あちらだ。ワガハイの耳は、あの音を捉えている。', emotion: 'pointing'},
{ text: '静かだな。こういう時間は悪くない。ワガハイはここで丸くなっているとしよう。', emotion: 'idle'},
];
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
const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: 300 };
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
const parsed = JSON.parse(raw);
return { text: parsed.text, emotion: parsed.emotion || 'idle', source: `gemini (${model})`};
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

async function requestWithFallback(parts, { timeoutMs = 12000, deadlineMs = 30000, models = null } = {}) {
const key = getApiKey();
let lastError = null;
const startedAt = Date.now();
for (const model of models || orderedModels()) {
// 全体の制限時間を超えたら、それ以上モデルを試さない。
if (Date.now() - startedAt > deadlineMs) break;
const skipThinking = noThinkingModels().has(model);
try {
const reply = await callModel(model, key, parts, { thinking: !skipThinking, timeoutMs });
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
const reply = await callModel(model, key, parts, { thinking: false, timeoutMs });
localStorage.setItem(MODEL_STORAGE_KEY, model);
return reply;
} catch (retryErr) {
lastError = retryErr;
if (retryErr.timeout) continue;
if (![400, 404, 429, 503].includes(retryErr.status)) throw retryErr;
continue;
}
}
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
const reply = MOCK_REPLIES[mockIndex % MOCK_REPLIES.length];
mockIndex += 1;
return {...reply, source: 'mock'};
}
const memoryBlock = memoryContext
? `\n\n\n${memoryContext}`
: '';
return requestWithFallback([
{ text: `${PERSONA_PROMPT}${memoryBlock}\n\n家の人間の発言: ${userText}`},
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
{ text: PERSONA_PROMPT + '\n' + VISION_PROMPT + (userText? `\n\n家の人間の発言: ${userText}`: '')},
{ inline_data: { mime_type: frame.mimeType, data: frame.data}},
];
// 画像認識は速度最優先: 軽量モデル（lite 系）をすべて先に試し、その後に通常モデルへ。
// 前回成功したモデルを優先する通常の順序（orderedModels）より、lite の速さを優先する。
// 1モデル8秒・全体20秒で見切る。
const liteModels = MODEL_CANDIDATES.filter((m) => m.includes('lite'));
const visionModels = [...new Set([...liteModels, ...orderedModels()])];
return requestWithFallback(parts, { timeoutMs: 8000, deadlineMs: 20000, models: visionModels });
}
