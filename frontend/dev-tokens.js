// dev-tokens.js —— 设计令牌检视 / 调参面板（A-09，开发者工具）
// 门控：只有以 --dev-tools 启动的实例才有 window.txapi.devTools；没有它本页只显示「未启用」。
'use strict';
(function () {
  const API = (window.txapi && window.txapi.devTools) ? window.txapi.devTools : null;
  const $ = (id) => document.getElementById(id);
  const locked = $('dtLocked'), main = $('dtMain');

  if (!API) { locked.hidden = false; return; }
  locked.hidden = true;
  main.hidden = false;

  const LAYERS = [
    { key: 'static', label: '原始层', test: (n) => n.indexOf('--vl-static-') === 0 },
    { key: 'alias', label: '语义别名层', test: (n) => n.indexOf('--vl-alias-') === 0 },
    { key: 'type', label: '排版层', test: (n) => n.indexOf('--vl-type-') === 0 || n.indexOf('--vl-font-') === 0 || n.indexOf('--vl-line-height-') === 0 },
    { key: 'comp', label: '组件层', test: (n) => n.indexOf('--vl-comp-') === 0 },
    { key: 'skin', label: '皮肤私有', test: (n) => n.indexOf('--vl-skin-') === 0 }
  ];
  const layerOf = (n) => { for (const l of LAYERS) if (l.test(n)) return l.key; return 'other'; };
  const layerLabel = (k) => { const l = LAYERS.find(x => x.key === k); return l ? l.label : '其它'; };

  const CSS_FILES = [
    '/frontend/styles/tokens.css', '/frontend/styles.css', '/frontend/settings.css', '/frontend/guide.css',
    '/frontend/skins/white_blue.css', '/frontend/skins/Black_Orange.css', '/frontend/skins/Maid_Atelier.css'
  ];

  const state = { tokens: [], filter: '', group: 'all', tried: new Map() };

  function layerOfValue(v) {
    if (v.indexOf('var(') >= 0) return 'alias';
    if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^(rgb|rgba|hsl|hsla)\(/.test(v)) return 'color';
    if (/^-?[0-9.]+(px|rem|em|vh|vw|ch)$/.test(v)) return 'length';
    if (/^-?[0-9.]+$/.test(v)) return 'number';
    if (/^(cubic-bezier|linear-gradient|radial-gradient)\(/.test(v)) return 'gradient';
    if (v.indexOf(',') >= 0) return 'font-family';
    return 'other';
  }

  async function scan() {
    const defs = new Map();
    const refs = new Map();
    for (const url of CSS_FILES) {
      let text = '';
      try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) continue; text = await r.text(); }
      catch (e) { continue; }
      text = text.replace(/\/\*[\s\S]*?\*\//g, '');
      const decls = text.replace(/[^{}]*\{/g, '{');
      for (const m of decls.matchAll(/(--vl-[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
        const name = m[1], value = m[2].trim();
        if (!defs.has(name)) defs.set(name, { name: name, def: value, file: url.replace('/frontend/', '') });
      }
      for (const m of text.matchAll(/var\(\s*(--vl-[A-Za-z0-9_-]+)/g)) {
        const name = m[1];
        refs.set(name, (refs.get(name) || 0) + 1);
      }
    }
    const cs = getComputedStyle(document.documentElement);
    const rows = [];
    for (const t of defs.values()) {
      rows.push({
        name: t.name, def: t.def, file: t.file,
        value: cs.getPropertyValue(t.name).trim(),
        type: layerOfValue(t.def),
        layer: layerOf(t.name),
        refs: refs.get(t.name) || 0
      });
    }
    rows.sort((a, b) => (a.layer === b.layer ? a.name.localeCompare(b.name) : a.layer.localeCompare(b.layer)));
    state.tokens = rows;
    renderGroups();
    render();
  }

  function renderGroups() {
    const box = $('dtGroups');
    const counts = {};
    for (const t of state.tokens) counts[t.layer] = (counts[t.layer] || 0) + 1;
    const items = [{ key: 'all', label: '全部', n: state.tokens.length }].concat(
      LAYERS.filter(l => counts[l.key]).map(l => ({ key: l.key, label: l.label, n: counts[l.key] }))
    );
    box.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'dt-chip' + (state.group === it.key ? ' is-on' : '');
      b.textContent = it.label + ' ' + it.n;
      b.addEventListener('click', () => { state.group = it.key; renderGroups(); render(); });
      box.appendChild(b);
    }
  }

  function visible() {
    const q = state.filter.trim().toLowerCase();
    return state.tokens.filter(t => {
      if (state.group !== 'all' && t.layer !== state.group) return false;
      if (!q) return true;
      return t.name.toLowerCase().indexOf(q) >= 0 || String(t.value).toLowerCase().indexOf(q) >= 0;
    });
  }

  function render() {
    const list = visible();
    const tbody = $('dtRows');
    tbody.innerHTML = '';
    for (const t of list) {
      const tr = document.createElement('tr');
      const tried = state.tried.has(t.name);
      const nameTd = document.createElement('td'); nameTd.className = 'dt-name'; nameTd.textContent = t.name; nameTd.title = t.file;
      const valTd = document.createElement('td'); valTd.className = 'dt-value' + (tried ? ' is-tried' : '');
      valTd.textContent = tried ? state.tried.get(t.name) : t.value; valTd.title = valTd.textContent;
      const tryTd = document.createElement('td'); tryTd.className = 'dt-try';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = tried ? state.tried.get(t.name) : '';
      inp.placeholder = '试值（回车生效）';
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = inp.value.trim();
        if (!v) { state.tried.delete(t.name); API.resetTokens(); }
        else { state.tried.set(t.name, v); API.applyToken(t.name, v); }
        render();
      });
      tryTd.appendChild(inp);
      const layerTd = document.createElement('td'); layerTd.className = 'dt-layer'; layerTd.textContent = layerLabel(t.layer) + ' · ' + t.type;
      const refTd = document.createElement('td'); refTd.className = 'dt-refs'; refTd.textContent = String(t.refs);
      tr.appendChild(nameTd); tr.appendChild(valTd); tr.appendChild(tryTd); tr.appendChild(layerTd); tr.appendChild(refTd);
      tbody.appendChild(tr);
    }
    $('dtCount').textContent = list.length + ' / ' + state.tokens.length + ' 个令牌';
  }

  $('dtSearch').addEventListener('input', (e) => { state.filter = e.target.value || ''; render(); });
  $('dtReset').addEventListener('click', () => { state.tried.clear(); API.resetTokens(); render(); });
  $('dtExport').addEventListener('click', () => {
    const out = {
      generatedAt: new Date().toISOString(),
      note: '会话内试值导出；未试值的令牌为当前解析值',
      tokens: state.tokens.map(t => ({
        name: t.name, value: state.tried.has(t.name) ? state.tried.get(t.name) : t.value,
        defaultValue: t.def, type: t.type, layer: layerLabel(t.layer), refs: t.refs, file: t.file
      }))
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'design-tokens.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // 其他窗口（含主窗口）的试值变化 → 本面板同步显示
  if (API.onTokenChange) {
    API.onTokenChange((p) => {
      if (!p) return;
      if (p.reset) state.tried.clear();
      else if (p.name) state.tried.set(p.name, p.value);
      render();
    });
  }

  // 跟随主窗口的当前皮肤：面板与主窗口同皮肤时，「当前值」才是同一套值、才能当参照。
  // 皮肤存于主进程（config.skin）—— 主窗口是 file://、面板走 HTTP，不同源，读不到 localStorage。
  try {
    if (window.txapi && window.txapi.get_skin) {
      Promise.resolve(window.txapi.get_skin()).then(function (s) {
        if (s) document.documentElement.setAttribute('data-skin', String(s));
      }).catch(function () {});
    }
  } catch (e) {}
  scan().catch(function (e) {
    locked.hidden = false;
    main.hidden = true;
    locked.innerHTML = "<h2>面板加载失败</h2><p>" + String((e && e.message) || e).replace(/[<>&]/g, " ") + "</p><p class=dt-locked__hint>请用 --dev-tools 启动的应用实例打开本页面。</p>";
  });
})();