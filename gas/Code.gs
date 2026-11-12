/**
 * AI面接練習アプリ（GAS + Groq）
 *
 * 【初期設定】
 * 1. 記録用のスプレッドシートで「拡張機能 → Apps Script」を開き、このファイルの中身を貼り付ける
 *    （index.html はGASには不要。画面は GitHub Pages に置いています）
 * 2. 「プロジェクトの設定 → スクリプト プロパティ」に GROQ_API_KEY（GroqのAPIキー）を登録する
 *    （任意）ACCESS_CODE を登録すると、その合言葉を入力した人だけが使えます
 * 3. 関数 setup を1回実行する（「記録」「明細」シートが作られます）
 * 4. 「デプロイ → 新しいデプロイ → ウェブアプリ」
 *    実行ユーザー：自分 ／ アクセスできるユーザー：全員
 * 5. 発行されたURL（…/exec）を index.html の API_URL に設定する
 */

// ===== 設定（ここを書き換えるだけで調整できます） =====
const CONFIG = {
  // 上から順に試し、エラー（上限超過・モデル廃止など）のときは次のモデルを使います
  CHAT_MODELS: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
  // 音声の文字起こし用モデル
  STT_MODEL: 'whisper-large-v3-turbo',
  SHEET_LOG: '記録',
  SHEET_DETAIL: '明細',
  MAX_ANSWER_CHARS: 1200
};

const EXAM_TYPES = {
  job: {
    label: '就職試験',
    target: '企業名・職種',
    topics: '志望動機、その会社・職種を選んだ理由、仕事内容の理解、高校生活で力を入れたこと、長所と短所、' +
            '周囲と協力した経験、入社後にやりたいこと、働くうえで大切にしたいこと'
  },
  ao: {
    label: '総合型選抜',
    target: '大学・学部・学科',
    topics: '志望理由、アドミッションポリシーの理解、入学後に学びたいこと、これまでの活動や探究の内容、' +
            'その分野に関心を持ったきっかけ、最近関心を持った出来事や本、卒業後の将来像、自分の強み'
  },
  suisen: {
    label: '学校推薦型選抜',
    target: '大学・学部・学科',
    topics: '志望理由、他校ではなくその学校を選んだ理由、高校での学習への取り組み、得意な科目と苦手な科目、' +
            '高校生活で力を入れたこと、入学後の学習計画、卒業後の進路、自分の長所と短所'
  }
};

const AGE_LABEL = { young: '20代後半の若手', middle: '40代の中堅', senior: '50代後半のベテラン' };
const GENDER_LABEL = { male: '男性', female: '女性' };

// ===== 画面 =====
const APP_URL = 'https://t-gotoy-code.github.io/mensetsu-renshu/';

/** GASのURLを直接開いた人を、公開ページへ案内する（GAS上ではカメラとマイクが使えないため） */
function doGet() {
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<p style="font-family:sans-serif;font-size:18px;padding:24px">面接練習は次のページで行います。<br><br>' +
    '<a href="' + APP_URL + '" target="_top">' + APP_URL + '</a></p>'
  ).setTitle('AI面接練習');
}

/** GAS以外の場所に置いた index.html からの呼び出し口 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const need = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE');
    if (need && String(req.code || '') !== need) throw new Error('合言葉が違います。');
    const fns = { nextQuestion: nextQuestion, transcribe: transcribe, finishInterview: finishInterview };
    if (!fns[req.fn]) throw new Error('不明な呼び出しです。');
    out = { ok: true, result: fns[req.fn].apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 最初に1回だけ実行：記録用シートを作成 */
function setup() {
  getSheet_(CONFIG.SHEET_LOG);
  getSheet_(CONFIG.SHEET_DETAIL);
}

// ===== クライアントから呼ばれる関数 =====

/** 次の質問を作る */
function nextQuestion(session) {
  const s = cleanSession_(session);
  const type = EXAM_TYPES[s.type];
  const n = s.history.length + 1;

  const system =
    'あなたは高校生の面接練習の相手をする面接官です。本番に近い雰囲気で、落ち着いて丁寧に質問してください。\n' +
    '【面接の種類】' + type.label + '\n' +
    '【志望先】' + (s.target || '未入力（一般的な質問にする）') + '\n' +
    (s.memo ? '【受験者のメモ（志望理由・自己PRなど）】' + s.memo + '\n' : '') +
    '【面接官の人物像】' + AGE_LABEL[s.age] + 'の' + GENDER_LABEL[s.gender] + '面接官\n' +
    '【よく聞く内容】' + type.topics + '\n' +
    '【進行】全' + s.total + '問のうち、これから' + n + '問目を出します。\n' +
    '【ルール】\n' +
    '・出力は面接官のセリフだけ。質問は1つだけにし、全体で120字以内にする。\n' +
    '・2問目以降は、最初に「ありがとうございます。」など短い受け答えを一言入れてよい。\n' +
    '・直前の回答が抽象的・短い・理由が不明なときは、具体例や理由、そのときの行動を深掘りする。\n' +
    '・同じ話題の深掘りは2回まで。その後は別の話題に移る。\n' +
    '・1問目は志望動機または志望理由から始める。\n' +
    '・最後の質問（' + s.total + '問目）は「最後に伝えておきたいことや質問はありますか」という趣旨にする。\n' +
    '・氏名、住所、家族、出身地、宗教、支持政党、健康状態など、本人の適性・能力と関係のないことは質問しない。\n' +
    '・部活動への所属や学年を前提にしない。\n' +
    '・評価、助言、講評は言わない。\n' +
    '・音声で読み上げるため、記号、かっこ、箇条書き、絵文字は使わない。丁寧語で話す。';

  const messages = [{ role: 'system', content: system }, { role: 'user', content: '面接を開始してください。' }];
  s.history.forEach(function (h) {
    messages.push({ role: 'assistant', content: h.q });
    messages.push({ role: 'user', content: h.a });
  });

  const text = callGroq_(messages, 1200);
  return { question: tidySpeech_(text) };
}

/** 音声を文字にする */
function transcribe(base64, mimeType) {
  const key = getKey_();
  const mime = String(mimeType || 'audio/webm').split(';')[0];
  const ext = mime.indexOf('mp4') >= 0 ? 'm4a' : mime.indexOf('ogg') >= 0 ? 'ogg' : mime.indexOf('wav') >= 0 ? 'wav' : 'webm';
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, 'answer.' + ext);

  const res = UrlFetchApp.fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + key },
    payload: { file: blob, model: CONFIG.STT_MODEL, language: 'ja', response_format: 'json', temperature: '0' },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 429) throw new Error('ただいま利用が集中しています。少し待つか、文字で答えてください。');
  if (code !== 200) throw new Error('音声を文字にできませんでした（' + code + '）。文字で答えてください。');
  const text = String(JSON.parse(res.getContentText()).text || '').trim();
  return { text: text };
}

/** 講評を作り、スプレッドシートに記録する */
function finishInterview(session) {
  const s = cleanSession_(session);
  const type = EXAM_TYPES[s.type];
  if (!s.history.length) throw new Error('回答がありません。');

  let qa = '';
  s.history.forEach(function (h, i) {
    qa += '【質問' + (i + 1) + '】' + h.q + '\n【回答' + (i + 1) + '】' + h.a +
          (h.sec ? '（話した時間：約' + h.sec + '秒）' : '（文字入力）') + '\n\n';
  });

  const system =
    'あなたは高校の進路指導担当として、生徒の面接練習を講評します。生徒が次の練習で直せるよう、具体的に、励ましつつ率直に書いてください。\n' +
    '回答の多くは音声認識で文字にしたものです。誤変換や句読点の不自然さは減点せず、内容と話し方で判断してください。\n' +
    '表情・姿勢・声の大きさは分からないので触れないでください。\n' +
    '1問あたりの話す長さは30秒から1分程度が目安です。\n' +
    '次のJSONだけを出力してください。前後に文章や```は付けないでください。\n' +
    '{"overall":"全体の講評（200字程度）",' +
    '"scores":{"結論の明確さ":1から5の整数,"具体性":1から5の整数,"志望先との結びつき":1から5の整数,"言葉づかい":1から5の整数,"話の長さ":1から5の整数},' +
    '"items":[{"good":"この回答の良い点（60字程度）","improve":"改善点（80字程度）","example":"言い換えの例（80字程度、不要なら空文字）"}],' +
    '"next":["次回意識すること","次回意識すること","次回意識すること"]}\n' +
    'itemsは質問の数（' + s.history.length + '個）と同じ数にしてください。';

  const user = '【面接の種類】' + type.label + '\n【志望先】' + (s.target || '未入力') + '\n\n' + qa;

  let feedback;
  let raw = '';
  try {
    raw = callGroq_([{ role: 'system', content: system }, { role: 'user', content: user }], 4000);
    feedback = parseJson_(raw);
  } catch (e) {
    feedback = null;
    raw = raw || String(e.message || e);
  }
  if (!feedback) feedback = { overall: raw, scores: {}, items: [], next: [] };

  try { writeLog_(s, type, feedback); } catch (e) { console.error(e); }
  return feedback;
}

// ===== 内部処理 =====

function getKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GROQ_API_KEY');
  if (!key) throw new Error('APIキーが設定されていません（スクリプト プロパティ GROQ_API_KEY）。');
  return key;
}

function callGroq_(messages, maxTokens) {
  const key = getKey_();
  let lastCode = 0;
  for (let i = 0; i < CONFIG.CHAT_MODELS.length; i++) {
    const res = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({
        model: CONFIG.CHAT_MODELS[i],
        messages: messages,
        temperature: 0.6,
        max_completion_tokens: maxTokens
      }),
      muteHttpExceptions: true
    });
    lastCode = res.getResponseCode();
    if (lastCode === 200) {
      const data = JSON.parse(res.getContentText());
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text && String(text).trim()) return String(text).trim();
    } else {
      console.warn(CONFIG.CHAT_MODELS[i] + ' → ' + lastCode + ' ' + res.getContentText().slice(0, 300));
      if (lastCode === 401) throw new Error('APIキーが正しくありません。');
    }
  }
  if (lastCode === 429) throw new Error('本日の利用上限に達したか、利用が集中しています。時間をおいて試してください。');
  throw new Error('AIから応答がありませんでした（' + lastCode + '）。もう一度試してください。');
}

function cleanSession_(session) {
  const s = session || {};
  const cut = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
  const out = {
    studentId: cut(s.studentId, 20),
    type: EXAM_TYPES[s.type] ? s.type : 'job',
    target: cut(s.target, 80),
    memo: cut(s.memo, 600),
    gender: GENDER_LABEL[s.gender] ? s.gender : 'male',
    age: AGE_LABEL[s.age] ? s.age : 'middle',
    total: Math.min(Math.max(parseInt(s.total, 10) || 6, 3), 10),
    history: []
  };
  (s.history || []).slice(0, 10).forEach(function (h) {
    out.history.push({
      q: cut(h.q, 300),
      a: cut(h.a, CONFIG.MAX_ANSWER_CHARS),
      sec: Math.min(Math.max(parseInt(h.sec, 10) || 0, 0), 600)
    });
  });
  return out;
}

function tidySpeech_(text) {
  return String(text)
    .replace(/[「」『』【】*#`]/g, '')
    .replace(/^(面接官|質問\d*)\s*[:：]\s*/, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
    .slice(0, 300);
}

function parseJson_(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const head = name === CONFIG.SHEET_LOG
      ? ['日時', '生徒番号', '種別', '志望先', '面接官', '質問数', '結論の明確さ', '具体性', '志望先との結びつき', '言葉づかい', '話の長さ', '全体講評', '次回意識すること']
      : ['日時', '生徒番号', '種別', '番号', '質問', '回答', '話した秒数', '良い点', '改善点', '言い換え例'];
    sh.appendRow(head);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#dbe9ff');
  }
  return sh;
}

function writeLog_(s, type, fb) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const now = new Date();
    const sc = fb.scores || {};
    getSheet_(CONFIG.SHEET_LOG).appendRow([
      now, s.studentId, type.label, s.target,
      AGE_LABEL[s.age] + '・' + GENDER_LABEL[s.gender], s.history.length,
      sc['結論の明確さ'] || '', sc['具体性'] || '', sc['志望先との結びつき'] || '', sc['言葉づかい'] || '', sc['話の長さ'] || '',
      fb.overall || '', (fb.next || []).join(' ／ ')
    ]);
    const rows = s.history.map(function (h, i) {
      const it = (fb.items || [])[i] || {};
      return [now, s.studentId, type.label, i + 1, h.q, h.a, h.sec || '', it.good || '', it.improve || '', it.example || ''];
    });
    const sh = getSheet_(CONFIG.SHEET_DETAIL);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
}
