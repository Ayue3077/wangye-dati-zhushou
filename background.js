'use strict';

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0,
  autoClick: true,
  autoNext: true,
  autoSubmit: false,
  scrollMode: true,
  startTop: true,
  delayMs: 800,
  maxRounds: 40
};

async function getCfg() {
  const stored = await chrome.storage.local.get(null);
  return Object.assign({}, DEFAULTS, stored);
}

function buildPrompt(questions) {
  const blocks = questions.map((q) => {
    const opts = (q.options || [])
      .map((o) => `${o.letter}. ${o.text}`)
      .join('\n');
    return `【第${q.id}题】${q.stem}\n${opts}`;
  }).join('\n\n');

  return [
    '你是实验室安全教育考试的阅卷专家。下面每组题都是单选题（除非题干注明多选）。',
    '',
    '答题方法（重要）：',
    '1. 先在 reason 里写一句分析，说明每个选项为什么对或错',
    '2. 再给出正确选项字母',
    '3. 如果题干或选项明显不完整、或有多个选项都说得通、或你不确定，answer 填 "?" 并在 unsure 填 true',
    '4. 不要为了凑答案硬猜。宁可标 "?" 也不要给错答案',
    '',
    '只输出一个 JSON 对象，不要任何其他文字，不要 markdown 代码块。',
    '格式：',
    '{"answers":[{"id":1,"answer":"C","pick":"选中选项的完整原文","reason":"逐选项分析，60字内","unsure":false}]}',
    '',
    '字段说明：',
    '- id：题号，必须和输入一致',
    '- answer：单个字母；多选连写如 "ABD"；拿不准填 "?"',
    '- pick：把选中的选项文字完整抄一遍（必须能在选项里找到原句）',
    '- reason：为什么选它、其他选项为何错',
    '- unsure：true 表示你不确定',
    '',
    '注意：answer 必须是上面列出的选项字母，不要重新编号。',
    '',
    blocks
  ].join('\n');
}

// 记录最近一次发给模型的原文，便于核对
let lastPrompt = '';

function parseAnswers(content, questions) {
  const ids = new Set(questions.map((q) => String(q.id)));
  let s = String(content || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  const tryParse = (t) => {
    try { return JSON.parse(t); } catch (e) { return null; }
  };

  const out = {};
  const picks = {};   // id -> 模型抄回来的选项原文
  const whys = {};    // id -> 模型给的理由
  const unsures = {}; // id -> 是否自称不确定
  const warns = {};   // id -> 警告（字母与原文不符等）

  const push = (id, ans, pick, why, unsure) => {
    const k = String(id == null ? '' : id).trim();
    if (!ids.has(k)) return;
    const raw = String(ans == null ? '' : ans).trim();
    // "?" 或空 → 未知
    if (!raw || raw === '?' || raw === '？' || /^(不确定|无法确定|unknown)$/i.test(raw)) {
      if (!out[k]) out[k] = '?';
      if (pick) picks[k] = String(pick).trim();
      if (why) whys[k] = String(why).trim().slice(0, 200);
      if (unsure) unsures[k] = true;
      return;
    }
    const letters = raw.toUpperCase().match(/[A-H]/g);
    if (letters && letters.length && !out[k]) {
      out[k] = Array.from(new Set(letters)).join('');
    }
    if (pick && ids.has(k)) picks[k] = String(pick).trim();
    if (why && ids.has(k)) whys[k] = String(why).trim().slice(0, 200);
    if (unsure && ids.has(k)) unsures[k] = true;
  };

  let obj = tryParse(s);
  if (!obj) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(s.slice(a, b + 1));
  }
  if (obj) {
    const list = Array.isArray(obj) ? obj
      : (Array.isArray(obj.answers) ? obj.answers
      : (Array.isArray(obj.data) ? obj.data
      : (Array.isArray(obj.result) ? obj.result : null)));
    if (list) {
      list.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        const id = it.id != null ? it.id : (it.index != null ? it.index : (it.no != null ? it.no : it.num));
        const ans = it.answer != null ? it.answer : (it.ans != null ? it.ans : (it.option != null ? it.option : it.value));
        const pick = it.pick != null ? it.pick : (it.text != null ? it.text : (it.content != null ? it.content : null));
        const why = it.reason != null ? it.reason : (it.why != null ? it.why : null);
        push(id, ans, pick, why, it.unsure === true);
      });
    } else if (typeof obj === 'object') {
      Object.keys(obj).forEach((k) => {
        if (ids.has(k)) push(k, obj[k]);
      });
    }
  }

  if (!Object.keys(out).length) {
    const re = /["']?(?:id|index|no)["']?\s*:\s*["']?(\d{1,3})["']?[^{}]*?["']?(?:answer|ans|option|value)["']?\s*:\s*["']?([A-Ha-h])/g;
    let m;
    while ((m = re.exec(s)) !== null) push(m[1], m[2]);
  }

  if (!Object.keys(out).length) {
    s.split(/[\n,;]+/).forEach((ln) => {
      const m = ln.match(/(\d{1,3})\s*[\.、:：)\-]?\s*(?:答案)?\s*[：:]?\s*([A-Ha-h])\b/);
      if (m) push(m[1], m[2]);
    });
  }

  // pick 只用于警告，不再覆盖模型给的字母（避免归一化误命中把对的改错）
  Object.keys(picks).forEach((k) => {
    const q = questions.find((x) => String(x.id) === k);
    if (!q || !out[k] || out[k] === '?') return;
    const pickText = normText(picks[k]);
    if (!pickText || pickText.length < 2) return;
    const matched = (q.options || []).filter((o) => {
      const t = normText(o.text);
      if (!t) return false;
      return t.includes(pickText) || pickText.includes(t);
    });
    if (matched.length === 1 && !out[k].includes(matched[0].letter)) {
      warns[k] = `字母 ${out[k]} 与所选原文不符（原文像 ${matched[0].letter}）`;
    } else if (matched.length === 0) {
      warns[k] = '所选原文在选项里找不到，可能选项识别不全';
    }
  });

  return { answers: out, picks, whys, unsures, warns };
}

function normText(s) {
  return String(s || '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[，。、；：""''（）()【】\[\]·,.\-—_]/g, '')
    .toLowerCase();
}

async function ask(questions) {
  const cfg = await getCfg();
  if (!cfg.apiKey) throw new Error('未配置 API Key，请先在扩展选项页填写');
  if (!questions || !questions.length) throw new Error('没有题目');

  const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    temperature: Number(cfg.temperature) || 0,
    messages: [
      { role: 'system', content: '你是实验室安全教育阅卷专家，先推理再作答，只输出 JSON。' },
      { role: 'user', content: buildPrompt(questions) }
    ]
  };

  lastPrompt = body.messages[1].content;
  try {
    await chrome.storage.local.set({ lastPrompt, lastRawReply: '' });
  } catch (e) { /* 忽略 */ }

  const first = await askOnce(url, body, cfg, questions);
  const out = Object.assign({}, first.answers);
  const picks = Object.assign({}, first.picks);
  const whys = Object.assign({}, first.whys);
  const unsures = Object.assign({}, first.unsures);
  const warns = Object.assign({}, first.warns);

  // 双采样比对：只对第一次给出确定答案的题再问一遍，不一致就标存疑
  const needVerify = Object.keys(out).filter((k) => out[k] && out[k] !== '?');
  if (needVerify.length) {
    const sub = questions.filter((q) => needVerify.includes(String(q.id)));
    if (sub.length) {
      try {
        const second = await askOnce(url, {
          model: cfg.model,
          temperature: 0.3,
          messages: [
            { role: 'system', content: '你是实验室安全教育阅卷专家，先推理再作答，只输出 JSON。' },
            { role: 'user', content: buildPrompt(sub) }
          ]
        }, cfg, sub);

        sub.forEach((q) => {
          const k = String(q.id);
          const a1 = out[k];
          const a2 = second.answers[k];
          if (!a1 || a1 === '?') return;
          if (!a2 || a2 === '?') {
            warns[k] = (warns[k] ? warns[k] + '；' : '') + '二次复核未给出答案';
            unsures[k] = true;
            return;
          }
          if (a1 !== a2) {
            warns[k] = (warns[k] ? warns[k] + '；' : '') + `两次结果不一致（${a1} / ${a2}）`;
            unsures[k] = true;
          }
        });
      } catch (e) {
        // 复核失败不影响主结果
        needVerify.forEach((k) => {
          warns[k] = (warns[k] ? warns[k] + '；' : '') + '二次复核失败';
        });
      }
    }
  }

  return { answers: out, picks, whys, unsures, warns };
}

async function askOnce(url, body, cfg, questions) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error('请求失败：' + (e && e.message ? e.message : e));
  }

  const text = await res.text();
  if (!res.ok) throw new Error('API ' + res.status + '：' + text.slice(0, 300));

  let data = null;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('返回非 JSON：' + text.slice(0, 200));
  }

  const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  try { await chrome.storage.local.set({ lastRawReply: String(content).slice(0, 4000) }); } catch (e) { /* 忽略 */ }

  const parsed = parseAnswers(content, questions);
  const answers = parsed.answers || {};
  if (!Object.keys(answers).length) {
    throw new Error('模型输出无法解析：' + String(content).slice(0, 200));
  }
  return {
    answers,
    picks: parsed.picks || {},
    whys: parsed.whys || {},
    unsures: parsed.unsures || {},
    warns: parsed.warns || {}
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const type = msg && msg.type;
      if (type === 'GETCFG') {
        sendResponse({ cfg: await getCfg() });
        return;
      }
      if (type === 'ASK') {
        const r = await ask(msg.questions || []);
        sendResponse({
          answers: r.answers, picks: r.picks, whys: r.whys,
          unsures: r.unsures, warns: r.warns
        });
        return;
      }
      if (type === 'TEST') {
        const r = await ask([{
          id: 1,
          stem: '实验室中能否用铜丝代替保险丝？（单选题）',
          options: [{ letter: 'A', text: '可以' }, { letter: 'B', text: '不可以' }]
        }]);
        sendResponse({ ok: true, answers: r.answers, picks: r.picks, whys: r.whys, warns: r.warns });
        return;
      }
      if (type === 'OPEN_OPTIONS') {
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }
      // iframe 的日志转给顶层窗口的面板
      if (type === 'LOG_RELAY') {
        sendResponse({ ok: true });
        return;
      }
      // 面板在顶层、题目在 iframe：把命令转发给该标签页的所有 frame
      if (type === 'BROADCAST_CMD') {
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId == null) { sendResponse({ error: '无 tabId' }); return; }
        const action = msg.action || msg.cmd;
        try {
          const targets = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (act) => {
              try {
                if (window.__aqa && typeof window.__aqa.cmd === 'function') {
                  const has = window.__aqa.hasQuestions ? window.__aqa.hasQuestions() : 0;
                  // 没有题目的 frame 不执行，避免重复跑
                  if (!has) return false;
                  window.__aqa.cmd(act);
                  return true;
                }
                return false;
              } catch (e) { return false; }
            },
            args: [action]
          });
          const ran = (targets || []).filter((t) => t && t.result).length;
          sendResponse({ ok: true, frames: (targets || []).length, ran });
        } catch (e) {
          sendResponse({ error: String(e && e.message || e) });
        }
        return;
      }
      sendResponse({ error: '未知消息类型' });
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const merged = Object.assign({}, DEFAULTS, cur);
  await chrome.storage.local.set(merged);
});
