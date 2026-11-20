const assert = require('node:assert/strict');
const { test } = require('node:test');
const R = require('../src/chat-render');

/* Every tag in rendered output must be one this renderer writes itself, and no attribute may carry script. */
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'ul', 'ol', 'li', 'span', 'div', 'button', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
function assertSafe(html) {
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    assert.ok(ALLOWED.has(match[1].toLowerCase()), `unexpected tag <${match[1]}>`);
    assert.doesNotMatch(match[2], /\son\w+\s*=|javascript:|style\s*=|srcdoc|src\s*=/i, `unsafe attribute in <${match[1]}${match[2]}>`);
  }
}

test('markdown renders the common structures', () => {
  const { html, blocks } = R.markdown([
    '# Title', '', 'A **bold** and *italic* word with `code` and ~~gone~~.', 'Second line.', '',
    '- one', '- two', '  - nested', '1. first', '2. second', '', '- [x] done', '- [ ] open', '',
    '> quoted **text**', '', '| Name | Qty |', '|:-----|----:|', '| Apple | 3 |', '| Pear | 12 |', '', '---', '',
    '```js', 'const x = 1; // note', 'return "s";', '```'
  ].join('\n'));
  assert.equal(blocks.length, 0);
  assert.match(html, /<h2 class="md-h">Title<\/h2>/);
  assert.match(html, /<p>A <strong>bold<\/strong> and <em>italic<\/em> word with <code class="md-code">code<\/code> and <del>gone<\/del>\.<br>Second line\.<\/p>/);
  assert.match(html, /<ul class="md-list"><li>one<\/li><li>two<ul class="md-list"><li>nested<\/li><\/ul><\/li><\/ul><ol class="md-list"><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<li class="md-task"><span class="md-check is-done" aria-hidden="true"><\/span>done<\/li><li class="md-task"><span class="md-check" aria-hidden="true"><\/span>open<\/li>/);
  assert.match(html, /<blockquote class="md-quote"><p>quoted <strong>text<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<table class="md-table"><thead><tr><th>Name<\/th><th class="ta-r">Qty<\/th><\/tr><\/thead><tbody><tr><td>Apple<\/td><td class="ta-r">3<\/td><\/tr>/);
  assert.match(html, /<hr class="md-hr">/);
  assert.match(html, /<span class="md-lang">js<\/span><button class="md-copy" type="button" data-copy-code>Copy<\/button>/);
  assert.match(html, /<span class="tk-k">const<\/span> x = <span class="tk-n">1<\/span>; <span class="tk-c">\/\/ note<\/span>\n<span class="tk-k">return<\/span> <span class="tk-s">&quot;s&quot;<\/span>;/);
  assertSafe(html);
});

test('model text can never become markup or script', () => {
  const hostile = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe srcdoc="<script>1</script>"></iframe>',
    '[click](javascript:alert(1))', '[x](https://ok.example/a"onmouseover="alert(1))', '**<b onclick=x>bold</b>**',
    '`<svg onload=alert(1)>`', '| <script>x</script> | b |\n|---|---|\n| <a href="javascript:x">y</a> | 2 |',
    '```html\n</code></pre><script>alert(1)</script>\n```', '```"><script>alert(1)</script>\ncode\n```',
    '# <style>*{display:none}</style>', '> <object data=x>', '- <embed src=x>', 'https://evil.example/"><script>alert(1)</script>',
    '<a href="https://x" style="position:fixed">t</a>', '&lt;script&gt; already escaped &amp;'
  ].join('\n\n');
  const { html } = R.markdown(hostile);
  assertSafe(html);
  assert.doesNotMatch(html, /<script|<img|<iframe|<svg|<object|<embed|<style|<b /i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // Only http(s) links become links, and their address is carried as escaped data, never as href.
  assert.doesNotMatch(html, /data-href="javascript/);
  for (const match of html.matchAll(/<a ([^>]*)>/g)) assert.match(match[1], /^class="md-link" href="#" data-href="https?:\/\/[^"<>]*" title="https?:\/\/[^"<>]*"$/);
});

test('special blocks become placeholders, stay pending while streaming, and can be switched off', () => {
  const text = 'Here:\n\n```chart\n{"type":"bar","x":["a"],"series":[{"data":[1]}]}\n```\n\n```visual\n<button>Hi</button>\n```\n\n```mermaid\nflowchart TD\nA-->B\n```\n\n```options\n{"options":["a","b"]}\n```';
  const done = R.markdown(text);
  assert.deepEqual(done.blocks.map(block => block.kind), ['chart', 'visual', 'mermaid', 'options']);
  assert.equal(done.blocks[1].source, '<button>Hi</button>');
  assert.match(done.html, /<div class="md-block md-visual" data-block="1"><\/div>/);
  assert.doesNotMatch(done.html, /<button>Hi/, 'visual HTML is never placed in the page itself');
  assertSafe(done.html);

  const streaming = R.markdown(text, { streaming: true });
  assert.equal(streaming.blocks.length, 0, 'nothing is drawn or run before the reply is complete');
  assert.match(streaming.html, /Preparing an interactive visual…/);
  const unfinished = R.markdown('Text\n\n```chart\n{"type":"bar"');
  assert.equal(unfinished.blocks.length, 0);

  const off = R.markdown(text, { visuals: false });
  assert.deepEqual(off.blocks.map(block => block.kind), ['options'], 'with visuals off, charts, diagrams and visuals are shown as code');
  assert.match(off.html, /&lt;button&gt;Hi&lt;\/button&gt;/);

  const long = R.markdown(`\`\`\`txt\n${Array.from({ length: 60 }, (_v, index) => `line ${index}`).join('\n')}\n\`\`\``);
  assert.match(long.html, /class="md-pre is-collapsed"[\s\S]*data-expand-code data-lines="60">Show all 60 lines/);
});

test('charts are validated and drawn as SVG from data only', () => {
  const spec = R.cleanChart({ type: 'bar', title: 'Sales <b>', x: ['Jan', 'Feb', '<script>'], series: [{ name: 'A', data: [1, '2', 3] }, { name: 'B', data: [3, null, -1] }] });
  assert.deepEqual(spec.series[0].data, [1, 2, 3]);
  const bar = R.chartSvg(spec);
  assert.equal((bar.svg.match(/<rect class="ch-mark"/g) || []).length, 5, 'a missing value draws no bar');
  assert.match(bar.svg, /data-tip="A · Jan: 1"/);
  assert.match(bar.svg, /class="ch-zero"/, 'negative values get a zero line');
  assert.doesNotMatch(bar.svg, /<script|<b>/);
  assert.match(bar.svg, /&lt;script&gt;/);
  assert.deepEqual(bar.legend.map(item => item.label), ['A', 'B']);

  for (const type of ['line', 'area']) assert.match(R.chartSvg(R.cleanChart({ type, x: [1, 2, 3], series: [{ data: [5, 9, 2] }] })).svg, /<path d="M /);
  const pie = R.chartSvg(R.cleanChart({ type: 'pie', x: ['a', 'b', 'c'], series: [{ data: [1, 1, 2] }] }));
  assert.equal((pie.svg.match(/<path class="ch-mark"/g) || []).length, 3);
  assert.match(pie.svg, /data-tip="c: 2 \(50\.0%\)"/);
  const scatter = R.chartSvg(R.cleanChart({ type: 'scatter', series: [{ name: 'P', data: [[1, 2], { x: 3, y: 4 }] }] }));
  assert.equal((scatter.svg.match(/<circle/g) || []).length, 2);

  assert.throws(() => R.cleanChart({ type: 'radar', series: [{ data: [1] }] }), /not supported/);
  assert.throws(() => R.cleanChart({ type: 'bar', series: [] }), /no series/);
  assert.throws(() => R.cleanChart({ type: 'bar', series: [{ data: ['x', 'y'] }] }), /must be numbers/);
  assert.throws(() => R.cleanChart({ type: 'pie', x: ['a'], series: [{ data: [-1] }] }), /negative/);
  assert.throws(() => R.cleanChart('nope'), /not a JSON object/);
  assert.equal(R.cleanChart({ type: 'line', series: Array.from({ length: 20 }, () => ({ data: [1] })) }).series.length, 8, 'series are capped');
});

test('flowcharts are parsed and laid out; anything else is rejected with a reason', () => {
  const graph = R.parseFlow('flowchart LR\n  A[Start] --> B{Is it ok?}\n  B -->|yes| C(Ship it)\n  B -- no --> D[[Fix]]\n  D -.-> B\n  C --> E((Done)); X & Y --> E\n  %% a comment\n  classDef x fill:#f00');
  assert.equal(graph.direction, 'LR');
  assert.deepEqual(graph.nodes.map(node => [node.id, node.label, node.shape]), [['A', 'Start', 'rect'], ['B', 'Is it ok?', 'diamond'], ['C', 'Ship it', 'round'], ['D', 'Fix', 'rect'], ['E', 'Done', 'circle'], ['X', 'X', 'rect'], ['Y', 'Y', 'rect']]);
  assert.deepEqual(graph.edges.map(edge => `${edge.from}>${edge.to}:${edge.label}${edge.dashed ? ':dashed' : ''}`), ['A>B:', 'B>C:yes', 'B>D:no', 'D>B::dashed', 'C>E:', 'X>E:', 'Y>E:']);
  const drawn = R.flowSvg(graph);
  assert.equal((drawn.svg.match(/class="fl-node"/g) || []).length, 7);
  assert.equal((drawn.svg.match(/class="fl-edge/g) || []).length, 7, 'a loop back to an earlier step is still drawn');
  assert.match(drawn.svg, /<polygon class="fl-node"/);
  assert.ok(drawn.width > drawn.height, 'LR diagrams grow sideways');
  const vertical = R.flowSvg(R.parseFlow('graph TD\nA --> B --> C'));
  assert.ok(vertical.height > vertical.width);
  const hostile = R.flowSvg(R.parseFlow('flowchart TD\nA["<script>alert(1)</script>"] --> B'));
  assert.doesNotMatch(hostile.svg, /<script/);

  assert.throws(() => R.parseFlow('sequenceDiagram\nA->>B: hi'), /Only flowcharts/);
  assert.throws(() => R.parseFlow('flowchart TD\n??? what'), /could not be read/);
  assert.throws(() => R.parseFlow('flowchart TD'), /no nodes/);
  assert.throws(() => R.cleanOptions({ options: ['only one'] }), /at least two/);
  assert.deepEqual(R.cleanOptions({ prompt: 'Pick', options: ['a', 'b', 3] }), { prompt: 'Pick', options: ['a', 'b'] });
});
