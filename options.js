'use strict';

const FIELDS = ['baseUrl', 'apiKey', 'model', 'temperature', 'delayMs', 'maxRounds'];
const CHECKS = ['autoClick', 'scrollMode', 'startTop', 'showPanel'];

const $ = (id) => document.getElementById(id);
const msg = $('msg');

function show(text, isErr) {
  msg.textContent = text;
  msg.className = isErr ? 'err' : '';
  if (text) setTimeout(() => { if (msg.textContent === text) { msg.textContent = ''; } }, 4000);
}

const CHECK_DEFAULTS = { autoClick: true, scrollMode: true, startTop: true, showPanel: false };

async function load() {
  const cfg = await chrome.storage.local.get(null);
  FIELDS.forEach((k) => { if (cfg[k] !== undefined && $(k)) $(k).value = cfg[k]; });
  CHECKS.forEach((k) => {
    if (!$(k)) return;
    const v = cfg[k];
    $(k).checked = v === undefined ? !!CHECK_DEFAULTS[k] : !!v;
  });
}

async function save() {
  const data = {};
  FIELDS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    data[k] = k === 'temperature' || k === 'delayMs' || k === 'maxRounds' ? Number(el.value) : el.value.trim();
  });
  CHECKS.forEach((k) => { if ($(k)) data[k] = $(k).checked; });
  await chrome.storage.local.set(data);
  show('已保存');
}

$('save').addEventListener('click', save);

$('test').addEventListener('click', async () => {
  await save();
  show('测试中…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST' });
    if (r && r.error) return show('失败：' + r.error, true);
    show('成功 ✓ ' + JSON.stringify(r.answers));
  } catch (e) {
    show('失败：' + e.message, true);
  }
});

load();
