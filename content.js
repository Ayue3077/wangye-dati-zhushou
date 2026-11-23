'use strict';

if (window.__aqaInjected) {
  // 已注入过，跳过重复初始化，只保留消息监听
} else {
  window.__aqaInjected = true;
  initAll();
}

function initAll() {

/* ================= 基础工具 ================= */

const LETTERS = 'ABCDEFGH';

function norm(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function txt(el) {
  if (!el) return '';
  return norm(el.innerText || el.textContent || '');
}

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  // 注意：滚动区域外的元素 rect 可能为 0，不能只靠尺寸判断，
  // 否则页面下方的 C、D 选项会被误判为不可见（只识别到 A、B 的主因之一）。
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
  const hasBox = r.width >= 2 && r.height >= 2;
  if (hasBox) return true;
  // 尺寸为 0 但在正常文档流里、有文本，也当可见（懒渲染/离屏元素）
  return !!(el.offsetParent !== null || (el.innerText || '').trim().length);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 一次逻辑点击 = pointerdown/mousedown/pointerup/mouseup + 一个 click。
// 注意：不要既 dispatch click 又调 el.click()，那是两次点击。
function fireClick(el) {
  if (!el) return;
  const opts = { bubbles: true, cancelable: true, view: window };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => {
    try {
      const ev = t.startsWith('pointer') ? new PointerEvent(t, opts) : new MouseEvent(t, opts);
      el.dispatchEvent(ev);
    } catch (e) { /* 忽略 */ }
  });
  try {
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
  } catch (e) { /* 忽略 */ }
}

function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + s.length;
}

/* ================= 常量 ================= */

const OPT_RE = /^([A-Ha-h])\s*[\.．、,，:：)）\]】]?\s*(\S[\s\S]*)$/;
const STEM_HINT_RE = /(单选题|多选题|判断题|不定项|选择题)/;
const MULTI_RE = /(多选题|不定项|多选)/;

/* ================= 策略 A：表单控件 ================= */

// 不再用 isVisible 过滤 input：大量系统用自定义圆点，真实 input 被 opacity:0 隐藏
function detectByRadio() {
  const inputs = Array.from(document.querySelectorAll('input[type=radio],input[type=checkbox]'));
  if (!inputs.length) return [];

  const groups = new Map();
  inputs.forEach((inp, i) => {
    const name = (inp.name || '').trim();
    let key;
    if (name) key = 'n:' + name;
    else {
      // 无 name：用最近的、含多个同类 input 的祖先 + 序号在下面再细分
      key = 'anon:' + (inp.parentElement ? Array.prototype.indexOf.call(document.querySelectorAll('input'), inp) : i);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inp);
  });

  // 无 name 的逐组拆开：同一父节点下每个 input 各自成组不可靠，改为按父节点聚
  const anon = new Map();
  for (const [k, list] of Array.from(groups)) {
    if (!k.startsWith('anon:')) continue;
    groups.delete(k);
    list.forEach((inp) => {
      const p = inp.parentElement;
      const pk = 'p:' + (p ? Array.prototype.indexOf.call(p.children, inp) : 0) + ':' + (p ? p.className : '');
      // 同一父节点下的所有 input 视为一组
      const parentKey = p;
      if (!anon.has(parentKey)) anon.set(parentKey, []);
      anon.get(parentKey).push(inp);
    });
  }
  let anonN = 0;
  for (const [p, list] of anon) {
    anonN++;
    groups.set('anon' + anonN, list);
  }

  const questions = [];
  let idx = 0;

  groups.forEach((list) => {
    if (!list.length) return;
    let box = list[0].parentElement;
    while (box && !list.every((r) => box.contains(r))) box = box.parentElement;
    if (!box) box = list[0].parentElement;

    const options = list.map((inp, i) => {
      const holder = inp.closest('label') || inp.parentElement;
      let t = txt(holder) || '';
      let letter = LETTERS[i];
      const m = t.match(OPT_RE);
      if (m) { letter = m[1].toUpperCase(); t = norm(m[2]); }
      return { letter, text: (t || ('选项' + letter)).slice(0, 200), el: holder, input: inp };
    });

    if (options.length < 2) return;

    // 题干：从 box 向上找带题型词或空括号的祖先
    let stem = '';
    let p = box;
    for (let d = 0; d < 8 && p; d++) {
      const t = txt(p);
      if (STEM_HINT_RE.test(t) || /（\s*）|\(\s*\)/.test(t)) {
        const cut = t.search(/[A-H]\s*[\.．、)）]/);
        const cand = cut > 0 ? t.slice(0, cut) : t;
        if (cand.length >= 5) { stem = cand; break; }
      }
      p = p.parentElement;
    }
    if (!stem && box.previousElementSibling) stem = txt(box.previousElementSibling);
    if (!stem) stem = txt(box).split(/[A-H]\s*[\.．、]/)[0];

    if (!norm(stem)) return;
    idx++;
    const multi = list[0].type === 'checkbox' || MULTI_RE.test(stem);
    questions.push({
      id: idx,
      stem: norm(stem).slice(0, 400),
      options,
      box,
      multi
    });
  });

  return questions;
}

/* ================= 策略 B：字母徽标（字母单独成节点） ================= */

const BADGE_RE = /^([A-Ha-h])$/;

function findBadges() {
  const all = document.querySelectorAll('div,span,li,p,td,b,strong,em,i,a');
  const out = [];
  all.forEach((el) => {
    if (!isVisible(el)) return;
    const t = txt(el);
    if (!BADGE_RE.test(t)) return;
    // 只取最内层
    for (const ch of el.children) {
      if (BADGE_RE.test(txt(ch))) return;
    }
    out.push({ el, letter: t.toUpperCase() });
  });
  return out;
}

function detectByBadge() {
  const badges = findBadges();
  if (badges.length < 2) return [];

  // 关键改动：不再按「字母连续」切分。字母链一旦在 B 之后断掉，
  // 就会把一题的 A/B 和 C/D 拆成两组，C/D 组题干被减光后丢弃 —— 结果每题只剩 A、B。
  // 改为：对每个徽标向上找「题目容器」，同容器的徽标归为一题，字母缺失不再影响分组。

  // 1) 为每个徽标计算候选容器：向上 8 层，按「含单字母徽标的行数」选最佳
  const probe = (badge) => {
    const chain = [];
    let p = badge.el.parentElement;
    for (let d = 0; d < 8 && p; d++) {
      if (p === document.body || p === document.documentElement) break;
      chain.push(p);
      p = p.parentElement;
    }
    return chain;
  };

  // 统计每个候选容器里有多少个徽标落在它内部
  const score = new Map();
  badges.forEach((b) => {
    probe(b).forEach((p) => {
      score.set(p, (score.get(p) || 0) + 1);
    });
  });

  // 每个徽标取「包含徽标数 ≥2 且层级最深」的容器 = 该题容器
  const bucket = new Map();   // 容器 -> 徽标数组
  badges.forEach((b) => {
    const chain = probe(b);
    let best = null;
    for (const p of chain) {
      const n = score.get(p) || 0;
      // 容器内徽标数在 2..8 之间才算选项容器，避免把整页当容器
      if (n >= 2 && n <= 8) { best = p; break; }   // chain 由内向外，第一个满足的就是最深的
    }
    if (!best) return;
    if (!bucket.has(best)) bucket.set(best, []);
    bucket.get(best).push(b);
  });

  const out = [];
  bucket.forEach((items, box) => {
    // 按字母排序（同容器内 A/B/C/D 顺序稳定）
    const uniq = [];
    const seenL = new Set();
    items.forEach((b) => {
      const k = b.letter;
      if (seenL.has(k)) return;
      seenL.add(k);
      uniq.push(b);
    });
    uniq.sort((a, b) => LETTERS.indexOf(a.letter) - LETTERS.indexOf(b.letter));
    if (uniq.length < 2) return;

    // 2) 每一行 = 直达 box 子节点的那层，含该徽标
    const rows = [];
    uniq.forEach((b) => {
      let row = b.el;
      let guard = 0;
      while (row.parentElement && row.parentElement !== box && guard++ < 12) row = row.parentElement;
      rows.push({ letter: b.letter, el: row, badge: b.el });
    });

    // 3) 行文本 = 行内容去掉开头字母
    rows.forEach((r) => {
      let t = txt(r.el).replace(new RegExp('^\\s*' + r.letter + '\\s*'), '');
      r.text = norm(t).slice(0, 300);
    });

    const opts = rows.filter((r) => r.text.length >= 1);
    if (opts.length < 2) return;

    // 4) 题干 = 容器全文 减去 所有行文本（含未成选项的行）
    let stem = txt(box);
    rows.map((r) => txt(r.el))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .forEach((rt) => { stem = stem.split(rt).join(' '); });
    stem = norm(stem);

    // 题干太短说明容器选得太小（只框住了选项），试上一层容器
    if (stem.length < 4) {
      const up = box.parentElement;
      if (up && up !== document.body && up !== document.documentElement) {
        let s2 = txt(up);
        rows.map((r) => txt(r.el)).filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .forEach((rt) => { s2 = s2.split(rt).join(' '); });
        s2 = norm(s2);
        if (s2.length >= 4) { stem = s2; box = up; }
      }
    }
    if (stem.length < 4) return;

    out.push({
      id: out.length + 1,
      stem: stem.slice(0, 400),
      options: opts.map((r) => ({ letter: r.letter, text: r.text, el: r.el, input: null, badge: r.badge })),
      box,
      multi: MULTI_RE.test(stem)
    });
  });

  return out;
}

/* ================= 策略 C：字母开头的文本选项 ================= */

function leafOptionNodes() {
  const all = document.querySelectorAll('div,li,p,span,label,td,dd,tr,a');
  const out = [];
  all.forEach((el) => {
    if (!isVisible(el)) return;
    const t = txt(el);
    if (!t || t.length > 400) return;
    const m = t.match(OPT_RE);
    if (!m) return;
    let hasChildMatch = false;
    for (const ch of el.children) {
      const ct = txt(ch);
      if (ct && ct.length < t.length && OPT_RE.test(ct)) { hasChildMatch = true; break; }
    }
    if (hasChildMatch) return;
    out.push({ el, letter: m[1].toUpperCase(), text: norm(m[2]) });
  });
  return out;
}

function detectByText() {
  const nodes = leafOptionNodes();
  if (nodes.length < 2) return [];

  const groups = [];
  let cur = null;
  nodes.forEach((n) => {
    const pos = n.el.getBoundingClientRect();
    let same = false;
    if (cur) {
      const prev = cur.items[cur.items.length - 1];
      const pPos = prev.el.getBoundingClientRect();
      const below = pos.top > pPos.top - 2;
      const nextLetter = LETTERS.indexOf(n.letter) === LETTERS.indexOf(prev.letter) + 1;
      same = below && nextLetter;
    }
    if (!same) { cur = { items: [n] }; groups.push(cur); }
    else cur.items.push(n);
  });

  const out = [];
  groups.filter((g) => g.items.length >= 2).forEach((g) => {
    const first = g.items[0].el;
    const allIn = (el) => g.items.every((it) => el.contains(it.el));
    let box = first.parentElement;
    for (let d = 0; d < 6 && box && !allIn(box); d++) box = box.parentElement;
    if (!box) box = first.parentElement;

    let stem = '';
    let p = box;
    for (let d = 0; d < 8 && p; d++) {
      const t = txt(p);
      if (STEM_HINT_RE.test(t)) {
        const cut = t.search(/[A-H]\s*[\.．、)）]/);
        const cand = cut > 0 ? t.slice(0, cut) : t;
        if (cand.length >= 5) { stem = cand; break; }
      }
      p = p.parentElement;
    }
    if (!stem && box.previousElementSibling) stem = txt(box.previousElementSibling);
    if (!stem) stem = txt(box).split(/[A-H]\s*[\.．、]/)[0];

    out.push({
      id: out.length + 1,
      stem: norm(stem).slice(0, 400),
      options: g.items.map((it) => ({ letter: it.letter, text: it.text, el: it.el, input: null })),
      box,
      multi: MULTI_RE.test(stem)
    });
  });

  return out.filter((q) => q.stem);
}

/* ================= 策略 C：结构推断（无字母无 input） ================= */

function detectByStructure() {
  const all = document.querySelectorAll('div,p,li,span,section,strong,b,h1,h2,h3,h4');
  const stems = [];
  all.forEach((el) => {
    if (!isVisible(el)) return;
    const t = txt(el);
    if (!t || t.length < 6 || t.length > 400) return;
    if (!/(（\s*）|\(\s*\)|？|\?)/.test(t)) return;
    // 取最内层
    let dup = false;
    for (const ch of el.children) {
      const ct = txt(ch);
      if (ct && ct.length > 4 && Math.abs(ct.length - t.length) < 4 && /（\s*）|？/.test(ct)) { dup = true; break; }
    }
    if (dup) return;
    stems.push({ el, t });
  });

  const out = [];
  stems.forEach((st) => {
    let box = st.el.parentElement;
    let rows = null;
    for (let d = 0; d < 6 && box; d++) {
      const kids = Array.from(box.children).filter((k) => {
        if (k === st.el || !isVisible(k)) return false;
        const kt = txt(k);
        return kt && kt.length >= 1 && kt.length <= 400;
      });
      const after = kids.filter((k) => (st.el.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      if (after.length >= 2 && after.length <= 10) {
        const sig = after.map((k) => k.tagName + '|' + k.className);
        const uniform = sig.every((s) => s === sig[0]);
        if (uniform) { rows = after; break; }
      }
      box = box.parentElement;
    }
    if (!rows || rows.length < 2) return;

    const options = rows.map((k, i) => {
      let t = txt(k);
      let letter = LETTERS[i];
      const m = t.match(OPT_RE);
      if (m) { letter = m[1].toUpperCase(); t = norm(m[2]); }
      const inp = k.querySelector('input[type=radio],input[type=checkbox]');
      return { letter, text: t.slice(0, 200), el: k, input: inp };
    }).filter((o) => o.text);

    if (options.length < 2) return;
    out.push({
      id: out.length + 1,
      stem: norm(st.t).slice(0, 400),
      options,
      box,
      multi: MULTI_RE.test(st.t)
    });
  });

  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  list.forEach((q) => {
    const k = q.stem.slice(0, 60);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(q);
  });
  out.forEach((q, i) => { q.id = i + 1; });
  return out;
}

/* ================= 策略 E：纯文本切分（终极兜底，不看 DOM 结构） ================= */

// 把整页 innerText 按「题型标记」切成题目块，再从块里切出 A/B/C/D 选项。
// 这条路完全绕开 DOM 结构差异，专治"只识别到 A、B"。
function detectByPlainText() {
  const root = document.body;
  if (!root) return [];
  const full = (root.innerText || '').replace(/\u00a0/g, ' ');
  if (full.length < 30) return [];

  const lines = full.split('\n').map((s) => s.replace(/\s+$/, '')).filter((s) => s.trim());
  const out = [];

  // 单字母行 / 字母开头的选项行
  const LETTER_LINE = /^([A-H])\s*[.．、,，:：)）]?\s*(.*)$/;
  const TYPE_END = /（\s*(单选题|多选题|判断题|不定项选择题?)\s*）|\(\s*(单选题|多选题|判断题|不定项选择题?)\s*\)/;

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    // 找题目起点：含题型标记，或以「数字. 」开头且下一行是 A 选项
    const isStem = TYPE_END.test(ln)
      || (/^\s*\d{1,3}\s*[.．、]/.test(ln) && i + 1 < lines.length && /^A\s*[.．、,，:：)）]/.test(lines[i + 1]));
    if (!isStem) { i++; continue; }

    // 收集题干（可能跨行）
    let stemParts = [ln];
    let j = i + 1;
    while (j < lines.length && !/^A\s*[.．、,，:：)）]/.test(lines[j]) && j - i < 4) {
      // 下一题开始就停
      if (TYPE_END.test(lines[j])) break;
      stemParts.push(lines[j]);
      j++;
    }
    let stem = norm(stemParts.join(' '));
    if (stem.length < 5) { i++; continue; }

    // 收选项：A/B/C/D 开头，允许选项内容跨行
    const opts = [];
    let expect = 'A';
    while (j < lines.length) {
      const m = lines[j].match(LETTER_LINE);
      if (!m) {
        // 非选项行：如果已经有选项且是题目边界，结束
        if (opts.length && TYPE_END.test(lines[j])) break;
        if (!opts.length) break;
        // 附加到上一个选项
        if (opts.length) {
          opts[opts.length - 1].text = norm(opts[opts.length - 1].text + ' ' + lines[j]);
          j++;
          continue;
        }
        break;
      }
      const letter = m[1];
      const body = norm(m[2]);
      if (letter !== expect) {
        // 字母不连续就停（下一题或噪声）
        if (opts.length) break;
        if (letter === 'A') { /* 继续 */ } else { j++; continue; }
      }
      // 单字母行（内容在下一行）
      if (!body) {
        const next = lines[j + 1] || '';
        opts.push({ letter, text: norm(next).slice(0, 300) });
        j += 2;
      } else {
        opts.push({ letter, text: body.slice(0, 300) });
        j++;
      }
      expect = LETTERS[LETTERS.indexOf(letter) + 1];
      if (!expect) break;
    }

    if (opts.length >= 2) {
      // 题干去掉开头的题号（"1." / "12、"）和题型括号
      let s = norm(stem).replace(/^\d{1,3}\s*[.．、]\s*/, '').replace(/^\d{1,3}\s+(?=[^\d])/, '');
      out.push({
        id: out.length + 1,
        stem: s.slice(0, 400),
        options: opts
          .filter((o) => o.text)
          .map((o) => ({ letter: o.letter, text: o.text, el: null, input: null, badge: null })),
        box: null,
        multi: MULTI_RE.test(s)
      });
    }
    i = Math.max(j, i + 1);
  }

  return out.filter((q) => q.options.length >= 2);
}

/* ================= 汇总 ================= */

function completeness(qs) {
  // 选项数的平均值：4 个选项比 2 个更可信
  if (!qs.length) return 0;
  const sum = qs.reduce((a, q) => a + Math.min(q.options.length, 6), 0);
  return sum / qs.length;
}

function detectQuestions() {
  // 顺序按可靠性：表单控件 → 字母徽标 → 字母文本 → 结构推断 → 纯文本兜底
  const attempts = [detectByRadio, detectByBadge, detectByText, detectByStructure, detectByPlainText];
  let best = [];
  let bestScore = -1;

  for (const fn of attempts) {
    let r = [];
    try { r = fn(); } catch (e) { r = []; }
    r = r.filter((q) => q.options.length >= 2 && q.stem);
    if (!r.length) continue;

    // 打分：题数 × 平均选项数。这样「25 题每题 2 项」不会压过「25 题每题 4 项」
    const s = r.length * completeness(r);
    if (s > bestScore) { bestScore = s; best = r; }
  }

  return dedupe(best);
}

function qkey(q) {
  return hashKey(q.stem + '||' + q.options.map((o) => o.letter + o.text).join('|'));
}

// 题干里常把选项内容一起带进来，截到题型标记（单选题）为止；没有就截到第一个 「 A xxx」
function cleanStem(s) {
  let t = norm(s);
  if (!t) return t;

  const m = t.match(/(单选题|多选题|判断题|不定项选择题|不定项)/);
  if (m) {
    let end = t.indexOf(m[0]) + m[0].length;
    if (t[end] === '）' || t[end] === ')') end++;
    const cut = norm(t.slice(0, end));
    if (cut.length >= 4) return cut;
  }

  const mm = t.match(/\s([A-H])\s*[\s\S]/);
  if (mm && mm.index > 5) {
    const before = norm(t.slice(0, mm.index));
    if (before.length >= 4) return before;
  }
  return t;
}

/* ================= 点击与标记 ================= */

function markOption(opt) {
  const el = opt.el || opt.input;
  if (!el || !el.style) return;
  el.style.setProperty('outline', '2px solid #0f7b6c', 'important');
  el.style.setProperty('outline-offset', '2px', 'important');
  el.style.setProperty('border-radius', '4px', 'important');
}

// 只点一次。多次 fireClick 会让页面重复响应（表现为一次点击画出多个圈）
function clickOption(opt) {
  if (opt.input) {
    fireClick(opt.input);
    return;
  }
  // 字母徽标型：点圆圈本身
  if (opt.badge) {
    fireClick(opt.badge);
    return;
  }
  const row = opt.el;
  if (!row) return;
  const hit = row.querySelector('input[type=radio],input[type=checkbox],label');
  fireClick(hit || row);
}

// 用题干+字母，重新在页面上找当前这一题（页面重渲染后旧节点会失效）
function relocate(q, letter) {
  const all = detectQuestions();
  // 先按题干精确匹配，再按前缀匹配
  let hit = all.find((x) => x.stem === q.stem);
  if (!hit) hit = all.find((x) => q.stem && x.stem.startsWith(q.stem.slice(0, 20)));
  if (!hit) return null;
  const opt = hit.options.find((o) => o.letter === letter);
  return opt ? { q: hit, opt } : null;
}

// 判断某个选项当前是否已被选中
function isPicked(opt) {
  try {
    const inp = opt.input || (opt.el && opt.el.querySelector && opt.el.querySelector('input[type=radio],input[type=checkbox]'));
    if (inp) return !!inp.checked;
    // 无原生 input：看 class 里是否带 selected/active/checked
    const nodes = [opt.el, opt.badge].filter(Boolean);
    for (const n of nodes) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/(^|[\s_-])(selected|active|checked|current|on)([\s_-]|$)/i.test(cls)) return true;
      if (n.getAttribute && (n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true')) return true;
    }
  } catch (e) { /* 忽略 */ }
  return false;
}

async function answerOne(q, ansStr) {
  const letters = Array.from(new Set(String(ansStr || '').toUpperCase().match(/[A-H]/g) || []));
  if (!letters.length) return `第${q.id}题：无答案`;
  const use = q.multi ? letters : [letters[0]];
  const hit = [];

  for (const L of use) {
    let done = false;
    // 最多 3 次：每次重新定位（防止上一步点击引发重渲染让节点失效）
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const loc = relocate(q, L);
      if (!loc) break;
      if (isPicked(loc.opt)) { done = true; break; }
      clickOption(loc.opt);
      await sleep(180);
      // 校验是否真的选上
      const check = relocate(q, L);
      if (check && isPicked(check.opt)) {
        markOption(check.opt);
        done = true;
      } else {
        await sleep(260);
      }
    }
    if (done) hit.push(L);
    await sleep(120);
  }

  if (!hit.length) return `第${q.id}题：点选失败 ${use.join('')}`;
  const miss = use.filter((L) => !hit.includes(L));
  const tail = miss.length ? `（失败 ${miss.join('')}）` : '';
  return `第${q.id}题 → ${hit.join('')}  ${q.stem.slice(0, 24)}${tail}`;
}

/* ================= 滚动 ================= */

function getScroller() {
  const de = document.documentElement;
  const b = document.body;
  if (de && de.scrollHeight > de.clientHeight + 60) return de;
  if (b && b.scrollHeight > b.clientHeight + 60) return b;

  let best = null;
  document.querySelectorAll('div,main,section,article').forEach((el) => {
    if (!isVisible(el)) return;
    if (el.scrollHeight <= el.clientHeight + 120) return;
    const st = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(st.overflowY)) return;
    if (!best || el.scrollHeight - el.clientHeight > best.scrollHeight - best.clientHeight) best = el;
  });
  return best;
}

function scrollInfo() {
  const el = getScroller();
  if (!el) {
    // iframe 内自身不可滚动：滚动条在父页面
    if (window.top !== window) {
      return { el: null, top: 0, view: 0, total: 0, atBottom: false, foreign: true };
    }
    return null;
  }
  const isDoc = el === document.documentElement || el === document.body;
  const top = isDoc ? window.scrollY : el.scrollTop;
  const view = isDoc ? window.innerHeight : el.clientHeight;
  const total = el.scrollHeight;
  return { el, top, view, total, atBottom: top + view >= total - 40, foreign: false };
}

function scrollDown(ratio) {
  const info = scrollInfo();
  if (!info) return false;

  // 滚动条在父页面：向父窗口请求滚动
  if (info.foreign) {
    try {
      window.parent.postMessage({
        __aqaScroll: true,
        ratio: ratio || 0.85,
        tag: 'aqa-scroll'
      }, '*');
      return true;
    } catch (e) { return false; }
  }

  const step = Math.max(200, Math.round(info.view * (ratio || 0.85)));
  const next = Math.min(info.top + step, info.total);
  if (next <= info.top + 5) return false;
  const el = info.el;
  const isDoc = el === document.documentElement || el === document.body;
  try {
    if (isDoc) window.scrollTo({ top: next, behavior: 'smooth' });
    else el.scrollTo({ top: next, behavior: 'smooth' });
  } catch (e) {
    if (isDoc) window.scrollTo(0, next);
    else el.scrollTop = next;
  }
  return true;
}

function scrollTop0() {
  const info = scrollInfo();
  if (!info) return;
  const el = info.el;
  const isDoc = el === document.documentElement || el === document.body;
  try {
    if (isDoc) window.scrollTo({ top: 0, behavior: 'auto' });
    else el.scrollTo({ top: 0, behavior: 'auto' });
  } catch (e) { /* 忽略 */ }
}

/* ================= 诊断 ================= */

function diagnose() {
  const inputs = Array.from(document.querySelectorAll('input[type=radio],input[type=checkbox]'));
  const hidden = inputs.filter((i) => {
    const st = getComputedStyle(i);
    return st.display === 'none' || st.opacity === '0' || st.visibility === 'hidden' || i.offsetWidth === 0;
  }).length;

  const letters = leafOptionNodes();
  const stems = Array.from(document.querySelectorAll('div,p,li,span,section'))
    .filter((el) => {
      const t = txt(el);
      return t && t.length >= 6 && t.length <= 400 && /（\s*）|\(\s*\)|？|\?/.test(t) && isVisible(el);
    }).length;

  // 采样式：体量在 8-160 的可视文本块
  const samples = [];
  const seen = new Set();
  document.querySelectorAll('div,li,p,span,label').forEach((el) => {
    if (samples.length >= 25) return;
    if (!isVisible(el)) return;
    const t = txt(el);
    if (!t || t.length < 8 || t.length > 160) return;
    if (seen.has(t)) return;
    seen.add(t);
    const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 40);
    samples.push(`<${el.tagName.toLowerCase()}${cls ? ' .' + cls.trim().split(/\s+/).join('.') : ''}> ${t.slice(0, 70)}`);
  });

  const badges = findBadges();
  const badgeStat = {};
  badges.forEach((b) => { badgeStat[b.letter] = (badgeStat[b.letter] || 0) + 1; });

  // 各策略的题数 + 平均选项数
  const perStrategy = {};
  [
    ['radio', detectByRadio],
    ['badge', detectByBadge],
    ['text', detectByText],
    ['structure', detectByStructure],
    ['plain', detectByPlainText]
  ].forEach(([name, fn]) => {
    try {
      const r = fn().filter((q) => q.options.length >= 2 && q.stem);
      perStrategy[name] = r.length ? `${r.length}题/均${completeness(r).toFixed(1)}项` : '0';
    } catch (e) {
      perStrategy[name] = 'ERR:' + (e && e.message ? e.message.slice(0, 30) : e);
    }
  });

  return {
    url: location.href,
    isTop: window.top === window,
    title: document.title,
    inputs: inputs.length,
    hiddenInputs: hidden,
    letterNodes: letters.length,
    letterSample: letters.slice(0, 8).map((n) => `${n.letter}:${n.text.slice(0, 24)}`),
    stemCandidates: stems,
    iframes: document.querySelectorAll('iframe').length,
    bodyLen: txt(document.body).length,
    // 新增：徽标按字母的分布，判断 C、D 是否被采到
    badgeCount: badges.length,
    badgeLetters: badgeStat,
    strategies: perStrategy,
    chosen: (() => {
      const qs = detectQuestions();
      return qs.length ? `${qs.length}题/均${completeness(qs).toFixed(1)}项` : '0';
    })(),
    detected: {
      radio: safeCount(detectByRadio),
      bad: safeCount(detectByBadge),
      text: safeCount(detectByText),
      structure: safeCount(detectByStructure),
      plain: safeCount(detectByPlainText)
    },
    samples
  };
}

function safeCount(fn) {
  try { return fn().length; } catch (e) { return 'ERR:' + e.message; }
}

/* ================= UI ================= */

let panel = null;
let running = false;
let stopped = false;
const doneKeys = new Set();
const answerList = [];   // 只列不点模式收集的结果
const logBuf = [];       // iframe 内的日志缓冲

function buildPanel() {
  // 只在顶层窗口显示面板；iframe 里不建，避免错位
  if (window.top !== window) return null;
  if (panel && document.documentElement.contains(panel)) return panel;
  panel = document.createElement('div');
  panel.id = 'aqa-panel';
  // 纯展示面板：只有标题栏（可拖动 + 关闭）和内容区，操作走工具栏弹窗
  panel.innerHTML = `
    <div class="aqa-head" id="aqa-drag">
      <span class="aqa-title">网页答题助手</span>
      <span class="aqa-btns">
        <button class="aqa-btn aqa-x" data-act="close" title="关闭">×</button>
      </span>
    </div>
    <div class="aqa-body" id="aqa-log"></div>
    <div class="aqa-tip" id="aqa-tip">点扩展图标里的按钮操作，结果会显示在这里。</div>
  `;
  document.documentElement.appendChild(panel);
  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    if (b.dataset.act === 'close') {
      hidePanel(panel);
      try { chrome.storage.local.set({ panelClosed: true }); } catch (err) { /* 忽略 */ }
      showFab();
    }
  });
  panel.addEventListener('mousedown', (e) => e.stopPropagation());
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  makeDraggable(panel, panel.querySelector('#aqa-drag'));
  return panel;
}

/* ---------- 面板工具函数 ---------- */

function setTip(s) {
  const t = document.getElementById('aqa-tip');
  if (t) t.textContent = s;
}

// 扫一遍：统计各 frame 识别情况
async function doScan() {
  clearLog();
  const own = detectQuestions();
  log(`本窗口（${window.top === window ? '主页面' : 'iframe'}）识别到 ${own.length} 题`);
  own.slice(0, 20).forEach((q) => {
    log(` #${q.id}${q.multi ? '[多]' : ''} ${cleanStem(q.stem).slice(0, 40)}`);
    log('    ' + q.options.map((o) => `${o.letter}.${o.text.slice(0, 14)}`).join(' | '));
  });
  if (!own.length) {
    log('本窗口没题。若题目在内嵌页面里，用「只列答案」会自动转发。', true);
  }
  setTip('扫一遍完成：' + own.length + ' 题');
}

// 诊断
async function doDiag() {
  clearLog();
  const d = diagnose();
  log(`地址：${String(d.url).slice(0, 70)}`);
  log(`radio/checkbox: ${d.inputs}（隐藏 ${d.hiddenInputs}）`);
  log(`字母徽标节点: ${d.letterNodes}`);
  if (d.letterSample.length) log(`  样例: ${d.letterSample.join(' ; ')}`);
  log(`题干候选: ${d.stemCandidates}   iframe: ${d.iframes}`);
  log(`识别: radio=${d.detected.radio} 文本=${d.detected.text} 结构=${d.detected.structure}`);
  if (d.samples.length) {
    log('文本块样例:');
    d.samples.slice(0, 10).forEach((s) => log('  ' + s));
  }
  setTip('诊断完成');
}

// 复制上次答案
async function doCopy() {
  let la = null;
  try {
    const r = await chrome.storage.local.get(['lastAnswers']);
    la = r && r.lastAnswers;
  } catch (e) { /* 忽略 */ }
  if (!la || !la.compact) {
    log('还没有答案，先点「只列答案」。', true);
    setTip('无可用答案');
    return;
  }
  try {
    await navigator.clipboard.writeText(la.compact);
    log('已复制速览：');
    log(la.compact);
    setTip('已复制到剪贴板');
  } catch (e) {
    log('复制失败，速览如下：', true);
    log(la.compact);
  }
}

// 测试模型
async function doTest() {
  clearLog();
  log('测试模型中…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST' });
    if (r && r.error) { log('失败：' + r.error, true); setTip('模型连接失败'); return; }
    log('成功 ✓ 返回：' + JSON.stringify(r.answers));
    setTip('模型连接正常');
  } catch (e) {
    log('失败：' + e.message, true);
    setTip('模型连接失败');
  }
}

// 看提示词：核对模型实际收到什么、回了什么
async function doPeek() {
  clearLog();
  let d = null;
  try {
    d = await chrome.storage.local.get(['lastPrompt', 'lastRawReply']);
  } catch (e) { /* 忽略 */ }
  if (!d || !d.lastPrompt) {
    log('还没有请求记录，先点「只列答案」或「测试模型」。', true);
    setTip('无记录');
    return;
  }
  log('===== 发给模型的原文 =====');
  String(d.lastPrompt).split('\n').forEach((ln) => log(ln));
  log('');
  log('===== 模型回复的原文 =====');
  if (d.lastRawReply) String(d.lastRawReply).split('\n').forEach((ln) => log(ln));
  else log('(无)');
  setTip('上下滚动看提示词');
}

// 关闭面板后的悬浮小球
function showFab() {
  if (window.top !== window) return;
  let fab = document.getElementById('aqa-fab');
  if (fab) { setImp(fab, 'display', 'flex'); return; }
  fab = document.createElement('div');
  fab.id = 'aqa-fab';
  fab.title = '打开答题助手';
  fab.textContent = '答';
  fab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setImp(fab, 'display', 'none');
    try { chrome.storage.local.set({ panelClosed: false }); } catch (err) { /* 忽略 */ }
    const p = buildPanel();
    if (p) { p.style.removeProperty('left'); p.style.removeProperty('top'); showPanel(p); }
  });
  document.documentElement.appendChild(fab);
}

/* ================= 跨 frame 控制 ================= */

// 面板在顶层、题目在 iframe：命令经后台广播到所有 frame，谁有题谁执行
function broadcastCmd(cmd, extra) {
  try {
    chrome.runtime.sendMessage({ type: 'BROADCAST_CMD', action: cmd, extra: extra || null });
  } catch (e) { /* 忽略 */ }
}

// 顶层先自己试；本窗口没题就广播给 iframe（只让含题的 frame 执行）
async function runOnTargetFrame(action) {
  const own = detectQuestions();
  if (own.length) {
    if (action === 'start') {
      running = false; stopped = false;
      await startAuto();
    }
    if (action === 'list') await listAnswers();
    if (action === 'dump') await dumpQuestions();
    return;
  }

  clearLog();
  log('本窗口没题目，转发给内嵌页面…');
  setTip('正在内嵌页面执行…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'BROADCAST_CMD', action });
    if (r && r.error) {
      log('转发失败：' + r.error, true);
      setTip('转发失败');
    } else if (r && r.ran === 0) {
      log('内嵌页面里也没识别到题目。点「诊断」看结构。', true);
      setTip('未找到题目');
    } else {
      log(`已转发（${r ? r.ran : 0} 个 frame 执行）`);
    }
  } catch (e) {
    log('转发异常：' + e.message, true);
    setTip('转发异常');
  }
}

// CSS 里用了 !important，普通 style 赋值会被覆盖，必须同级别写
function setImp(el, prop, val) {
  if (el && el.style) el.style.setProperty(prop, val, 'important');
}

function showPanel(p) { setImp(p || panel, 'display', 'flex'); }
function hidePanel(p) { setImp(p || panel, 'display', 'none'); }

function makeDraggable(box, handle) {
  if (!box || !handle) return;
  let dragging = false;

  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';

  const onMove = (e) => {
    if (!dragging) return;
    const w = box.offsetWidth || 372;
    const h = box.offsetHeight || 200;
    let nx = e.clientX - dx;
    let ny = e.clientY - dy;
    nx = Math.max(0, Math.min(nx, window.innerWidth - w));
    ny = Math.max(0, Math.min(ny, window.innerHeight - 44));
    setImp(box, 'left', nx + 'px');
    setImp(box, 'top', ny + 'px');
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    try {
      const r = box.getBoundingClientRect();
      chrome.storage.local.set({ panelPos: { left: Math.round(r.left), top: Math.round(r.top) } });
    } catch (err) { /* 忽略 */ }
  };

  let dx = 0, dy = 0;

  handle.addEventListener('mousedown', (e) => {
    // 点按钮不触发拖动
    if (e.target.closest('[data-act]')) return;
    const r = box.getBoundingClientRect();
    dragging = true;
    dx = e.clientX - r.left;
    dy = e.clientY - r.top;
    // 切换到 left/top 定位，并压过 CSS 的 right/bottom
    setImp(box, 'right', 'auto');
    setImp(box, 'bottom', 'auto');
    setImp(box, 'left', r.left + 'px');
    setImp(box, 'top', r.top + 'px');
    e.preventDefault();
    e.stopPropagation();
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, true);

  // 恢复上次位置
  try {
    chrome.storage.local.get(['panelPos'], (r) => {
      const p = r && r.panelPos;
      if (!p || typeof p.left !== 'number') return;
      setImp(box, 'right', 'auto');
      setImp(box, 'bottom', 'auto');
      setImp(box, 'left', Math.max(0, p.left) + 'px');
      setImp(box, 'top', Math.max(0, p.top) + 'px');
    });
  } catch (e) { /* 忽略 */ }
}

// iframe 里没有面板：日志存 storage，并把内容投递到顶层面板
function log(msg, warn) {
  const box = document.getElementById('aqa-log');
  if (!box) {
    logBuf.push({ t: Date.now(), text: String(msg), warn: !!warn });
    if (logBuf.length > 300) logBuf.shift();
    try { chrome.storage.local.set({ lastLog: logBuf.slice(-120) }); } catch (e) { /* 忽略 */ }
    // 让顶层面板显示这条
    try {
      if (window.top !== window) {
        window.top.postMessage({ __aqaLog: true, text: String(msg), warn: !!warn }, '*');
      }
    } catch (e) { /* 忽略 */ }
    return;
  }
  const line = document.createElement('div');
  line.textContent = msg;
  if (warn) line.className = 'aqa-warn';
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.childElementCount > 200) box.removeChild(box.firstChild);
}

function clearLog() {
  const box = document.getElementById('aqa-log');
  if (box) box.innerHTML = '';
}

/* ================= 主流程 ================= */

// 选项完整性校验：字母必须从 A 起连续，且至少 2 个
function optionsOk(q) {
  const letters = q.options.map((o) => o.letter).filter(Boolean);
  if (letters.length < 2) return false;
  const sorted = letters.slice().sort();
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== LETTERS[i]) return false;
  }
  // 选项文本不能为空或过短
  return q.options.every((o) => (o.text || '').trim().length >= 1);
}

async function listAnswers() {
  clearLog();
  log('正在识别题目…');
  const allQs = detectQuestions();
  if (!allQs.length) {
    log('本窗口没识别到题目', true);
    if (window.top === window) log('提示：题目若在内嵌页面里，用扩展图标 →「只列答案」');
    return;
  }

  const bad = allQs.filter((q) => !optionsOk(q));
  const qs = allQs.filter((q) => optionsOk(q));
  log(`识别到 ${allQs.length} 题，选项完整 ${qs.length} 题`);
  if (bad.length) {
    log(`以下 ${bad.length} 题选项不全，跳过不答（避免瞎猜）：`, true);
    bad.forEach((q) => log(`  第${q.id}题 只识别到 ${q.options.length} 个选项：${cleanStem(q.stem).slice(0, 30)}`));
  }
  if (!qs.length) { setTip('没有选项完整的题'); return; }

  const CHUNK = 5;
  const all = [];
  for (let start = 0; start < qs.length; start += CHUNK) {
    const part = qs.slice(start, start + CHUNK);
    const payload = part.map((q, i) => ({
      id: i + 1,
      stem: cleanStem(q.stem) + (q.multi ? '（多选，给出全部正确选项）' : '（单选题）'),
      options: q.options.map((o) => ({ letter: o.letter, text: o.text }))
    }));

    log(`请求第 ${start + 1}–${start + part.length} 题…`);
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'ASK', questions: payload });
    } catch (e) {
      log('后台通信失败：' + e.message, true);
      break;
    }
    if (!resp || resp.error) {
      log('模型失败：' + ((resp && resp.error) || '未知'), true);
      break;
    }
    const ans = resp.answers || {};
    const picks = resp.picks || {};
    const whys = resp.whys || {};
    const unsures = resp.unsures || {};
    const warns = resp.warns || {};
    part.forEach((q, i) => {
      const key = String(i + 1);
      all.push({
        no: q.id,
        ans: ans[key] || '?',
        pick: picks[key] || '',
        why: whys[key] || '',
        unsure: !!unsures[key],
        warn: warns[key] || '',
        q
      });
    });
    await sleep(150);
  }

  clearLog();
  log(`—— 共 ${all.length} / ${qs.length} 题 ——`);
  all.forEach((it) => {
    const q = it.q;
    const stem = cleanStem(q.stem);
    const picked = q.options.filter((o) => String(it.ans).includes(o.letter));
    const mark = it.ans === '?' ? '？存疑' : (it.unsure ? '⚠存疑' : '');
    log(`【第${q.id}题】答案：${it.ans}${mark ? '  ' + mark : ''}`, !!mark);
    log(`  ${stem.slice(0, 70)}`);
    picked.forEach((o) => log(`  → ${o.letter}. ${o.text.slice(0, 44)}`));
    if (it.pick) log(`  模型原话：${it.pick.slice(0, 50)}`);
    if (it.why) log(`  理由：${it.why}`);
    if (it.warn) log(`  注意：${it.warn}`, true);
  });

  const compact = all.map((it) => `${it.no}.${it.ans}${it.unsure || it.ans === '?' ? '(?)' : ''}`).join('  ');
  log('');
  log('—— 速览 ——');
  log(compact);

  try {
    chrome.storage.local.set({
      lastAnswers: {
        detail: all.map((it) => ({
          no: it.no,
          ans: it.ans,
          stem: cleanStem(it.q.stem),
          picked: it.q.options.filter((o) => String(it.ans).includes(o.letter))
            .map((o) => `${o.letter}. ${o.text}`),
          pick: it.pick || '',
          why: it.why || '',
          unsure: !!it.unsure || it.ans === '?',
          warn: it.warn || ''
        })),
        compact,
        at: Date.now()
      },
      lastAnswersAt: Date.now()
    });
  } catch (e) { /* 忽略 */ }
}

// 导出题目纯文本：抓到的题原样列出，直接粘给别的模型
async function dumpQuestions() {
  clearLog();
  log('正在抓取题目…');
  const qs = detectQuestions();
  if (!qs.length) {
    log('本窗口没识别到题目', true);
    if (window.top === window) log('提示：题目若在内嵌页面里，点按钮会自动转发', true);
    return { ok: false, count: 0 };
  }

  const blocks = qs.map((q) => {
    const stem = cleanStem(q.stem);
    const lines = [`${q.id}. ${stem}`];
    q.options.forEach((o) => lines.push(`${o.letter}. ${(o.text || '').trim()}`));
    return lines.join('\n');
  });

  const head = `下面是 ${qs.length} 道实验室安全教育选择题，请逐题给出正确答案的选项字母（单选给一个字母，多选给多个字母连写），并说明理由。`;
  const text = head + '\n\n' + blocks.join('\n\n');

  // 选项数量统计，方便判断是不是又漏了 C、D
  const stat = {};
  qs.forEach((q) => { const n = q.options.length; stat[n] = (stat[n] || 0) + 1; });
  const statLine = Object.keys(stat).sort()
    .map((n) => `${n}项×${stat[n]}题`).join('  ');

  // 存起来，让顶层窗口能拿到并复制
  try {
    await chrome.storage.local.set({
      lastDump: { text, count: qs.length, at: Date.now(), stat: statLine }
    });
  } catch (e) { /* 忽略 */ }

  clearLog();
  log(`—— 抓到 ${qs.length} 题 · 选项分布：${statLine} ——`);
  const bad = qs.filter((q) => q.options.length < 4);
  if (bad.length) {
    log(`注意：${bad.length} 题不足 4 个选项（第 ${bad.map((q) => q.id).join('、')} 题）`, true);
  }
  text.split('\n').forEach((ln) => log(ln));
  setTip(`已生成 ${qs.length} 题，${statLine}`);

  // 尝试直接写剪贴板（iframe 里可能被拒，顶层会兜底）
  try {
    await navigator.clipboard.writeText(text);
    log('');
    log('✓ 已复制到剪贴板');
  } catch (e) { /* 顶层会再试 */ }

  return { ok: true, count: qs.length, stat: statLine };
}

async function askAndAnswer(qs, cfg) {
  const CHUNK = 5;
  let n = 0;

  for (let start = 0; start < qs.length; start += CHUNK) {
    const batch = qs.slice(start, start + CHUNK);
    const payload = batch.map((q, i) => ({
      id: i + 1,
      stem: cleanStem(q.stem) + (q.multi ? '（多选，请给出全部正确选项）' : ''),
      options: q.options.map((o) => ({ letter: o.letter, text: o.text }))
    }));

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'ASK', questions: payload });
    } catch (e) {
      log('后台通信失败：' + e.message, true);
      break;
    }
    if (!resp || resp.error) {
      log('模型失败：' + ((resp && resp.error) || '未知'), true);
      break;
    }

    const answers = resp.answers || {};
    const unsures = resp.unsures || {};
    const warns4 = resp.warns || {};
    for (let i = 0; i < batch.length; i++) {
      const q = batch[i];
      const key = String(i + 1);
      const a = answers[key];
      doneKeys.add(qkey(q));
      if (!a || a === '?') {
        log(`  #${q.id} 模型标为存疑，不自动点（请看列表自行判断）`, true);
        answerList.push({ no: q.id, stem: cleanStem(q.stem), answer: '?', picked: [] });
        continue;
      }
      if (unsures[key]) {
        log(`  #${q.id} ${a} 但二次复核不一致，跳过不点`, true);
        answerList.push({
          no: q.id, stem: cleanStem(q.stem), answer: a,
          picked: q.options.filter((o) => a.includes(o.letter)).map((o) => `${o.letter}.${o.text}`)
        });
        continue;
      }
      if (cfg.autoClick === false) {
        answerList.push({
          no: q.id,
          stem: cleanStem(q.stem),
          answer: a,
          picked: q.options.filter((o) => a.includes(o.letter)).map((o) => `${o.letter}.${o.text}`)
        });
        log(`  #${q.id} → ${a}  ${cleanStem(q.stem).slice(0, 28)}`);
        n++;
        continue;
      }
      if (warns4[key]) log(`  #${q.id} 注意：${warns4[key]}`, true);
      log('  ' + (await answerOne(q, a)));
      n++;
      await sleep(80);
    }
    await sleep(120);
  }

  return n;
}

async function getCfg() {
  const r = await chrome.runtime.sendMessage({ type: 'GETCFG' });
  return (r && r.cfg) || {};
}

async function startAuto() {
  if (running) return;
  running = true;
  stopped = false;

  const p = buildPanel();
  if (p) showPanel(p);   // iframe 里 p 为 null，不再崩
  clearLog();
  log(`启动于 ${window.top === window ? '主页面' : 'iframe'} ${location.pathname.slice(-40)}`);

  const cfg = await getCfg();
  const delay = Math.max(200, Number(cfg.delayMs) || 800);
  const maxRounds = Math.max(1, Number(cfg.maxRounds) || 40);

  if (cfg.startTop) { scrollTop0(); await sleep(600); }

  let idle = 0;
  let total = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (stopped) break;

    const all = detectQuestions();
    const fresh = all.filter((q) => !doneKeys.has(qkey(q)));

    if (fresh.length) {
      idle = 0;
      log(`第${round}轮：新题 ${fresh.length} 道（共 ${all.length}）`);
      total += await askAndAnswer(fresh, cfg);
      await sleep(Math.max(300, delay));
    } else {
      idle++;
      if (idle === 1) log(`第${round}轮：本屏无新题，向下滚动`);
    }

    const info = scrollInfo();
    if (!info) { log('没有可滚动区域，结束'); break; }
    if (info.atBottom && !info.foreign) {
      log('已到页面底部');
      if (!fresh.length) break;
      continue;
    }
    if (!scrollDown(0.85)) { log('无法继续滚动，结束'); break; }
    await sleep(Math.max(500, delay));
    if (idle >= 3) {
      // 滚动送给父页面时，本 frame 的 idle 不影响判断；多给几轮
      if (info.foreign && idle < 8) continue;
      log('连续多轮无新题，结束');
      break;
    }
  }

  running = false;
  log(`结束：共处理 ${total} 道题`);

  if (!cfg.autoClick && answerList.length) {
    try {
      chrome.storage.local.set({ lastAnswers: answerList, lastAnswersAt: Date.now() });
    } catch (e) { /* 忽略 */ }
    const text = answerList
      .map((a) => `第${a.no}题 ${a.answer}  ${a.stem.slice(0, 40)}`)
      .join('\n');
    log('—— 答案清单 ——', false);
    log(text);
  }
}

/* ================= 消息 ================= */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'PING') {
    sendResponse({ ok: true, url: location.href, isTop: window.top === window, injected: true });
    return true;
  }

  if (msg.type === 'SCAN') {
    const qs = detectQuestions();
    sendResponse({
      ok: true,
      isTop: window.top === window,
      count: qs.length,
      questions: qs.map((q) => ({
        id: q.id,
        multi: q.multi,
        stem: q.stem,
        options: q.options.map((o) => ({ letter: o.letter, text: o.text }))
      }))
    });
    return true;
  }

  if (msg.type === 'DIAG') {
    sendResponse({ ok: true, diag: diagnose() });
    return true;
  }

  if (msg.type === 'RESET') {
    doneKeys.clear();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'START') {
    buildPanel();
    startAuto();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CMD') {
    // 来自顶层面板或后台的转发命令
    if (msg.cmd === 'start') { running = false; startAuto(); }
    if (msg.cmd === 'list') { listAnswers(); }
    if (msg.cmd === 'stop') { stopped = true; running = false; }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SHOW') {
    const p = buildPanel();
    if (p) showPanel(p);
    sendResponse({ ok: !!p });
    return true;
  }

  return true;
});

/* 页面内悬浮窗：默认自动出现，除非用户点 × 主动关掉 */
if (window.top === window) {
  const openPanel = () => {
    const p = buildPanel();
    if (p) showPanel(p);
    restoreLastAnswers();
  };
  try {
    chrome.storage.local.get(['panelClosed', 'autoPanel'], (r) => {
      if (r && r.autoPanel === false) return;
      if (r && r.panelClosed) { showFab(); return; }
      setTimeout(openPanel, 700);
    });
  } catch (e) {
    setTimeout(openPanel, 700);
  }
}

// 打开面板时把上次的内容显示出来（答案优先，其次导出题目）
async function restoreLastAnswers() {
  try {
    const r = await chrome.storage.local.get(['lastAnswers', 'lastDump', 'lastAnswersAt']);
    const la = r && r.lastAnswers;
    const dump = r && r.lastDump;

    // 谁更新就显示谁
    const dumpNewer = dump && la && dump.at > (la.at || 0);

    if (dump && (dumpNewer || !la || !la.detail || !la.detail.length)) {
      clearLog();
      log(`—— 抓到 ${dump.count} 题，全文如下 ——`);
      String(dump.text || '').split('\n').forEach((ln) => log(ln));
      setTip('已恢复上次导出的题目');
      return;
    }

    if (!la || !la.detail || !la.detail.length) return;
    clearLog();
    renderAnswers(la);
    setTip('已恢复上次结果');
  } catch (e) { /* 忽略 */ }
}

// 统一渲染：悬浮窗和弹窗用同一套输出格式
function renderAnswers(la) {
  (la.detail || []).forEach((d) => {
    const mark = d.ans === '?' ? '？存疑' : (d.unsure ? '⚠存疑' : '');
    log(`【第${d.no}题】答案：${d.ans}${mark ? '  ' + mark : ''}`, !!mark);
    if (d.stem) log(`  ${String(d.stem).slice(0, 70)}`);
    (d.picked || []).forEach((p) => log(`  → ${String(p).slice(0, 44)}`));
    if (d.pick) log(`  模型原话：${String(d.pick).slice(0, 50)}`);
    if (d.why) log(`  理由：${d.why}`);
    if (d.warn) log(`  注意：${d.warn}`, true);
  });
  if (la.compact) {
    log('');
    log('—— 速览 ——');
    log(la.compact);
  }
}

// 弹窗那边算出答案后，悬浮窗自动同步过来
if (window.top === window) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      // iframe 导出题目后，顶层负责显示 + 复制
      if (changes.lastDump && changes.lastDump.newValue) {
        const d = changes.lastDump.newValue;
        const p = buildPanel();
        if (p) showPanel(p);
        clearLog();
        log(`—— 抓到 ${d.count} 题，全文如下 ——`);
        String(d.text || '').split('\n').forEach((ln) => log(ln));
        navigator.clipboard.writeText(String(d.text || '')).then(() => {
          log('');
          log('✓ 已复制到剪贴板，直接粘给豆包');
          setTip('已复制，粘给豆包即可');
        }).catch(() => {
          setTip('复制失败，请手动选中上方文字');
        });
        return;
      }

      if (!changes.lastAnswers) return;
      const la = changes.lastAnswers.newValue;
      if (!la || !la.detail || !la.detail.length) return;
      const p = buildPanel();
      if (p) showPanel(p);
      clearLog();
      renderAnswers(la);
      setTip('已同步弹窗结果');
    });
  } catch (e) { /* 忽略 */ }
}

/* 顶层窗口：接收 iframe 的滚动请求 + 日志转发 */
if (window.top === window) {
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;

    if (d.__aqaLog) {
      const p = buildPanel();
      if (p && p.style.display !== 'flex') showPanel(p);
      const box = document.getElementById('aqa-log');
      if (box) {
        const line = document.createElement('div');
        line.textContent = d.text;
        if (d.warn) line.className = 'aqa-warn';
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
        while (box.childElementCount > 200) box.removeChild(box.firstChild);
      }
      return;
    }

    if (!d.__aqaScroll) return;
    const info = scrollInfo();
    if (!info || info.foreign) {
      const step = Math.round(window.innerHeight * (d.ratio || 0.85));
      window.scrollBy({ top: step, behavior: 'smooth' });
      return;
    }
    scrollDown(d.ratio);
  }, false);
}
/* 暴露给 executeScript 调用（同一隔离环境可访问） */
window.__aqa = {
  scan() {
    const qs = detectQuestions();
    return {
      isTop: window.top === window,
      href: location.href,
      count: qs.length,
      questions: qs.map((q) => ({
        id: q.id,
        multi: q.multi,
        stem: q.stem,
        options: q.options.map((o) => ({ letter: o.letter, text: o.text }))
      }))
    };
  },
  diag() {
    return diagnose();
  },
  start() {
    startAuto();
    return true;
  },
  list() {
    listAnswers();
    return true;
  },
  dump() {
    dumpQuestions();
    return true;
  },
  cmd(action) {
    if (action === 'start') { running = false; stopped = false; startAuto(); return true; }
    if (action === 'list') { listAnswers(); return true; }
    if (action === 'dump') { dumpQuestions(); return true; }
    if (action === 'stop') { stopped = true; running = false; return true; }
    return false;
  },
  hasQuestions() {
    try { return detectQuestions().length; } catch (e) { return 0; }
  },
  reset() {
    doneKeys.clear();
    return true;
  },
  ready: true
};

} /* initAll */
