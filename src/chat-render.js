'use strict';
/* Rich rendering for chat replies: Markdown, highlighted code, tables, charts, flow diagrams, option buttons
   and sandboxed visuals. No dependencies.

   Safety model
     • Markdown → HTML is escape-first: every character of model text is HTML-escaped before any markup is
       added, and the only attributes written are class names and values this file builds itself.
     • Charts and diagrams are drawn by this file as SVG from validated JSON / a parsed flowchart; model text
       only ever appears as escaped text nodes.
     • ```visual blocks are the one place model-written HTML/JS runs, and it runs in an
       <iframe sandbox="allow-scripts"> served from perflw-sandbox:// with its own CSP: no network, opaque
       origin, no preload bridge. The page and the frame exchange only { render } and { size } messages.
   The page's own CSP forbids inline styles, so everything here uses classes and SVG attributes.

   Loaded by the renderer (window.PerflwRender) and by unit tests (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwRender = factory();
})(globalThis, function () {

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const SPECIAL = new Set(['chart', 'mermaid', 'visual', 'options']);
const COLLAPSE_LINES = 28;
const MAX_VISUAL = 200000;

// ───────────────────────── code highlighting (small, generic tokenizer)
const KEYWORDS = {
  js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield interface type enum implements public private protected readonly as',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self print',
  sh: 'if then else elif fi for in do done while until case esac function return export local echo cd exit set unset source alias sudo',
  sql: 'select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default',
  c: 'auto bool break case catch char class const continue default delete do double else enum extern false float for fn func go goto if impl import inline int interface let long match mut namespace new nil null package private protected pub public return short signed sizeof static struct switch template this throw true try type typedef union unsigned use using var virtual void volatile while defer chan map range select string'
};
const LANG = { js: 'js', javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', json: 'js', node: 'js', py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', powershell: 'sh', ps1: 'sh', yaml: 'sh', yml: 'sh', toml: 'sh', ini: 'sh', dockerfile: 'sh', sql: 'sql', c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', java: 'c', go: 'c', rust: 'c', rs: 'c', swift: 'c', kotlin: 'c', php: 'c', css: 'c', scss: 'c', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml' };
const KEYSETS = Object.fromEntries(Object.entries(KEYWORDS).map(([key, list]) => [key, new Set(list.split(' '))]));
function highlight(code, language) {
  const family = LANG[String(language || '').toLowerCase()];
  if (!family || code.length > 60000) return esc(code);
  if (family === 'xml') {
    return esc(code).replace(/(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?)([A-Za-z][\w:-]*)|(\s)([A-Za-z_:][\w:.-]*)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)?/g, (match, comment, open, tag, space, attr, eq, value) =>
      comment ? `<span class="tk-c">${comment}</span>` : tag ? `${open}<span class="tk-k">${tag}</span>` : `${space}<span class="tk-a">${attr}</span>${eq}${value ? `<span class="tk-s">${value}</span>` : ''}`);
  }
  const hash = family === 'py' || family === 'sh'; const dash = family === 'sql'; const slash = family === 'js' || family === 'c';
  const keys = KEYSETS[family]; const insensitive = family === 'sql';
  const pattern = new RegExp([
    slash ? '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*' : hash ? '#[^\\n]*' : dash ? '--[^\\n]*' : '(?!)',
    family === 'py' ? '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'' : '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`',
    '\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b',
    '[A-Za-z_$][\\w$]*'
  ].map(part => `(${part})`).join('|'), 'g');
  let out = ''; let last = 0; let match;
  while ((match = pattern.exec(code))) {
    out += esc(code.slice(last, match.index)); last = pattern.lastIndex;
    const [text, comment, string, number, word] = match;
    if (comment !== undefined) out += `<span class="tk-c">${esc(text)}</span>`;
    else if (string !== undefined) out += `<span class="tk-s">${esc(text)}</span>`;
    else if (number !== undefined) out += `<span class="tk-n">${esc(text)}</span>`;
    else if (word !== undefined && keys.has(insensitive ? text.toLowerCase() : text)) out += `<span class="tk-k">${esc(text)}</span>`;
    else out += esc(text);
    if (match[0] === '') pattern.lastIndex++;
  }
  return out + esc(code.slice(last));
}

// ───────────────────────── inline Markdown
function inline(text) {
  const kept = [];
  const keep = html => { kept.push(html); return `\u0000${kept.length - 1}\u0000`; };
  // Code spans first, so nothing inside them is treated as markup.
  let value = String(text).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, code) => keep(`<code class="md-code">${esc(code.trim())}</code>`));
  value = esc(value);
  // Links: [label](http…) and bare http(s) addresses. They never navigate the app; a click asks the main process.
  value = value.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_m, label, url) => keep(`<a class="md-link" href="#" data-href="${url}" title="${url}">${label}</a>`));
  value = value.replace(/(^|[\s(])(https?:\/\/[^\s<)]{1,2000}[^\s<).,;:!?])/g, (_m, lead, url) => `${lead}${keep(`<a class="md-link" href="#" data-href="${url}" title="${url}">${url}</a>`)}`);
  value = value.replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])__([^\s_](?:[^_]*[^\s_])?)__(?!\w)/g, '$1<strong>$2</strong>');
  value = value.replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>').replace(/(^|[^\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?!\w)/g, '$1<em>$2</em>');
  value = value.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return value.replace(/\u0000(\d+)\u0000/g, (_m, index) => kept[Number(index)]);
}

// ───────────────────────── block Markdown
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isDivider = line => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

/* Returns { html, blocks }. `blocks` are the special fenced blocks (chart, mermaid, visual, options): the HTML
   holds a placeholder for each and hydrate() draws them. While a reply is still streaming, special blocks
   stay placeholders so nothing half-written is parsed or run. */
function markdown(source, { streaming = false, visuals = true } = {}) {
  const blocks = [];
  const lines = String(source ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const render = (rows, depth) => {
    let html = ''; let index = 0;
    const paragraph = [];
    const flush = () => { if (paragraph.length) { html += `<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`; paragraph.length = 0; } };
    while (index < rows.length) {
      const line = rows[index];
      const fence = FENCE.exec(line);
      if (fence) {
        flush();
        const marker = fence[1]; const language = fence[2].toLowerCase(); const body = []; let closed = false; index++;
        while (index < rows.length) {
          if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(rows[index])) { closed = true; index++; break; }
          body.push(rows[index]); index++;
        }
        const code = body.join('\n');
        if (SPECIAL.has(language) && (visuals || language === 'options')) {
          if (!closed || streaming) { html += `<div class="md-pending">${language === 'visual' ? 'Preparing an interactive visual…' : language === 'options' ? 'Preparing choices…' : `Preparing a ${language === 'mermaid' ? 'diagram' : 'chart'}…`}</div>`; continue; }
          blocks.push({ kind: language, source: code });
          html += `<div class="md-block md-${language}" data-block="${blocks.length - 1}"></div>`;
          continue;
        }
        const count = body.length;
        html += `<div class="md-pre${count > COLLAPSE_LINES && !streaming ? ' is-collapsed' : ''}"><div class="md-pre-head"><span class="md-lang">${esc(language || 'text')}</span><button class="md-copy" type="button" data-copy-code>Copy</button></div><pre><code>${highlight(code, language)}</code></pre>${count > COLLAPSE_LINES && !streaming ? `<button class="md-expand" type="button" data-expand-code data-lines="${count}">Show all ${count} lines</button>` : ''}</div>`;
        continue;
      }
      if (!line.trim()) { flush(); index++; continue; }
      const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) { flush(); const level = Math.min(6, heading[1].length + 1); html += `<h${level} class="md-h">${inline(heading[2])}</h${level}>`; index++; continue; }
      if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += '<hr class="md-hr">'; index++; continue; }
      if (/^ {0,3}>/.test(line)) {
        flush(); const quoted = [];
        while (index < rows.length && /^ {0,3}>/.test(rows[index])) { quoted.push(rows[index].replace(/^ {0,3}>\s?/, '')); index++; }
        html += `<blockquote class="md-quote">${depth < 4 ? render(quoted, depth + 1) : esc(quoted.join('\n'))}</blockquote>`;
        continue;
      }
      if (line.includes('|') && index + 1 < rows.length && isDivider(rows[index + 1])) {
        const head = tableRow(line); const align = tableRow(rows[index + 1]).map(cell => (/^:-+:$/.test(cell) ? 'c' : /-+:$/.test(cell) ? 'r' : ''));
        if (head.length >= 1 && align.length === head.length) {
          flush(); index += 2; const body = [];
          while (index < rows.length && rows[index].includes('|') && rows[index].trim()) { body.push(tableRow(rows[index])); index++; }
          const cell = (tag, text, column) => `<${tag}${align[column] ? ` class="ta-${align[column]}"` : ''}>${inline(text ?? '')}</${tag}>`;
          html += `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((text, column) => cell('th', text, column)).join('')}</tr></thead><tbody>${body.map(row => `<tr>${head.map((_h, column) => cell('td', row[column], column)).join('')}</tr>`).join('')}</tbody></table></div>`;
          continue;
        }
      }
      const item = LIST.exec(line);
      if (item) {
        flush();
        const baseIndent = item[1].length; const ordered = /\d/.test(item[2]); const items = [];
        while (index < rows.length) {
          const next = LIST.exec(rows[index]);
          if (next && next[1].length <= baseIndent + 1 && /\d/.test(next[2]) === ordered) { items.push({ first: next[3], rest: [] }); index++; continue; }
          if (!items.length) break;
          if (!rows[index].trim()) { if (index + 1 < rows.length && (/^\s{2,}\S/.test(rows[index + 1]) || (LIST.exec(rows[index + 1]) && LIST.exec(rows[index + 1])[1].length >= baseIndent && /\d/.test(LIST.exec(rows[index + 1])[2]) === ordered))) { items.at(-1).rest.push(''); index++; continue; } break; }
          if (/^\s{2,}/.test(rows[index]) && rows[index].search(/\S/) > baseIndent) { items.at(-1).rest.push(rows[index].slice(Math.min(rows[index].search(/\S/), baseIndent + 2))); index++; continue; }
          if (next) break;
          if (FENCE.test(rows[index]) || /^ {0,3}(#{1,6}\s|>)/.test(rows[index])) break;
          items.at(-1).first += `\n${rows[index].trim()}`; index++; // lazy continuation line
        }
        const start = ordered ? Number(/\d+/.exec(item[2])[0]) : 1;
        html += `<${ordered ? `ol${start !== 1 ? ` start="${start}"` : ''}` : 'ul'} class="md-list">${items.map(entry => {
          const task = /^\[([ xX])\]\s+/.exec(entry.first);
          const first = task ? entry.first.slice(task[0].length) : entry.first;
          const nested = entry.rest.some(row => row.trim()) && depth < 5 ? render(entry.rest, depth + 1) : '';
          return `<li${task ? ' class="md-task"' : ''}>${task ? `<span class="md-check${task[1] === ' ' ? '' : ' is-done'}" aria-hidden="true"></span>` : ''}${inline(first).replace(/\n/g, '<br>')}${nested}</li>`;
        }).join('')}</${ordered ? 'ol' : 'ul'}>`;
        continue;
      }
      paragraph.push(line.trim()); index++;
    }
    flush();
    return html;
  };
  return { html: render(lines, 0), blocks };
}

// ───────────────────────── charts (SVG drawn here from validated data)
const PALETTE = ['#9B8AE0', '#62CDB5', '#E3B45F', '#F08A8A', '#6FA8DC', '#B7C96B', '#D48BC8', '#A9A6A3'];
const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'scatter'];
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
const fmt = value => { const abs = Math.abs(value); return abs >= 1e9 ? `${+(value / 1e9).toFixed(1)}B` : abs >= 1e6 ? `${+(value / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${+(value / 1e3).toFixed(1)}k` : String(+value.toFixed(abs < 10 ? 2 : abs < 100 ? 1 : 0)); };
const full = value => (Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 4 }));
function niceScale(min, max, count = 5) {
  if (min === max) { max = min + 1; if (min > 0) min = 0; }
  const span = max - min; const raw = span / count; const power = Math.pow(10, Math.floor(Math.log10(raw))); const unit = [1, 2, 2.5, 5, 10].find(step => step * power >= raw) * power;
  const lo = Math.floor(min / unit) * unit; const hi = Math.ceil(max / unit) * unit; const ticks = [];
  for (let value = lo; value <= hi + unit / 2; value += unit) ticks.push(+value.toFixed(10));
  return { lo, hi, ticks };
}
/* Validates a chart spec. Throws an Error with a plain reason when it cannot be drawn. */
function cleanChart(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The chart data is not a JSON object.');
  const type = String(raw.type || 'bar').toLowerCase();
  if (!CHART_TYPES.includes(type)) throw new Error(`Chart type “${String(raw.type).slice(0, 30)}” is not supported (use ${CHART_TYPES.join(', ')}).`);
  let list = Array.isArray(raw.series) ? raw.series : Array.isArray(raw.data) ? [{ name: raw.name || '', data: raw.data }] : null;
  if (!list || !list.length) throw new Error('The chart has no series.');
  if (list.length > 8) list = list.slice(0, 8);
  const series = list.map((item, index) => {
    const values = item && Array.isArray(item.data) ? item.data.slice(0, 500) : null;
    if (!values || !values.length) throw new Error('A chart series has no data.');
    const data = type === 'scatter'
      ? values.map(point => (Array.isArray(point) ? [num(point[0]), num(point[1])] : point && typeof point === 'object' ? [num(point.x), num(point.y)] : [null, null]))
      : values.map(num);
    if (type === 'scatter' ? data.some(point => point[0] === null || point[1] === null) : data.every(value => value === null)) throw new Error('The chart data must be numbers.');
    return { name: String(item.name || (list.length > 1 ? `Series ${index + 1}` : '')).slice(0, 60), data };
  });
  const length = Math.max(...series.map(item => item.data.length));
  const labels = Array.isArray(raw.x) ? raw.x : Array.isArray(raw.labels) ? raw.labels : null;
  const x = type === 'scatter' ? [] : Array.from({ length }, (_v, index) => String(labels && labels[index] !== undefined ? labels[index] : index + 1).slice(0, 40));
  if (type === 'pie' && series[0].data.some(value => value !== null && value < 0)) throw new Error('A pie chart cannot show negative values.');
  return { type, title: String(raw.title || '').slice(0, 120), xLabel: String(raw.xLabel || '').slice(0, 60), yLabel: String(raw.yLabel || '').slice(0, 60), x, series };
}
function chartSvg(spec) {
  const W = 640; const H = 300; const pad = { l: 48, r: 14, t: 12, b: spec.xLabel ? 46 : 32 };
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b; let body = '';
  const tip = (seriesName, label, value) => esc([seriesName, label].filter(Boolean).join(' · ') + (seriesName || label ? ': ' : '') + value);
  if (spec.type === 'pie') {
    const values = spec.series[0].data.map(value => Math.max(0, value || 0)); const total = values.reduce((sum, value) => sum + value, 0);
    if (!total) throw new Error('The pie chart has no values above zero.');
    const cx = W / 2; const cy = H / 2; const R = 118; const r = 62; let angle = -Math.PI / 2;
    values.forEach((value, index) => {
      if (!value) return;
      const sweep = (value / total) * Math.PI * 2; const end = angle + sweep; const large = sweep > Math.PI ? 1 : 0;
      const p = (radius, a) => `${(cx + radius * Math.cos(a)).toFixed(2)} ${(cy + radius * Math.sin(a)).toFixed(2)}`;
      const path = sweep >= Math.PI * 2 - 1e-6
        ? `M ${p(R, 0)} A ${R} ${R} 0 1 1 ${p(R, Math.PI)} A ${R} ${R} 0 1 1 ${p(R, 0)} M ${p(r, 0)} A ${r} ${r} 0 1 0 ${p(r, Math.PI)} A ${r} ${r} 0 1 0 ${p(r, 0)} Z`
        : `M ${p(R, angle)} A ${R} ${R} 0 ${large} 1 ${p(R, end)} L ${p(r, end)} A ${r} ${r} 0 ${large} 0 ${p(r, angle)} Z`;
      body += `<path class="ch-mark" data-series="${index}" fill="${PALETTE[index % PALETTE.length]}" fill-rule="evenodd" d="${path}" tabindex="0" data-tip="${tip('', spec.x[index], `${full(value)} (${(value / total * 100).toFixed(1)}%)`)}"/>`;
      angle = end;
    });
    body += `<text class="ch-total" x="${cx}" y="${cy + 5}" text-anchor="middle">${esc(fmt(total))}</text>`;
    return { svg: `<svg class="ch-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || 'Pie chart')}">${body}</svg>`, legend: spec.x.map((label, index) => ({ label, color: PALETTE[index % PALETTE.length], index })).filter((_item, index) => values[index] > 0) };
  }
  const flat = spec.type === 'scatter' ? spec.series.flatMap(item => item.data.map(point => point[1])) : spec.series.flatMap(item => item.data.filter(value => value !== null));
  const yScale = niceScale(Math.min(0, ...flat), Math.max(...flat, 0));
  const y = value => pad.t + ih - ((value - yScale.lo) / (yScale.hi - yScale.lo)) * ih;
  for (const tick of yScale.ticks) body += `<line class="ch-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"/><text class="ch-axis" x="${pad.l - 7}" y="${(y(tick) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt(tick))}</text>`;
  if (spec.type === 'scatter') {
    const xs = spec.series.flatMap(item => item.data.map(point => point[0])); const xScale = niceScale(Math.min(...xs), Math.max(...xs));
    const x = value => pad.l + ((value - xScale.lo) / (xScale.hi - xScale.lo)) * iw;
    for (const tick of xScale.ticks) body += `<text class="ch-axis" x="${x(tick).toFixed(1)}" y="${H - pad.b + 16}" text-anchor="middle">${esc(fmt(tick))}</text>`;
    spec.series.forEach((item, s) => { body += `<g data-series="${s}">${item.data.map(point => `<circle class="ch-mark" cx="${x(point[0]).toFixed(1)}" cy="${y(point[1]).toFixed(1)}" r="4" fill="${PALETTE[s % PALETTE.length]}" tabindex="0" data-tip="${tip(item.name, '', `${full(point[0])}, ${full(point[1])}`)}"/>`).join('')}</g>`; });
  } else {
    const n = spec.x.length; const band = iw / n; const every = Math.ceil(n / 12);
    spec.x.forEach((label, index) => { if (index % every === 0) body += `<text class="ch-axis" x="${(pad.l + band * (index + 0.5)).toFixed(1)}" y="${H - pad.b + 16}" text-anchor="middle">${esc(label.length > 12 ? `${label.slice(0, 11)}…` : label)}</text>`; });
    spec.series.forEach((item, s) => {
      const color = PALETTE[s % PALETTE.length]; let group = '';
      if (spec.type === 'bar') {
        const width = Math.max(2, Math.min(46, (band * 0.72) / spec.series.length));
        item.data.forEach((value, index) => {
          if (value === null) return;
          const left = pad.l + band * (index + 0.5) - (width * spec.series.length) / 2 + width * s; const top = Math.min(y(value), y(0)); const height = Math.max(1, Math.abs(y(value) - y(0)));
          group += `<rect class="ch-mark" x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${(width - 1.5).toFixed(1)}" height="${height.toFixed(1)}" rx="2" fill="${color}" tabindex="0" data-tip="${tip(item.name, spec.x[index], full(value))}"/>`;
        });
      } else {
        const points = item.data.map((value, index) => (value === null ? null : [pad.l + band * (index + 0.5), y(value), value, index])).filter(Boolean);
        if (points.length) {
          const line = points.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
          if (spec.type === 'area') group += `<path d="${line} L ${points.at(-1)[0].toFixed(1)} ${y(0).toFixed(1)} L ${points[0][0].toFixed(1)} ${y(0).toFixed(1)} Z" fill="${color}" fill-opacity="0.16"/>`;
          group += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
          group += points.map(point => `<circle class="ch-mark" cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="${points.length > 40 ? 2 : 3.5}" fill="${color}" tabindex="0" data-tip="${tip(item.name, spec.x[point[3]], full(point[2]))}"/>`).join('');
        }
      }
      body += `<g data-series="${s}">${group}</g>`;
    });
  }
  if (yScale.lo < 0) body += `<line class="ch-zero" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`;
  if (spec.xLabel) body += `<text class="ch-label" x="${pad.l + iw / 2}" y="${H - 6}" text-anchor="middle">${esc(spec.xLabel)}</text>`;
  if (spec.yLabel) body += `<text class="ch-label" x="12" y="${pad.t + ih / 2}" text-anchor="middle" transform="rotate(-90 12 ${pad.t + ih / 2})">${esc(spec.yLabel)}</text>`;
  return { svg: `<svg class="ch-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || `${spec.type} chart`)}">${body}</svg>`, legend: spec.series.length > 1 || spec.series[0].name ? spec.series.map((item, index) => ({ label: item.name, color: PALETTE[index % PALETTE.length], index })) : [] };
}

// ───────────────────────── flow diagrams (a Mermaid flowchart subset, laid out and drawn here)
const SHAPES = [
  [/^\(\(([\s\S]+?)\)\)/, 'circle'], [/^\(\[([\s\S]+?)\]\)/, 'pill'], [/^\[\[([\s\S]+?)\]\]/, 'rect'], [/^\[\(([\s\S]+?)\)\]/, 'pill'], [/^\{\{([\s\S]+?)\}\}/, 'diamond'],
  [/^\[([\s\S]+?)\]/, 'rect'], [/^\(([\s\S]+?)\)/, 'round'], [/^\{([\s\S]+?)\}/, 'diamond'], [/^>([\s\S]+?)\]/, 'rect']
];
const EDGE = /^\s*(?:--\s*([^->|][^>|]*?)\s*--+>|-\.\s*([^.>|]+?)\s*\.-+>|==\s*([^=>|]+?)\s*==+>|(<?-{2,}>|-{3,}|-\.+->|={2,}>|--[ox]|<-->))\s*(?:\|([^|]*)\|)?/;
const cleanLabel = text => String(text).trim().replace(/^"([\s\S]*)"$/, '$1').replace(/<br\s*\/?>/gi, ' ').replace(/&quot;|#quot;/g, '"').replace(/\s+/g, ' ').slice(0, 120);
/* Parses "flowchart TD / LR" text into { direction, nodes: [{ id, label, shape }], edges: [{ from, to, label, dashed, arrow }] }. Throws when it is not a flowchart it understands. */
function parseFlow(source) {
  const rows = String(source || '').split(/\n|;/).map(row => row.replace(/%%.*$/, '').trim()).filter(Boolean);
  const header = rows.length ? /^(?:flowchart|graph)\s*(TD|TB|BT|LR|RL)?\b/i.exec(rows[0]) : null;
  if (!header) throw new Error('Only flowcharts are supported (the block must start with “flowchart TD” or “flowchart LR”).');
  const direction = /^(LR|RL)$/i.test(header[1] || '') ? 'LR' : 'TD';
  const nodes = new Map(); const edges = [];
  const node = (id, label, shape) => { const current = nodes.get(id); if (!current) nodes.set(id, { id, label: label || id, shape: shape || 'rect' }); else if (label) { current.label = label; current.shape = shape; } };
  for (const row of rows.slice(1)) {
    if (/^(classDef|class|style|linkStyle|click|direction|end\b|subgraph\b)/i.test(row)) continue;
    let rest = row; let previous = null; let pendingEdge = null; let guard = 0;
    while (rest.trim() && guard++ < 40) {
      const group = [];
      for (;;) {
        const id = /^\s*([A-Za-z0-9_][\w.-]*)/.exec(rest);
        if (!id) throw new Error(`This diagram line could not be read: “${row.slice(0, 60)}”.`);
        rest = rest.slice(id[0].length); let label = ''; let shape = '';
        for (const [pattern, name] of SHAPES) { const found = pattern.exec(rest); if (found) { label = cleanLabel(found[1]); shape = name; rest = rest.slice(found[0].length); break; } }
        node(id[1], label, shape); group.push(id[1]);
        const more = /^\s*&\s*/.exec(rest); if (!more) break; rest = rest.slice(more[0].length);
      }
      if (previous && pendingEdge) for (const from of previous) for (const to of group) edges.push({ from, to, ...pendingEdge });
      previous = group; pendingEdge = null;
      if (!rest.trim()) break;
      const edge = EDGE.exec(rest);
      if (!edge) throw new Error(`This diagram line could not be read: “${row.slice(0, 60)}”.`);
      const operator = edge[4] || ''; const text = edge[1] || edge[2] || edge[3] || edge[5] || '';
      pendingEdge = { label: cleanLabel(text), dashed: edge[2] !== undefined || /\./.test(operator), arrow: !/^-{3,}$/.test(operator) };
      rest = rest.slice(edge[0].length);
    }
  }
  if (!nodes.size) throw new Error('The diagram has no nodes.');
  if (nodes.size > 60) throw new Error('The diagram has more than 60 nodes, which is too many to draw here.');
  return { direction, nodes: [...nodes.values()], edges: edges.slice(0, 200) };
}
function wrapLabel(text, width = 24) {
  const out = []; let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > width && line) { out.push(line); line = word; } else line = (line + ' ' + word).trim();
    if (out.length === 3) break;
  }
  if (line && out.length < 3) out.push(line);
  if (out.join(' ').length < text.length) out[out.length - 1] = `${out[out.length - 1].slice(0, width - 1)}…`;
  return out.map(row => (row.length > width + 4 ? `${row.slice(0, width + 3)}…` : row));
}
function flowSvg(graph) {
  // Layers by longest path from the sources; edges that point backwards (loops) do not affect the ranking.
  const outgoing = new Map(graph.nodes.map(item => [item.id, []])); const state = new Map(); const back = new Set();
  graph.edges.forEach((edge, index) => { if (edge.from !== edge.to) outgoing.get(edge.from).push({ to: edge.to, index }); });
  const visit = id => { state.set(id, 1); for (const edge of outgoing.get(id)) { if (state.get(edge.to) === 1) back.add(edge.index); else if (!state.has(edge.to)) visit(edge.to); } state.set(id, 2); };
  for (const item of graph.nodes) if (!state.has(item.id)) visit(item.id);
  const rank = new Map(graph.nodes.map(item => [item.id, 0]));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    graph.edges.forEach((edge, index) => { if (back.has(index) || edge.from === edge.to) return; if (rank.get(edge.to) < rank.get(edge.from) + 1) { rank.set(edge.to, rank.get(edge.from) + 1); changed = true; } });
    if (!changed) break;
  }
  const layers = []; for (const item of graph.nodes) (layers[rank.get(item.id)] = layers[rank.get(item.id)] || []).push(item);
  const horizontal = graph.direction === 'LR';
  const boxes = new Map(graph.nodes.map(item => { const lines = wrapLabel(item.label); const width = Math.max(64, Math.min(210, Math.max(...lines.map(row => row.length)) * 7 + 30)); const height = 22 + lines.length * 16 + (item.shape === 'diamond' ? 18 : 0); return [item.id, { ...item, lines, w: item.shape === 'diamond' ? width + 26 : item.shape === 'circle' ? Math.max(width, height + 14) : width, h: item.shape === 'circle' ? Math.max(width, height + 14) * 0.62 + 16 : height }]; }));
  const gapMain = horizontal ? 64 : 46; const gapCross = horizontal ? 22 : 30; const margin = 16;
  // Order each layer by the average position of its parents, then place it.
  const position = new Map(); let main = margin; let crossMax = 0;
  layers.forEach((layer, depth) => {
    if (depth) layer.sort((a, b) => { const mean = id => { const parents = graph.edges.filter(edge => edge.to === id && position.has(edge.from)).map(edge => position.get(edge.from).cross); return parents.length ? parents.reduce((sum, value) => sum + value, 0) / parents.length : Infinity; }; return mean(a.id) - mean(b.id); });
    const thickness = Math.max(...layer.map(item => (horizontal ? boxes.get(item.id).w : boxes.get(item.id).h)));
    let cross = 0;
    for (const item of layer) { const box = boxes.get(item.id); const size = horizontal ? box.h : box.w; position.set(item.id, { main: main + thickness / 2, cross: cross + size / 2, layerSize: 0 }); cross += size + gapCross; }
    const total = cross - gapCross; for (const item of layer) position.get(item.id).layerSize = total;
    crossMax = Math.max(crossMax, total); main += thickness + gapMain;
  });
  const center = id => { const p = position.get(id); const cross = margin + (crossMax - p.layerSize) / 2 + p.cross; return horizontal ? { x: p.main, y: cross } : { x: cross, y: p.main }; };
  const W = Math.ceil(horizontal ? main - gapMain + margin : crossMax + margin * 2); const H = Math.ceil(horizontal ? crossMax + margin * 2 : main - gapMain + margin);
  let edgesSvg = ''; let labelsSvg = '';
  graph.edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    const a = center(edge.from); const b = center(edge.to); const boxA = boxes.get(edge.from); const boxB = boxes.get(edge.to);
    const forward = horizontal ? b.x >= a.x : b.y >= a.y; const sign = forward ? 1 : -1;
    const start = horizontal ? { x: a.x + sign * boxA.w / 2, y: a.y } : { x: a.x, y: a.y + sign * boxA.h / 2 };
    const end = horizontal ? { x: b.x - sign * (boxB.w / 2 + 3), y: b.y } : { x: b.x, y: b.y - sign * (boxB.h / 2 + 3) };
    const bend = back.has(index) ? 46 : 0; // loops swing out to the side so they stay visible
    const c1 = horizontal ? { x: (start.x + end.x) / 2, y: start.y + bend } : { x: start.x + bend, y: (start.y + end.y) / 2 };
    const c2 = horizontal ? { x: (start.x + end.x) / 2, y: end.y + bend } : { x: end.x + bend, y: (start.y + end.y) / 2 };
    edgesSvg += `<path class="fl-edge${edge.dashed ? ' is-dashed' : ''}" d="M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${end.x.toFixed(1)} ${end.y.toFixed(1)}"${edge.arrow ? ' marker-end="url(#fl-arrow)"' : ''}/>`;
    if (edge.label) { const mx = (start.x + end.x) / 2 + (horizontal ? 0 : bend * 0.75); const my = (start.y + end.y) / 2 + (horizontal ? bend * 0.75 : 0); const text = edge.label.length > 28 ? `${edge.label.slice(0, 27)}…` : edge.label; const width = text.length * 6.2 + 12; labelsSvg += `<rect class="fl-tag" x="${(mx - width / 2).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${width.toFixed(1)}" height="18" rx="5"/><text class="fl-tag-text" x="${mx.toFixed(1)}" y="${(my + 3.5).toFixed(1)}" text-anchor="middle">${esc(text)}</text>`; }
  });
  let nodesSvg = '';
  for (const item of graph.nodes) {
    const box = boxes.get(item.id); const c = center(item.id); const x = c.x - box.w / 2; const y = c.y - box.h / 2;
    const shape = box.shape === 'diamond' ? `<polygon class="fl-node" points="${c.x},${y} ${x + box.w},${c.y} ${c.x},${y + box.h} ${x},${c.y}"/>`
      : box.shape === 'circle' ? `<ellipse class="fl-node" cx="${c.x}" cy="${c.y}" rx="${box.w / 2}" ry="${box.h / 2}"/>`
      : `<rect class="fl-node" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${box.w}" height="${box.h}" rx="${box.shape === 'pill' ? box.h / 2 : box.shape === 'round' ? 14 : 7}"/>`;
    const top = c.y - (box.lines.length - 1) * 8 + 4;
    nodesSvg += `${shape}<text class="fl-text" text-anchor="middle">${box.lines.map((row, index) => `<tspan x="${c.x.toFixed(1)}" y="${(top + index * 16).toFixed(1)}">${esc(row)}</tspan>`).join('')}</text>`;
  }
  return { width: W, height: H, svg: `<svg class="fl-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Flow diagram with ${graph.nodes.length} steps"><defs><marker id="fl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="fl-head" d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${edgesSvg}${nodesSvg}${labelsSvg}</svg>` };
}

/* Validates an ```options block: { prompt, options: [strings] }. */
function cleanOptions(raw) {
  const list = raw && Array.isArray(raw.options) ? raw.options.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 200)).slice(0, 8) : [];
  if (list.length < 2) throw new Error('A choice block needs at least two options.');
  return { prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 300) : '', options: list };
}

// ───────────────────────── hydration (browser only)
const frames = new Map(); // contentWindow → { frame, html, ready }
let listening = false;
const VISUAL_BASE = '<style>html{color-scheme:dark}body{margin:0;padding:14px;font:13.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#ECEAE8;background:#1C1B1B}*{box-sizing:border-box}button,input,select,textarea{font:inherit;color:inherit;background:#2B2C2D;border:1px solid #3A3B3C;border-radius:7px;padding:6px 10px}button{cursor:pointer}button:hover{background:#343536}table{border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid #3A3B3C;text-align:left}a{color:#B8A9F0}h1,h2,h3{margin:0 0 8px}</style>';
const VISUAL_TAIL = '<script>(function(){var last=0;function report(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;parent.postMessage({type:"size",height:h},"*");}}try{new ResizeObserver(report).observe(document.documentElement);}catch(e){}addEventListener("load",report);setTimeout(report,60);setTimeout(report,400);})();</script>';
function listen() {
  if (listening) return; listening = true;
  window.addEventListener('message', event => {
    const entry = frames.get(event.source);
    if (!entry || !event.data || typeof event.data !== 'object') return; // only frames this file created are heard
    if (event.data.type === 'ready' && !entry.ready) { entry.ready = true; entry.frame.contentWindow.postMessage({ type: 'render', html: entry.html }, '*'); entry.wrap.classList.remove('is-loading'); }
    else if (event.data.type === 'size' && Number.isFinite(event.data.height)) entry.frame.style.height = `${Math.max(48, Math.min(640, Math.round(event.data.height)))}px`;
  });
}
function fallback(el, source, reason, language) {
  el.className = 'md-block md-failed';
  el.innerHTML = `<p class="md-fail-note">${esc(reason)}</p><div class="md-pre"><div class="md-pre-head"><span class="md-lang">${esc(language)}</span><button class="md-copy" type="button" data-copy-code>Copy</button></div><pre><code>${esc(source)}</code></pre></div>`;
}
function mountVisual(el, source) {
  if (source.length > MAX_VISUAL) { fallback(el, source.slice(0, 4000), 'This visual is too large to run here, so its code is shown instead.', 'html'); return; }
  listen();
  el.innerHTML = '<div class="vis-bar"><span class="vis-title">Interactive visual · runs isolated, without network or file access</span><button class="md-copy" type="button" data-visual-code aria-expanded="false">Show code</button><button class="md-copy" type="button" data-visual-reload>Restart</button></div><div class="vis-stage is-loading"></div><div class="md-pre vis-code" hidden><pre><code></code></pre></div>';
  el.querySelector('.vis-code code').innerHTML = highlight(source, 'html');
  const stage = el.querySelector('.vis-stage');
  const start = () => {
    for (const [key, entry] of frames) if (!entry.frame.isConnected) frames.delete(key);
    stage.textContent = ''; stage.classList.add('is-loading');
    const frame = document.createElement('iframe');
    frame.className = 'vis-frame'; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('title', 'Generated interactive visual'); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = 'perflw-sandbox://frame/';
    stage.append(frame);
    const entry = { frame, wrap: stage, ready: false, html: `<!doctype html><html><head><meta charset="utf-8">${VISUAL_BASE}</head><body>${source}${VISUAL_TAIL}</body></html>` };
    frames.set(frame.contentWindow, entry);
    setTimeout(() => { if (!entry.ready && frame.isConnected) { stage.classList.remove('is-loading'); stage.innerHTML = '<p class="md-fail-note">The isolated frame did not start, so this visual cannot be shown. Its code is available above.</p>'; } }, 5000);
  };
  el.querySelector('[data-visual-reload]').addEventListener('click', start);
  el.querySelector('[data-visual-code]').addEventListener('click', event => { const code = el.querySelector('.vis-code'); code.hidden = !code.hidden; event.currentTarget.textContent = code.hidden ? 'Show code' : 'Hide code'; event.currentTarget.setAttribute('aria-expanded', String(!code.hidden)); });
  start();
}
function mountChart(el, source) {
  let spec; let drawn;
  try { spec = cleanChart(JSON.parse(source)); drawn = chartSvg(spec); }
  catch (error) { fallback(el, source, `This chart could not be drawn: ${error instanceof SyntaxError ? 'its data is not valid JSON.' : error.message}`, 'chart'); return; }
  el.innerHTML = `${spec.title ? `<p class="ch-title">${esc(spec.title)}</p>` : ''}<div class="ch-stage">${drawn.svg}<div class="ch-tip" hidden></div></div>${drawn.legend.length ? `<div class="ch-legend">${drawn.legend.map(item => `<button class="ch-key" type="button" data-key="${item.index}" aria-pressed="true"><span class="ch-swatch"></span>${esc(item.label)}</button>`).join('')}</div>` : ''}`;
  el.querySelectorAll('.ch-key').forEach((button, index) => { button.querySelector('.ch-swatch').style.background = drawn.legend[index].color; });
  const tip = el.querySelector('.ch-tip'); const stage = el.querySelector('.ch-stage');
  const show = mark => { const box = mark.getBoundingClientRect(); const host = stage.getBoundingClientRect(); tip.textContent = mark.dataset.tip; tip.hidden = false; tip.style.left = `${Math.max(4, Math.min(host.width - tip.offsetWidth - 4, box.left - host.left + box.width / 2 - tip.offsetWidth / 2))}px`; tip.style.top = `${Math.max(0, box.top - host.top - tip.offsetHeight - 8)}px`; };
  stage.addEventListener('mouseover', event => { const mark = event.target.closest('.ch-mark'); if (mark) show(mark); });
  stage.addEventListener('mouseout', event => { if (event.target.closest('.ch-mark')) tip.hidden = true; });
  stage.addEventListener('focusin', event => { const mark = event.target.closest('.ch-mark'); if (mark) show(mark); });
  stage.addEventListener('focusout', () => { tip.hidden = true; });
  // Legend entries switch a series (or pie slice) off and on.
  el.querySelectorAll('.ch-key').forEach(button => button.addEventListener('click', () => {
    const on = button.getAttribute('aria-pressed') !== 'true'; button.setAttribute('aria-pressed', String(on));
    el.querySelectorAll(`[data-series="${button.dataset.key}"]`).forEach(mark => mark.classList.toggle('is-off', !on));
  }));
}
function mountFlow(el, source) {
  try { const drawn = flowSvg(parseFlow(source)); el.innerHTML = `<div class="fl-stage">${drawn.svg}</div>`; }
  catch (error) { fallback(el, source, `This diagram could not be drawn: ${error.message}`, 'mermaid'); }
}
function mountOptions(el, source, { onOption, interactive }) {
  let spec;
  try { spec = cleanOptions(JSON.parse(source)); } catch (error) { fallback(el, source, `These choices could not be shown: ${error instanceof SyntaxError ? 'the block is not valid JSON.' : error.message}`, 'options'); return; }
  el.innerHTML = `${spec.prompt ? `<p class="opt-prompt">${esc(spec.prompt)}</p>` : ''}<div class="opt-list">${spec.options.map(() => '<button class="opt-btn" type="button"></button>').join('')}</div>`;
  el.querySelectorAll('.opt-btn').forEach((button, index) => {
    button.textContent = spec.options[index];
    // Choices are live only on the latest reply; on older ones they are a record of what was offered.
    if (!interactive) { button.disabled = true; return; }
    button.addEventListener('click', () => onOption(spec.options[index]));
  });
}
/* Draws the special blocks of one rendered message. handlers: { onOption(text), interactive } */
function hydrate(root, blocks, handlers = {}) {
  root.querySelectorAll('[data-block]').forEach(el => {
    const block = blocks[Number(el.dataset.block)];
    if (!block || el.dataset.done) return;
    el.dataset.done = '1';
    if (block.kind === 'chart') mountChart(el, block.source);
    else if (block.kind === 'mermaid') mountFlow(el, block.source);
    else if (block.kind === 'visual') mountVisual(el, block.source);
    else if (block.kind === 'options') mountOptions(el, block.source, { onOption: handlers.onOption || (() => {}), interactive: Boolean(handlers.interactive) });
  });
}

return { markdown, inline, highlight, cleanChart, chartSvg, parseFlow, flowSvg, cleanOptions, hydrate, esc };
});
