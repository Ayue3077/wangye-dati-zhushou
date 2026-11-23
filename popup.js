'use strict';

const $ = (id) => document.getElementById(id);
const statusBox = $('status');

function setStatus(s) {
  statusBox.textContent = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContent(tab) {
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (r && r.ok) return true;
  } catch (e) { /* 未注入，下面补注入 */ }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['content.css'] });
  } catch (e) { /* 忽略 */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    });
    return true;
  } catch (e) {
    setStatus('注入失败：' + e.message);
    return false;
  }
}

// 在所有 frame 上调用 window.__aqa.<method>()
async function callAllFrames(tab, method) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (m) => {
        try {
          if (!window.__aqa || !window.__aqa.ready) return { skipped: true };
          return window.__aqa[m]();
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      },
      args: [method]
    });
  } catch (e) {
    return { error: '跨 frame 调用失败：' + e.message, frames: [] };
  }
  return { frames: results };
}

$('start').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  if (!(await ensureContent(tab))) return;

  const scan = await callAllFrames(tab, 'scan');
  if (scan.error) return setStatus(scan.error);

  const hits = (scan.frames || []).filter((f) => f && f.result && f.result.count > 0);
  if (!hits.length) {
    return setStatus('所有 frame 都没识别到题目。点「诊断」看结构。');
  }
  const target = hits.find((f) => f.frameId === 0) || hits[0];

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [target.frameId] },
      func: () => { if (window.__aqa) window.__aqa.start(); }
    });
    setStatus(`已在 frame#${target.frameId} 启动（识别到 ${target.result.count} 题）。\n答题过程中请看这里或稍后点「只列答案」取清单。`);
  } catch (e) {
    setStatus('启动失败：' + e.message);
  }
});

// 只列答案：不点击，直接把题号/题干/答案列出来
$('listOnly').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  if (!(await ensureContent(tab))) return;
  await chrome.storage.local.remove(['lastAnswers']);
  setStatus('正在识别并请求模型…');

  const scan = await callAllFrames(tab, 'scan');
  if (scan.error) return setStatus(scan.error);

  const hits = (scan.frames || []).filter((f) => f && f.result && f.result.count > 0);
  if (!hits.length) return setStatus('没识别到题目。点「诊断」看结构。');

  // 合并所有 frame 的识别结果，不要只取第一个——题目可能分散在多个 frame
  let allQs = [];
  const seenStem = new Set();
  hits.forEach((f) => {
    (f.result.questions || []).forEach((q) => {
      const k = String(q.stem || '').slice(0, 50);
      if (!k || seenStem.has(k)) return;
      seenStem.add(k);
      allQs.push(q);
    });
  });
  allQs.sort((a, b) => (a.id || 0) - (b.id || 0));
  allQs.forEach((q, i) => { q.id = i + 1; });

  const LETTERS = 'ABCDEFGH';
  const optionsOk = (q) => {
    const ls = q.options.map((o) => o.letter).filter(Boolean).sort();
    if (ls.length < 2) return false;
    for (let i = 0; i < ls.length; i++) if (ls[i] !== LETTERS[i]) return false;
    return q.options.every((o) => (o.text || '').trim().length >= 1);
  };
  const bad = allQs.filter((q) => !optionsOk(q));
  const qs = allQs.filter((q) => optionsOk(q));

  const head = [];
  if (bad.length) {
    head.push(`⚠ 以下 ${bad.length} 题选项不全，跳过不答：`);
    bad.forEach((q) => head.push(`  第${q.id}题 仅 ${q.options.length} 个选项：${String(q.stem).slice(0, 30)}`));
    head.push('');
  }
  if (!qs.length) return setStatus((head.join('\n') || '') + '没有选项完整的题。');

  const CHUNK = 5;
  const ans = {};
  const picks = {};
  const whys = {};
  const unsures = {};
  const warns = {};
  for (let start = 0; start < qs.length; start += CHUNK) {
    const part = qs.slice(start, start + CHUNK);
    const payload = part.map((q, i) => ({
      id: i + 1,
      stem: q.stem + (/多选/.test(q.stem) ? '（多选）' : '（单选题）'),
      options: q.options.map((o) => ({ letter: o.letter, text: o.text }))
    }));
    setStatus(`请求第 ${start + 1}–${start + part.length} / ${qs.length} 题…`);
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'ASK', questions: payload });
    } catch (e) {
      return setStatus('后台通信失败：' + e.message);
    }
    if (!resp || resp.error) return setStatus('模型失败：' + ((resp && resp.error) || '未知'));
    const got = resp.answers || {};
    const gp = resp.picks || {};
    const gw = resp.whys || {};
    const gu = resp.unsures || {};
    const gn = resp.warns || {};
    part.forEach((q, i) => {
      const k = String(i + 1);
      ans[String(q.id)] = got[k] || '?';
      picks[String(q.id)] = gp[k] || '';
      whys[String(q.id)] = gw[k] || '';
      unsures[String(q.id)] = !!gu[k];
      warns[String(q.id)] = gn[k] || '';
    });
  }

  const compact = qs.map((q) => {
    const id = String(q.id);
    return `${q.id}.${ans[id]}${unsures[id] || ans[id] === '?' ? '(?)' : ''}`;
  }).join('  ');
  const detail = qs.map((q) => {
    const id = String(q.id);
    const a = ans[id] || '?';
    return {
      no: q.id,
      ans: a,
      stem: q.stem,
      picked: q.options.filter((o) => a.includes(o.letter)).map((o) => `${o.letter}. ${o.text}`),
      pick: picks[id] || '',
      why: whys[id] || '',
      unsure: unsures[id] || a === '?',
      warn: warns[id] || ''
    };
  });

  try {
    await chrome.storage.local.set({
      lastAnswers: { detail, compact, at: Date.now() },
      lastAnswersAt: Date.now()
    });
  } catch (e) { /* 忽略 */ }

  // 与悬浮窗同格式渲染
  const lines = head.slice();
  detail.forEach((d) => {
    const mark = d.ans === '?' ? '？存疑' : (d.unsure ? '⚠存疑' : '');
    lines.push(`【第${d.no}题】答案：${d.ans}${mark ? '  ' + mark : ''}`);
    lines.push(`  ${d.stem.slice(0, 90)}`);
    (d.picked || []).forEach((p) => lines.push(`  → ${p.slice(0, 50)}`));
    if (d.pick) lines.push(`  模型原话：${d.pick.slice(0, 50)}`);
    if (d.why) lines.push(`  理由：${d.why}`);
    if (d.warn) lines.push(`  注意：${d.warn}`);
  });
  lines.push('');
  lines.push(`—— 速览（${qs.length} 题）——`);
  lines.push(compact);
  setStatus(lines.join('\n') || '没有结果');
});

$('scan').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  if (!(await ensureContent(tab))) return;

  const res = await callAllFrames(tab, 'scan');
  if (res.error) return setStatus(res.error);

  const frames = res.frames || [];
  const lines = [];
  let total = 0;
  frames.forEach((f) => {
    const r = f && f.result;
    if (!r || r.error || r.skipped || r.count === undefined) return;
    if (!r.count) return;
    total += r.count;
    lines.push(`— frame#${f.frameId} ${r.isTop ? '(主页面)' : '(iframe)'}  ${r.count} 题`);
    r.questions.slice(0, 12).forEach((q) => {
      lines.push(` #${q.id}${q.multi ? '[多]' : ''} ${q.stem.slice(0, 46)}`);
      lines.push('    ' + q.options.map((o) => `${o.letter}.${o.text.slice(0, 16)}`).join(' | '));
    });
  });

  if (!total) setStatus(`0 题。共检查 ${frames.length} 个 frame。\n点「诊断页面」看结构。`);
  else setStatus(`共识别 ${total} 题\n\n` + lines.join('\n'));
});

$('diag').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  if (!(await ensureContent(tab))) return;

  const res = await callAllFrames(tab, 'diag');
  if (res.error) return setStatus(res.error);

  const frames = res.frames || [];
  const out = [];
  frames.forEach((f) => {
    const d = f && f.result;
    if (!d || d.error || d.skipped) {
      if (d && d.error) out.push(`frame#${f.frameId} 错误: ${d.error}`);
      return;
    }
    out.push(`── frame#${f.frameId} ${d.isTop ? '主页面' : 'iframe'}`);
    out.push(`url: ${String(d.url).slice(0, 90)}`);
    out.push(`radio/checkbox: ${d.inputs} 个（其中隐藏 ${d.hiddenInputs}）`);
    out.push(`字母选项节点: ${d.letterNodes} 个`);
    if (d.letterSample && d.letterSample.length) out.push(`  样例: ${d.letterSample.join(' ; ')}`);
    out.push(`题干候选(含括号/问号): ${d.stemCandidates}`);
    out.push(`iframe: ${d.iframes}  正文长度: ${d.bodyLen}`);
    out.push(`识别: radio=${d.detected.radio} 文本=${d.detected.text} 结构=${d.detected.structure}`);
    if (d.samples && d.samples.length) {
      out.push('文本块样例:');
      d.samples.slice(0, 12).forEach((s) => out.push('  ' + s));
    }
    out.push('');
  });

  setStatus(out.join('\n') || '无诊断结果');
});

$('copy').addEventListener('click', async () => {
  const r = await chrome.storage.local.get(['lastAnswers']);
  const la = r && r.lastAnswers;
  if (!la) return setStatus('还没有结果，先点「只列答案」。');

  let text = '';
  if (la.detail && la.detail.length) {
    text = la.detail.map((d) => `${d.no}. ${d.ans}`).join('  ');
  } else if (typeof la === 'string') {
    text = la;
  } else if (Array.isArray(la)) {
    text = la.map((d) => `${d.no}. ${d.answer || d.ans || '?'}`).join('  ');
  }

  if (!text) return setStatus('结果格式无法识别。');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('已复制：\n' + text);
  } catch (e) {
    setStatus('复制失败（可手动选中下方复制）：\n' + text);
  }
});

$('test').addEventListener('click', async () => {
  setStatus('正在测试…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST' });
    if (r && r.error) return setStatus('失败：' + r.error);
    setStatus('成功 ✓ ' + JSON.stringify(r.answers));
  } catch (e) {
    setStatus('失败：' + e.message);
  }
});

// 结构探针：抓第一道题的 A/B/C/D 四个字母节点，打印它们的层级关系与共同祖先。
// 这是定位「只抓到 A、B」最快的手段。
$('probe').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  setStatus('正在探测 DOM 结构…');

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const out = { url: location.href, found: false };

        // 找所有「文本恰好是一个 A-H 字母」的最内层元素
        const badges = [];
        document.querySelectorAll('*').forEach((el) => {
          if (el.children.length > 2) return;
          const t = (el.textContent || '').replace(/\s+/g, '');
          if (!/^[A-H]$/.test(t)) return;
          // 只取最内层
          let inner = false;
          for (const ch of el.children) {
            if (/^[A-H]$/.test((ch.textContent || '').replace(/\s+/g, ''))) { inner = true; break; }
          }
          if (inner) return;
          badges.push(el);
        });

        out.badgeTotal = badges.length;
        if (!badges.length) return out;

        // 按字母分组，取第一组连续的 A,B,...
        const byLetter = {};
        badges.forEach((el) => {
          const L = (el.textContent || '').replace(/\s+/g, '').toUpperCase();
          (byLetter[L] = byLetter[L] || []).push(el);
        });
        out.lettersFound = Object.keys(byLetter).sort();

        const path = (el) => {
          const p = [];
          let n = el;
          for (let d = 0; d < 6 && n; d++) {
            const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/)[0] : '';
            p.push(n.tagName.toLowerCase() + (cls ? '.' + cls.slice(0, 16) : ''));
            n = n.parentElement;
          }
          return p.join(' < ');
        };

        // 取第一题的 A/B/C/D（各自第一个）
        const picked = {};
        ['A', 'B', 'C', 'D'].forEach((L) => {
          if (byLetter[L] && byLetter[L].length) picked[L] = byLetter[L][0];
        });
        out.firstSet = Object.keys(picked).sort().map((L) => `${L}: ${path(picked[L])}`);

        // 计算 A/B/C/D 四个节点的共同祖先链，看在第几层汇合
        const arr = Object.keys(picked).map((L) => picked[L]);
        if (arr.length >= 2) {
          const ancestors = (el) => {
            const a = [];
            let n = el.parentElement;
            for (let d = 0; d < 12 && n; d++) { a.push(n); n = n.parentElement; }
            return a;
          };
          const chainA = ancestors(arr[0]);
          let common = null;
          let depth = -1;
          for (let i = 0; i < chainA.length; i++) {
            const cand = chainA[i];
            if (arr.every((el) => cand.contains(el))) { common = cand; depth = i + 1; break; }
          }
          if (common) {
            const cls = typeof common.className === 'string' ? common.className.trim().split(/\s+/).join('.') : '';
            out.commonAncestor = `${common.tagName.toLowerCase()}${cls ? ' .' + cls.slice(0, 40) : ''}（向上第 ${depth} 层）`;
            out.commonChildCount = common.children.length;
            out.commonTextLen = (common.innerText || '').length;
            out.commonTextHead = (common.innerText || '').replace(/\s+/g, ' ').slice(0, 200);
            // 共同祖先的直接子节点各自是什么
            out.commonChildren = Array.from(common.children).slice(0, 12).map((c, i) => {
              const ccls = typeof c.className === 'string' ? c.className.trim().split(/\s+/)[0] : '';
              return `[${i}] ${c.tagName.toLowerCase()}${ccls ? '.' + ccls.slice(0, 20) : ''} : ${(c.innerText || '').replace(/\s+/g, ' ').slice(0, 50)}`;
            });
          } else {
            out.commonAncestor = '12 层内无共同祖先（A/B 与 C/D 可能分属不同容器或不同 iframe）';
          }
        }

        // 每道题有几个字母，看分布
        out.letterCounts = {};
        Object.keys(byLetter).forEach((L) => { out.letterCounts[L] = byLetter[L].length; });

        return out;
      }
    });
  } catch (e) {
    return setStatus('探测失败：' + e.message);
  }

  const lines = [];
  (results || []).forEach((r, i) => {
    const d = r && r.result;
    if (!d) return;
    lines.push(`===== frame ${i} =====`);
    lines.push(d.url || '');
    if (!d.badgeTotal) { lines.push('没有单字母元素'); lines.push(''); return; }
    lines.push(`单字母元素总数：${d.badgeTotal}`);
    lines.push(`各字母数量：${JSON.stringify(d.letterCounts)}`);
    lines.push(`找到的字母：${(d.lettersFound || []).join(' ')}`);
    lines.push('');
    lines.push('第一题的 A/B/C/D 路径：');
    (d.firstSet || []).forEach((s) => lines.push('  ' + s));
    lines.push('');
    lines.push(`共同祖先：${d.commonAncestor || '无'}`);
    if (d.commonAncestor && d.commonTextHead) {
      lines.push(`共同祖先子节点数：${d.commonChildCount}  文本长度：${d.commonTextLen}`);
      lines.push(`文本开头：${d.commonTextHead}`);
      lines.push('');
      lines.push('共同祖先的直接子节点：');
      (d.commonChildren || []).forEach((s) => lines.push('  ' + s));
    }
    lines.push('');
  });

  const text = lines.join('\n') || '没有结果';
  try {
    await navigator.clipboard.writeText(text);
    setStatus('✓ 已复制探测结果：\n\n' + text);
  } catch (e) {
    setStatus(text);
  }
});

// 解析粘贴的答案文本。支持：
//   1A 2B 3B / 1.A 2.B / 第1题 A / 1-A / 1：A / 多选 7ABC / 1A2B3C 连写
function parseAnswerText(s) {
  const out = {};
  const txt = String(s || '').replace(/\u00a0/g, ' ');
  // 题号 + 一串字母
  const re = /(?:第)?\s*(\d{1,3})\s*(?:题)?\s*[\.、,，:：)）\-—\s]*([A-Ha-h]{1,8})/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const no = Number(m[1]);
    if (!no || no > 999) continue;
    const letters = m[2].toUpperCase()
      .split('')
      .filter((c) => /[A-H]/.test(c))
      .filter((c, i, arr) => arr.indexOf(c) === i)
      .sort()
      .join('');
    if (letters && !out[no]) out[no] = letters;
  }
  return out;
}

// 按答案在页面上勾选。按选项组在文档中的顺序编号，与导出题目的顺序一致。
$('apply').addEventListener('click', async () => {
  const text = ($('ansInput').value || '').trim();
  if (!text) return setStatus('先把答案粘到上面的输入框。格式：1A 2B 3B 或 1.A 2.B');

  const answers = parseAnswerText(text);
  const nAns = Object.keys(answers).length;
  if (!nAns) return setStatus('没解析出答案。\n格式示例：1A 2B 3B 4B ｜ 1.A 2.B ｜ 第1题 A ｜ 多选 7ABC');

  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  setStatus(`解析到 ${nAns} 题答案，正在勾选…`);

  let results = [];
  try {
    // 两条路都被堵过：func+args 在子 frame 拿不到参数；new Function 被 CSP 拦（unsafe-eval）。
    // 现在把答案先写进 storage，注入的函数在隔离世界里自己读——无参数、无 eval。
    await chrome.storage.local.set({ __applyAns: answers });

    const applyFn = () => new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };

      const work = (ansObj) => {
        var LETTERS = 'ABCDEFGH';
        var isOne = function (s) { return /^[A-Ha-h]$/.test(String(s || '').replace(/\s+/g, '')); };

        // 1) 收集单字母节点：与结构探针完全一致（* 遍历、允许子元素、只排除字母子元素）
        var badges = [];
        var all = document.querySelectorAll('*');
        for (var ai = 0; ai < all.length; ai++) {
          var el = all[ai];
          if (el.children.length > 2) continue;
          var t = (el.textContent || '').replace(/\s+/g, '');
          if (!/^[A-Ha-h]$/.test(t)) continue;
          var inner = false;
          for (var ci = 0; ci < el.children.length; ci++) {
            if (isOne(el.children[ci].textContent)) { inner = true; break; }
          }
          if (inner) continue;
          badges.push({ el: el, letter: t.toUpperCase() });
        }
        if (badges.length < 2) {
          return { ok: false, total: 0, hit: 0, miss: [], badges: badges.length, stage: 'badge' };
        }

        var pathOf = function (x) {
          var p = [], n = x;
          for (var d = 0; d < 6 && n; d++) {
            var c = typeof n.className === 'string' ? n.className.trim().split(/\s+/)[0] : '';
            p.push(n.tagName.toLowerCase() + (c ? '.' + c.slice(0, 18) : ''));
            n = n.parentElement;
          }
          return p.join(' < ');
        };

        // 2) 统计每个祖先元素被多少个字母徽标共享
        //    不能用「文本长度 > 2」找行：页面里字母的父 span 本身就装了选项文字，
        //    一向上就停在那一层，结果每个字母各成一组（各容器内字母数 1,1,1…）。
        var count = new Map();
        for (var bi0 = 0; bi0 < badges.length; bi0++) {
          var nn = badges[bi0].el.parentElement;
          for (var d0 = 0; d0 < 8 && nn; d0++) {
            if (nn === document.body || nn === document.documentElement) break;
            count.set(nn, (count.get(nn) || 0) + 1);
            nn = nn.parentElement;
          }
        }

        // 3) 每个徽标向上取「共享数 2..12、层级最深」的祖先作为选项区
        var groups = new Map();
        var rowFailed = 0;
        for (var bi = 0; bi < badges.length; bi++) {
          var b = badges[bi];
          var n = b.el.parentElement;
          var box = null;
          for (var d = 0; d < 8 && n; d++) {
            if (n === document.body || n === document.documentElement) break;
            var c = count.get(n) || 0;
            if (c >= 2 && c <= 12) { box = n; break; }   // 由内向外，第一个满足的就是最深
            n = n.parentElement;
          }
          if (!box) { rowFailed++; continue; }

          // 行 = 选项区里含该徽标的那个直接子节点
          var row = b.el;
          var guard = 0;
          while (row.parentElement && row.parentElement !== box && guard++ < 12) row = row.parentElement;
          if (row.parentElement !== box) { rowFailed++; continue; }

          if (!groups.has(box)) groups.set(box, []);
          var list = groups.get(box);
          var dup = false;
          for (var di = 0; di < list.length; di++) { if (list[di].row === row) { dup = true; break; } }
          if (dup) continue;
          list.push({ letter: b.letter, row: row, badge: b.el });
        }

        var blocks = [];
        groups.forEach(function (l2, bx) { if (l2.length >= 2) blocks.push([bx, l2]); });
        if (!blocks.length) {
          var sizes = [];
          groups.forEach(function (l3) { sizes.push(l3.length); });
          return {
            ok: false, total: 0, hit: 0, miss: [], badges: badges.length,
            stage: 'group', rowFailed: rowFailed,
            groupSizes: sizes.slice(0, 20),
            badgePaths: badges.slice(0, 4).map(function (x) { return x.letter + ': ' + pathOf(x.el); })
          };
        }
        blocks.sort(function (a, bb) {
          var pos = a[0].compareDocumentPosition(bb[0]);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
          return 0;
        });

        var fireClick = function (x) {
          if (!x) return;
          try {
            var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
            for (var i = 0; i < types.length; i++) {
              var tn = types[i];
              var Ctor = tn.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
              x.dispatchEvent(new Ctor(tn, { bubbles: true, cancelable: true, view: window }));
            }
          } catch (e) { /* 忽略 */ }
          try { x.click(); } catch (e) { /* 忽略 */ }
        };

        var isPicked = function (r) {
          var inp = r.querySelector('input[type=radio],input[type=checkbox]');
          if (inp && inp.checked) return true;
          var cls = typeof r.className === 'string' ? r.className : '';
          if (/(^|[\s_-])(selected|active|checked|current|on)([\s_-]|$)/i.test(cls)) return true;
          if (r.getAttribute) {
            if (r.getAttribute('aria-checked') === 'true') return true;
            if (r.getAttribute('aria-selected') === 'true') return true;
          }
          return false;
        };

        var clickRow = function (item) {
          var r2 = item.row;
          if (isPicked(r2)) return true;
          var inp = r2.querySelector('input[type=radio],input[type=checkbox]');
          if (inp) { fireClick(inp); if (isPicked(r2)) return true; }
          var lab = r2.querySelector('label');
          if (lab) { fireClick(lab); if (isPicked(r2)) return true; }
          if (item.badge) { fireClick(item.badge); if (isPicked(r2)) return true; }
          fireClick(r2);
          return isPicked(r2);
        };

        var total = blocks.length;
        var hit = 0;
        var miss = [];

        for (var qi = 0; qi < blocks.length; qi++) {
          var list2 = blocks[qi][1];
          var no = qi + 1;
          var want = ansObj[String(no)];
          if (!want) { miss.push(no + '无答案'); continue; }

          list2.sort(function (a, bb) { return LETTERS.indexOf(a.letter) - LETTERS.indexOf(bb.letter); });
          var allOk = true;
          var letters = want.split('');
          for (var li = 0; li < letters.length; li++) {
            var L = letters[li];
            var found = null;
            for (var fi = 0; fi < list2.length; fi++) { if (list2[fi].letter === L) { found = list2[fi]; break; } }
            if (!found) { allOk = false; miss.push(no + '缺' + L); continue; }
            var ok = isPicked(found.row);
            for (var ti = 0; ti < 3 && !ok; ti++) ok = clickRow(found);
            if (!ok) { allOk = false; miss.push(no + '点不中' + L); }
          }
          if (allOk) hit++;
        }

        var firstLetters = '';
        if (blocks[0]) {
          for (var mi = 0; mi < blocks[0][1].length; mi++) firstLetters += blocks[0][1][mi].letter;
        }
        return {
          ok: true, total: total, hit: hit, miss: miss.slice(0, 25),
          badges: badges.length, rowFailed: rowFailed, firstBlock: firstLetters
        };
      };

      try {
        chrome.storage.local.get(['__applyAns'], (res) => {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: 'storage: ' + chrome.runtime.lastError.message });
            return;
          }
          try { finish(work((res && res.__applyAns) || {})); }
          catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
        });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });

    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: applyFn
    });
  } catch (e) {
    return setStatus('执行失败：' + e.message);
  } finally {
    try { await chrome.storage.local.remove(['__applyAns']); } catch (e) { /* 忽略 */ }
  }

  let total = 0;
  let hit = 0;
  const miss = [];
  let badgeTotal = 0;
  let maxBadges = 0;          // 单个 frame 采到的最大徽标数
  let bestPaths = [];         // 采到最多徽标那个 frame 的路径样例
  let bestGroupSizes = [];    // 分组结果
  let rowFailed = 0;
  const errors = [];
  (results || []).forEach((r) => {
    const d = r && r.result;
    if (!d) { errors.push('frame 无返回'); return; }
    if (d.error) errors.push(String(d.error).slice(0, 120));
    const nb = d.badges || 0;
    if (nb > maxBadges) {
      maxBadges = nb;
      bestPaths = d.badgePaths || [];
      bestGroupSizes = d.groupSizes || [];
      rowFailed = d.rowFailed || 0;
    }
    badgeTotal += nb;
    if (d.ok && d.total) {
      total += d.total;
      hit += d.hit;
      (d.miss || []).forEach((x) => miss.push(x));
    }
  });

  if (!total) {
    const errLine = errors.length ? `\n报错：${errors.join(' / ')}\n` : '\n';
    // 只按「是否有 frame 采到徽标」来判，不看没题目的主页面
    if (maxBadges < 2) {
      return setStatus(`没采到单字母节点（最多 ${maxBadges} 个）。` + errLine +
        '选项字母可能不是独立元素，或注入被页面 CSP 拦住。');
    }
    return setStatus(
      `采到 ${maxBadges} 个字母节点，但没组成 ≥2 项的选项区。` + errLine +
      `row 定位失败 ${rowFailed} 个\n` +
      `各容器内字母数：${bestGroupSizes.slice(0, 15).join(', ') || '空'}\n\n` +
      `样例路径：\n${bestPaths.slice(0, 4).join('\n')}`
    );
  }

  const compact = Object.keys(answers).sort((a, b) => a - b)
    .map((k) => `${k}.${answers[k]}`).join('  ');

  setStatus(
    `✓ 已勾选 ${hit}/${total} 题（页面共 ${badgeTotal} 个选项节点）\n` +
    (miss.length ? `⚠ 未完成：${miss.join('、')}\n` : '') +
    `\n答案：${compact}`
  );
});

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

// 导出原始文本：完全不做解析，把每个 frame 的 innerText 原样取出来。
// 用来确认 C、D 到底以什么形式存在，别再靠猜。
$('raw').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  setStatus('正在读取原始文本…');

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const b = document.body;
        if (!b) return { href: location.href, text: '', url: location.href };
        const full = b.innerText || '';

        // 统计「文本恰好是一个 A-H 字母」的元素，看 C、D 节点到底有没有
        const badgeCount = {};
        const badgeSample = {};
        document.querySelectorAll('*').forEach((el) => {
          if (el.children.length > 3) return;
          const t = (el.textContent || '').replace(/\s+/g, '');
          if (!/^[A-H]$/.test(t)) return;
          badgeCount[t] = (badgeCount[t] || 0) + 1;
          if (!badgeSample[t]) {
            const cls = typeof el.className === 'string' ? el.className : '';
            badgeSample[t] = `<${el.tagName.toLowerCase()}${cls ? ' class="' + cls.slice(0, 40) + '"' : ''}>`;
          }
        });

        return {
          url: location.href,
          frames: window.frames.length,
          textLen: full.length,
          text: full,
          badgeCount,
          badgeSample
        };
      }
    });
  } catch (e) {
    return setStatus('读取失败：' + e.message);
  }

  const parts = [];
  const badgeLines = [];
  (results || []).forEach((r, i) => {
    const d = r && r.result;
    if (!d) return;
    if (d.badgeCount && Object.keys(d.badgeCount).length) {
      const s = Object.keys(d.badgeCount).sort()
        .map((k) => `${k}=${d.badgeCount[k]}${d.badgeSample[k] ? '' + d.badgeSample[k] : ''}`)
        .join('  ');
      badgeLines.push(`frame ${i}: ${s}`);
    }
    if (!d.text) return;
    parts.push(`===== frame ${i} =====\n${d.url}\n长度 ${d.text.length}\n${d.text}`);
  });

  if (!parts.length) return setStatus('所有 frame 都没有可读文本。');

  const full = parts.join('\n\n');
  const badgeReport = badgeLines.length ? badgeLines.join('\n') : '（没有任何单字母元素）';

  try {
    await chrome.storage.local.set({
      lastRawText: { text: full, badge: badgeReport, at: Date.now() },
      lastDump: { text: full, count: 0, at: Date.now() }
    });
  } catch (e) { /* 忽略 */ }

  // 按行首字母统计，看出 C、D 行在不在
  const cnt = {};
  'ABCD'.split('').forEach((L) => {
    const m = full.match(new RegExp('(^|\\n)\\s*' + L + '\\s*[\\.．、,，:：\\)）]?\\s', 'g'));
    cnt[L] = m ? m.length : 0;
  });
  const rowStat = `行首字母 A=${cnt.A} B=${cnt.B} C=${cnt.C} D=${cnt.D}`;

  try {
    await navigator.clipboard.writeText(full);
    setStatus(`✓ 已复制原始文本（${full.length} 字符）\n\n【单字母元素统计】\n${badgeReport}\n\n【${rowStat}】\n\n` + full.slice(0, 2500));
  } catch (e) {
    setStatus(`共 ${full.length} 字符（复制失败，手动选中）\n\n【单字母元素统计】\n${badgeReport}\n\n【${rowStat}】\n\n` + full.slice(0, 2500));
  }
});

// 导出题目：抓到什么就原样列出，直接粘给豆包
// 从纯文本里解析题目。文本格式实测为：
//   1 题干…… (单选题)
//   A 选项文字
//   B 选项文字
//   C 选项文字
//   D 选项文字
// 这条路径只依赖 innerText，不碰 DOM 结构，最稳。
function parsePlainQuestions(text) {
  const lines = String(text || '')
    .split('\n')
    .map((s) => s.replace(/\u00a0/g, ' ').replace(/\s+$/, '').trim())
    .filter(Boolean);

  const out = [];
  let cur = null;

  const optOf = (s) => {
    let m = s.match(/^([A-H])\s+(\S.*)$/);
    if (m) return { letter: m[1], text: m[2].trim() };
    m = s.match(/^([A-H])$/);
    if (m) return { letter: m[1], text: '' };
    return null;
  };
  const isStemLine = (s) => /^\d{1,3}\s+\S/.test(s);

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const o = optOf(ln);

    // 选项行：必须按 A→B→C 顺序接上，否则当噪声跳过
    if (o && cur) {
      const expect = 'ABCDEFGH'[cur.options.length];
      if (o.letter === expect) {
        let body = o.text;
        if (!body) {
          const next = lines[i + 1] || '';
          if (next && !optOf(next) && !isStemLine(next)) { body = next; i++; }
        }
        if (body) { cur.options.push({ letter: o.letter, text: body }); continue; }
      }
    }

    // 题目行：题号 + 题干；当前题已有 ≥2 选项时才开新题
    if (isStemLine(ln) && (!cur || cur.options.length >= 2)) {
      cur = { stem: ln.replace(/^\d{1,3}\s+/, '').trim(), options: [] };
      out.push(cur);
      continue;
    }

    // 其余行为续行：没有选项时并入题干，有选项时并入上一个选项
    if (cur) {
      if (cur.options.length === 0) {
        cur.stem = (cur.stem + ' ' + ln).trim();
      } else {
        const last = cur.options[cur.options.length - 1];
        last.text = (last.text + ' ' + ln).trim();
      }
    }
  }

  return out.filter((q) => q.stem && q.options.length >= 2);
}

// 导出题目：取每个 frame 的 innerText（与「导出原始文本」同一路径），
// 再用 parsePlainQuestions 解析。DOM 抓取走不通时这条一定可行。
$('dump').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return setStatus('没有活动标签页');
  setStatus('正在抓取题目…');

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const b = document.body;
        return { url: location.href, text: b ? (b.innerText || '') : '' };
      }
    });
  } catch (e) {
    return setStatus('抓取失败：' + e.message);
  }

  // 逐 frame 解析，取题目最多的那个（通常就是含题目的 iframe）
  let best = [];
  let bestUrl = '';
  let bestText = '';
  const detail = [];
  (results || []).forEach((r) => {
    const d = r && r.result;
    if (!d || !d.text) return;
    const qs = parsePlainQuestions(d.text);
    detail.push(`${String(d.url).slice(-40)} → ${qs.length} 题`);
    if (qs.length > best.length) { best = qs; bestUrl = d.url; bestText = d.text; }
  });

  if (!best.length) {
    return setStatus('没解析出题目。各 frame 结果：\n' + (detail.join('\n') || '(全部为空)') +
      '\n\n点「导出原始文本」把内容发出来。');
  }

  // 比对「文本里出现过的题号数」与「实际解析出的题数」，找出只有题干没有选项的题
  const numSet = new Set();
  String(bestText).split('\n').forEach((ln) => {
    const m = ln.trim().match(/^(\d{1,3})\s+\S/);
    if (m) numSet.add(Number(m[1]));
  });
  const parsedCount = best.length;
  const maxNo = numSet.size ? Math.max(...numSet) : parsedCount;
  const missing = [];
  if (maxNo > parsedCount) {
    for (let n = 1; n <= maxNo; n++) {
      if (!numSet.has(n)) missing.push(n + '(文本里没有题号)');
    }
    // 有题号但选项不足的，也算在下面 bad 里
  }

  const stat = {};
  best.forEach((q) => { const n = q.options.length; stat[n] = (stat[n] || 0) + 1; });
  const statLine = Object.keys(stat).sort().map((n) => `${n}项×${stat[n]}题`).join('  ');

  const blocks = best.map((q, i) => {
    const ls = [`${i + 1}. ${q.stem}`];
    q.options.forEach((o) => ls.push(`${o.letter}. ${o.text}`));
    return ls.join('\n');
  });

  const head = `下面是 ${best.length} 道实验室安全教育选择题，请逐题给出正确答案的选项字母（单选给一个字母，多选给多个字母连写），并说明理由。`;
  const text = head + '\n\n' + blocks.join('\n\n');

  try {
    await chrome.storage.local.set({
      lastDump: { text, count: best.length, at: Date.now(), stat: statLine }
    });
  } catch (e) { /* 忽略 */ }

  const bad = best.map((q, i) => ({ i: i + 1, n: q.options.length })).filter((x) => x.n < 4);

  const warnLines = [];
  if (bad.length) warnLines.push(`⚠ 不足 4 项：${bad.map((x) => '第' + x.i + '题(' + x.n + ')').join('、')}`);
  if (maxNo > parsedCount) warnLines.push(`⚠ 页面共 ${maxNo} 个题号，只解析出 ${parsedCount} 题（末尾几题可能没加载出选项，往下滚动后再导一次）`);

  try {
    await navigator.clipboard.writeText(text);
    setStatus(
      `✓ 已复制 ${parsedCount} 题 · 选项分布：${statLine}\n` +
      (warnLines.length ? warnLines.join('\n') + '\n' : '') +
      `\n` + text
    );
  } catch (e) {
    setStatus(`共 ${parsedCount} 题 · ${statLine}（复制失败，手动选中）\n\n` + text);
  }
});

// 统一渲染一份 lastAnswers
function renderList(la) {
  const lines = [];
  (la.detail || []).forEach((d) => {
    const mark = d.ans === '?' ? '？存疑' : (d.unsure ? '⚠存疑' : '');
    lines.push(`【第${d.no}题】答案：${d.ans}${mark ? '  ' + mark : ''}`);
    if (d.stem) lines.push(`  ${String(d.stem).slice(0, 90)}`);
    (d.picked || []).forEach((p) => lines.push(`  → ${String(p).slice(0, 50)}`));
    if (d.pick) lines.push(`  模型原话：${String(d.pick).slice(0, 50)}`);
    if (d.why) lines.push(`  理由：${d.why}`);
    if (d.warn) lines.push(`  注意：${d.warn}`);
  });
  lines.push('');
  lines.push('—— 速览 ——');
  if (la.compact) lines.push(la.compact);
  else lines.push((la.detail || []).map((d) => `${d.no}.${d.ans}`).join('  '));
  setStatus(lines.join('\n'));
}

// 打开弹窗时自动恢复上次结果（与悬浮窗共用同一份数据）
(async function restore() {
  const r = await chrome.storage.local.get(['lastAnswers']);
  const la = r && r.lastAnswers;
  if (!la || !la.detail || !la.detail.length) return;
  renderList(la);
})();

// 悬浮窗算出结果后，弹窗若还开着也同步
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lastAnswers) return;
  const la = changes.lastAnswers.newValue;
  if (!la || !la.detail || !la.detail.length) return;
  renderList(la);
});

