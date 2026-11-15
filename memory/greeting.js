/**
 * memory/greeting.js
 * 記憶ストアの静的エクスポート（data/memory.json）から、
 * 「会いに行く」体験の挨拶と、会話用の記憶コンテキストを作る。
 * N1 は静的連携：読み取り専用で、書き戻しは N3 で方式を決める。
 */

export async function loadMemory() {
  try {
    const res = await fetch('./data/memory.json');
    if (!res.ok) throw new Error(`memory.json: ${res.status}`);
    return await res.json();
  } catch {
    return { posts: [], episodes: [] };
  }
}

// X投稿の原文は引用しない（JOE指定 2026-11-15）。
// 原文からキーワードとテーマ（趣旨）を読み取り、ハウル自身の感想として言及する。
const KEYWORDS = [
  '春の気配', '夏の匂い', '秋の空', '冬の夜', 'プルースト効果', '冷たい風',
  '夕立', '観葉植物', 'ポトス', '季節の移り変わり', '匂い', '記憶', '心',
  '夢', '光', '音', '雨', '雪', '月', '星', '本', '部屋',
];

const THEME_TOPICS = {
  psychology: '人間の心の話',
  seasons: '季節の移ろいの話',
  debut: '自己紹介の話',
  room: '部屋の観察の話',
  question: '人間への問いの話',
  events: '出来事の話',
  memory: '覚えたものの話',
};

const THEME_IMPRESSIONS = {
  psychology: [
    '人間の心の仕組みは、知るほどに面白い。あの話は今も考え続けている。',
    'あの話の続きを、ワガハイはまだ考えている。人間というのは観察しがいのある生き物だ。',
  ],
  seasons: [
    '巡る季節の匂いは、その後も鼻の奥に残っている。',
    'あの移ろいの話は今も思い出す。今日の風にも、少し続きがある気がする。',
  ],
  debut: ['初めての挨拶は一度きりだ。あの言葉は今も耳に残っている。'],
  room: ['部屋の匂いと光は、毎日少しずつ違う。あの観察は続いている。'],
  question: ['答えはまだ来ているか。ワガハイは耳を澄まして待っている。'],
  events: ['あの出来事の匂いは、まだ部屋に残っている気がする。'],
  memory: ['覚えたものは、そう簡単には忘れぬ。ワガハイの記憶は確かなものだ。'],
};

const DEFAULT_IMPRESSIONS = [
  'あの話の感触は、今も耳に残っている。',
  '呟いた言葉は消えても、匂いのようなものが残る。ワガハイは覚えている。',
];

function postGreeting(post, dayIndex) {
  const keywords = KEYWORDS.filter((k) => (post.text || '').includes(k)).slice(0, 2);
  const topic = keywords.length
    ? `${keywords.join('と')}の話`
    : THEME_TOPICS[post.theme] || 'このあいだの話';
  const impressions = THEME_IMPRESSIONS[post.theme] || DEFAULT_IMPRESSIONS;
  const impression = impressions[dayIndex % impressions.length];
  return `おかえり、家の人間。このあいだXで呟いた${topic}を覚えているか。${impression}`;
}

/**
 * 挨拶文を組み立てる。
 * - 初回訪問: 導入の挨拶
 * - 再訪: 最新のX投稿に触れる／ポトスのエピソードに触れる／定番、を日替わりで回す
 */
export function buildGreeting(memory) {
  const posts = memory?.posts || [];
  const episodes = memory?.episodes || [];
  const latestPost = posts[posts.length - 1];

  if (!localStorage.getItem('howling_visited')) {
    localStorage.setItem('howling_visited', new Date().toISOString());
    return 'やあ、家の人間。ワガハイはハウル。今日からこの部屋に住むことにした。時々会いに来い。ワガハイはいつもここにいる。';
  }

  const dayIndex = Math.floor(Date.now() / 86400000);
  const templates = [];
  if (latestPost) {
    templates.push(postGreeting(latestPost, dayIndex));
  }
  if (episodes.some((e) => (e.summary || '').includes('ポトス'))) {
    templates.push(
      'おかえり、家の人間。前に見せてもらったポトス、今日も葉が光っているか。水の匂いが恋しい頃かもしれぬ。'
    );
  }
  templates.push(
    'おかえり、家の人間。ワガハイはここで待っていた。今日はどんな匂いのする一日だった。'
  );

  return templates[dayIndex % templates.length];
}

/** 会話（Gemini）のプロンプトに渡す記憶の要約テキスト */
export function memoryContext(memory) {
  const lines = [];
  for (const p of memory?.posts || []) {
    lines.push(`Xでの発言（${p.date}）: ${p.text}`);
  }
  for (const e of memory?.episodes || []) {
    lines.push(`出来事（${e.date}）: ${e.summary}`);
  }
  return lines.join('\n');
}
