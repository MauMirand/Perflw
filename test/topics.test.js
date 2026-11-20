const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const M = require('../src/topic-model');
const { parseFile } = require('../src/learning-import');
const { createWorkspace } = require('../src/workspace');

const t = (id, level = 0) => ({ id, kind: 'topic', level, title: id });
const ms = id => ({ id, kind: 'milestone', level: 0, title: id });
const order = rows => rows.map(r => r.id).join(' ');
const nums = rows => [...M.numbers(rows).entries()].map(([id, n]) => `${id}=${n}`).join(' ');

// ───────── model
test('numbers follow the order, run on across milestones and give subtopics 2.1, 2.2', async () => {
  const rows = [ms('Prelim'), t('a'), t('b'), t('b1', 1), t('b2', 1), ms('Midterm'), t('c'), t('c1', 1)];
  assert.equal(nums(rows), 'a=1 b=2 b1=2.1 b2=2.2 c=3 c1=3.1');
});

test('moving topic 1 to place 5 makes it 5 and the rest move up', async () => {
  const rows = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map(id => t(id));
  const moved = M.moveBefore(rows, 't1', 't6');
  assert.equal(order(moved), 't2 t3 t4 t5 t1 t6 t7');
  assert.equal(M.numbers(moved).get('t1'), '5');
  assert.equal(M.numbers(moved).get('t2'), '1');
});

test('a topic moves with its subtopics; orphaned subtopics become topics', async () => {
  const rows = [t('a'), t('a1', 1), t('a2', 1), t('b'), t('c')];
  assert.equal(order(M.moveBefore(rows, 'a', null)), 'b c a a1 a2');
  assert.deepEqual(M.blockOf(rows, 'a'), ['a', 'a1', 'a2']);
  const lone = M.moveBefore(rows, 'a1', 'a');
  assert.equal(order(lone), 'a1 a a2 b c');
  assert.equal(lone[0].level, 0, 'a subtopic dropped at the top becomes a topic');
  assert.equal(M.normalize([ms('Prelim'), t('x', 1)])[1].level, 0, 'no topic above it in its segment');
});

test('keyboard steps jump over whole blocks; levels toggle only when they make sense', async () => {
  const rows = [t('a'), t('a1', 1), t('b'), t('c')];
  assert.equal(order(M.step(rows, 'b', -1)), 'b a a1 c');
  assert.equal(order(M.step(rows, 'a', 1)), 'b a a1 c');
  assert.equal(order(M.step(rows, 'c', 1)), 'a a1 b c');
  assert.equal(M.setLevel(rows, 'b', 1).find(r => r.id === 'b').level, 1);
  assert.equal(M.setLevel(rows, 'a', 1), rows, 'a topic with subtopics stays a topic');
  const counts = M.segmentCounts([t('x'), ms('P'), t('y'), t('y1', 1), t('z')]);
  assert.equal(counts.get(null), 1); assert.equal(counts.get('P'), 2);
});

test('several selected topics move together in their order, each with its subtopics', () => {
  const rows = [t('a'), t('a1', 1), t('b'), t('c'), t('c1', 1), t('d')];
  assert.equal(order(M.moveManyBefore(rows, ['c', 'a'], null)), 'b d a a1 c c1');
  assert.equal(order(M.moveManyBefore(rows, ['d', 'b'], 'a')), 'b d a a1 c c1');
  assert.equal(order(M.moveManyBefore(rows, ['a', 'c'], 'a1')), 'a a1 c c1 b d', 'dropping on a moving row lands before the next row that stays');
  const subs = M.moveManyBefore(rows, ['a1', 'c1'], 'b');
  assert.equal(order(subs), 'a a1 c1 b c d'); assert.equal(subs.find(r => r.id === 'c1').level, 1, 'a subtopic under a topic stays one');
  assert.deepEqual(M.blocksOf(rows, ['c', 'a1', 'a']), ['a', 'a1', 'c', 'c1']);
});

// ───────── importer fixtures
function zip(files) { // stored + deflate entries, enough for the reader
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'); const packed = zlib.deflateRawSync(data); const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(8, 10);
    head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); central.push(head, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

test('Word files split by Heading 1 / Heading 2 (style names from styles.xml)', async () => {
  const doc = `<w:document><w:body>${para('Course notes', 'Title')}${para('Intro text')}${para('Limits &amp; continuity', 'H1x')}${para('One-sided limits', 'Heading2')}${para('Body')}${para('Derivatives', 'H1x')}</w:body></w:document>`;
  const styles = '<w:styles><w:style w:styleId="H1x"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>';
  const out = await parseFile(zip({ 'word/document.xml': doc, 'word/styles.xml': styles }), 'notes.docx');
  assert.deepEqual(out.outline, [
    { title: 'Limits & continuity', level: 0 }, { title: 'One-sided limits', level: 1 }, { title: 'Derivatives', level: 0 }]);
  assert.ok(out.text.includes('Intro text'));
});

test('Word headings are read exactly: built-in ids in any language, outline levels through basedOn, Heading 3 inside its subtopic', async () => {
  // A German Word file: style names are localized, the ids stay Heading1/Heading2/Heading3/Title.
  const styles = '<w:styles>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Titel"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Überschrift 1"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Überschrift 2"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Überschrift 3"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Kapitel"><w:name w:val="Kapitel"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="KapitelRot"><w:name w:val="Kapitel rot"/><w:basedOn w:val="Kapitel"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
  const own = text => `<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const doc = `<w:document><w:body>${para('Zellbiologie', 'Title')}${para('1. Die Membran', 'Heading1')}${para('Text eins.', 'Normal')}` +
    `${para('1.1 Proteine', 'Heading2')}${para('Kanäle', 'Heading3')}${para('Text zwei.')}${para('Transport', 'Heading2')}` +
    `${para('Der Kern', 'KapitelRot')}${own('Nukleolus')}${para('Mitochondrien', 'Kapitel')}</w:body></w:document>`;
  const out = await parseFile(zip({ 'word/document.xml': doc, 'word/styles.xml': styles }), 'zellen.docx');
  assert.deepEqual(out.outline.map(o => `${o.level}:${o.title}`), ['0:Die Membran', '1:Proteine', '1:Transport', '0:Der Kern', '1:Nukleolus', '0:Mitochondrien'],
    'Title is the document title; typed numbering is dropped; Heading 3 is not a topic');
  const intel = require('../src/learning-intel');
  const a = intel.analyze(await intel.extractBlocks(zip({ 'word/document.xml': doc, 'word/styles.xml': styles }), 'docx'), { fileName: 'zellen.docx', fileType: 'docx' });
  assert.equal(a.title, 'Zellbiologie');
  assert.deepEqual(a.sections.filter(s => s.number).map(s => `${s.number} ${s.title}`), ['1 Die Membran', '1.1 Proteine', '1.2 Transport', '2 Der Kern', '2.1 Nukleolus', '3 Mitochondrien']);
  assert.ok(a.chunks.some(c => c.number === '1.1' && /Kanäle:/.test(c.text)), 'the Heading 3 stays inside 1.1 as a sub-heading');
});

test('pictures in PowerPoint files are found where they sit; icons and repeated logos are skipped', async () => {
  const intel = require('../src/learning-intel'); const pictures = require('../src/learning-images');
  const { createCanvas } = require('@napi-rs/canvas');
  const png = (w, h, shade) => { const c = createCanvas(w, h); const g = c.getContext('2d'); g.fillStyle = shade; g.fillRect(0, 0, w, h); return c.toBuffer('image/png'); };
  const chart = png(800, 450, '#123456'); const icon = png(48, 48, '#ff0000'); const logo = png(300, 120, '#00ff00');
  const pic = id => `<p:pic><p:blipFill><a:blip r:embed="${id}"/></p:blipFill></p:pic>`;
  const deck = (title, ids) => `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>${ids.map(pic).join('')}</p:spTree></p:cSld></p:sld>`;
  const rel = list => `<Relationships>${list.map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`).join('')}</Relationships>`;
  const zipBin = list => { // stored (uncompressed) entries, binary safe
    const locals = []; const central = []; let offset = 0;
    for (const [name, data] of list) {
      const nameBuf = Buffer.from(name); const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBuf.length, 26);
      const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50, 0); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(body.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, body); central.push(head, nameBuf); offset += 30 + nameBuf.length + body.length;
    }
    const dir = Buffer.concat(central); const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
  };
  const pptx = zipBin([
    ['ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/><p:sldId id="258" r:id="r3"/></p:sldIdLst></p:presentation>'],
    ['ppt/_rels/presentation.xml.rels', rel([['r1', 'slides/slide1.xml'], ['r2', 'slides/slide2.xml'], ['r3', 'slides/slide3.xml']])],
    ['ppt/slides/slide1.xml', deck('Intro', ['i1', 'i2'])], ['ppt/slides/_rels/slide1.xml.rels', rel([['i1', '../media/logo.png'], ['i2', '../media/icon.png']])],
    ['ppt/slides/slide2.xml', deck('Chart', ['i1', 'i3'])], ['ppt/slides/_rels/slide2.xml.rels', rel([['i1', '../media/logo.png'], ['i3', '../media/chart.png']])],
    ['ppt/slides/slide3.xml', deck('End', ['i1'])], ['ppt/slides/_rels/slide3.xml.rels', rel([['i1', '../media/logo.png']])],
    ['ppt/media/chart.png', chart], ['ppt/media/icon.png', icon], ['ppt/media/logo.png', logo]
  ]);
  const extracted = await intel.extractBlocks(pptx, 'pptx');
  assert.deepEqual(extracted.images.map(i => `${i.page}:${i.target.split('/').pop()}@${i.at}`), ['1:logo.png@1', '1:icon.png@1', '2:logo.png@2', '2:chart.png@2', '3:logo.png@3']);
  const found = pictures.collect(pptx, 'pptx', extracted);
  assert.deepEqual(found.map(f => `${f.page}:${f.mime}`), ['2:image/png'], 'only the chart: the icon is too small, the logo is on every slide');
  assert.deepEqual(pictures.imageInfo(chart), { mime: 'image/png', width: 800, height: 450 });
});

test('topics and notes sections match for every sample file', async () => {
  const intel = require('../src/learning-intel');
  const dir = path.join(__dirname, 'fixtures', 'learning');
  for (const name of fs.readdirSync(dir)) {
    const bytes = fs.readFileSync(path.join(dir, name)); const type = name.split('.').pop();
    const topics = (await parseFile(bytes, name)).outline.map(o => `${o.level}:${o.title}`);
    const sections = intel.analyze(await intel.extractBlocks(bytes, type), { fileName: name, fileType: type }).sections.filter(s => s.number).map(s => `${s.level - 1}:${s.title}`);
    assert.ok(topics.length > 0, `${name} has topics`);
    assert.deepEqual(topics, sections, name);
  }
});

const slide = title => `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>bullet of ${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const rels = '<Relationships><Relationship Id="r2" Target="slides/slide2.xml"/><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r3" Target="slides/slide3.xml"/></Relationships>';
const slides = { 'ppt/slides/slide1.xml': slide('Cells'), 'ppt/slides/slide2.xml': slide('Membranes'), 'ppt/slides/slide3.xml': slide('Mitosis'), 'ppt/_rels/presentation.xml.rels': rels };

test('PowerPoint: slide titles in presentation order; sections become topics with slides as subtopics', async () => {
  const plain = `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/><p:sldId id="258" r:id="r3"/></p:sldIdLst></p:presentation>`;
  assert.deepEqual((await parseFile(zip({ ...slides, 'ppt/presentation.xml': plain }), 'bio.pptx')).outline.map(o => `${o.level}:${o.title}`), ['0:Cells', '0:Membranes', '0:Mitosis']);
  const sectioned = plain.replace('</p:presentation>', '<p14:sectionLst><p14:section name="Unit 1"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section><p14:section name="Unit 2"><p14:sldIdLst><p14:sldId id="258"/></p14:sldIdLst></p14:section></p14:sectionLst></p:presentation>');
  const out = await parseFile(zip({ ...slides, 'ppt/presentation.xml': sectioned }), 'bio.pptx');
  assert.deepEqual(out.outline.map(o => `${o.level}:${o.title}`), ['0:Unit 1', '1:Cells', '1:Membranes', '0:Unit 2', '1:Mitosis']);
  assert.ok(out.text.includes('bullet of Mitosis'));
});

function pdfWithOutline(compressed) {
  const items = {
    1: '<< /Type /Catalog /Outlines 2 0 R >>',
    2: '<< /Type /Outlines /First 3 0 R /Last 5 0 R >>',
    3: '<< /Title (Chapter 1 \\(Intro\\)) /Parent 2 0 R /First 4 0 R /Last 4 0 R /Next 5 0 R >>',
    4: '<< /Title <FEFF0053006500630063006900F3006E> /Parent 3 0 R >>',
    5: '<< /Title (Chapter 2) /Parent 2 0 R /First 6 0 R >>',
    6: '<< /Title (Deep) /Parent 5 0 R /First 7 0 R >>',
    7: '<< /Title (Too deep) /Parent 6 0 R >>'
  };
  if (!compressed) return Buffer.from(`%PDF-1.7\n${Object.entries(items).map(([n, body]) => `${n} 0 obj\n${body}\nendobj\n`).join('')}%%EOF`, 'latin1');
  const ids = Object.keys(items); let header = ''; let body = '';
  for (const id of ids) { header += `${id} ${body.length} `; body += `${items[id]}\n`; }
  const data = zlib.deflateSync(Buffer.from(header + body, 'latin1'));
  return Buffer.concat([Buffer.from(`%PDF-1.7\n9 0 obj\n<< /Type /ObjStm /N ${ids.length} /First ${header.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1')]);
}

test('PDF bookmarks give topics and subtopics, also from compressed object streams', async () => {
  for (const compressed of [false, true]) {
    const out = await parseFile(pdfWithOutline(compressed), 'book.pdf');
    assert.deepEqual(out.outline.map(o => `${o.level}:${o.title}`), ['0:Chapter 1 (Intro)', '1:Sección', '0:Chapter 2', '1:Deep'], compressed ? 'compressed' : 'plain');
  }
  const none = await parseFile(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'), 'scan.pdf');
  assert.deepEqual(none.outline, []); assert.match(none.note, /bookmarks|could not be read/);
});

test('Markdown headings, unknown and broken files', async () => {
  const md = await parseFile(Buffer.from('# One\ntext\n## One A\n```\n# not a heading\n```\n### deeper\n# Two'), 'n.md');
  assert.deepEqual(md.outline.map(o => `${o.level}:${o.title}`), ['0:One', '1:One A', '0:Two']);
  await assert.rejects(() => parseFile(Buffer.from('x'), 'virus.exe'), /PDF, Word/);
  const broken = await parseFile(Buffer.from('not a zip'), 'bad.docx');
  assert.deepEqual(broken.outline, []); assert.match(broken.note, /could not be read/);
});

// ───────── store
function store(test) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-topics-'));
  const w = createWorkspace(root);
  test.after(() => { w.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return w;
}

test('topics and milestones are added in order, renamed, reordered and deleted per subject and account', async tt => {
  const w = store(tt);
  const s = w.createSubject('u', 'study', { name: 'Math' });
  w.addTopic('u', s.id, { kind: 'milestone', title: 'Prelim' });
  const a = w.addTopic('u', s.id, { title: 'Limits' }).added[0];
  const b = w.addTopic('u', s.id, { title: 'One-sided', level: 1 }).added[0];
  const c = w.addTopic('u', s.id, { title: 'Derivatives' }).added[0];
  let list = w.listTopics('u', s.id);
  assert.deepEqual(list.rows.map(r => `${r.kind[0]}${r.level}:${r.title}`), ['m0:Prelim', 't0:Limits', 't1:One-sided', 't0:Derivatives']);
  list = w.renameTopic('u', c, '  Rates of change ');
  assert.equal(list.rows[3].title, 'Rates of change');
  list = w.saveTopicOrder('u', s.id, [list.rows[0], list.rows[3], list.rows[1], list.rows[2]].map(r => ({ id: r.id, level: r.level })));
  assert.deepEqual(list.rows.map(r => r.title), ['Prelim', 'Rates of change', 'Limits', 'One-sided']);
  assert.throws(() => w.saveTopicOrder('u', s.id, [{ id: a, level: 0 }]), /every topic/);
  assert.throws(() => w.listTopics('other', s.id), /Subject not found/);
  assert.throws(() => w.addTopic('u', s.id, { title: '   ' }), /Topic title/);
  list = w.deleteTopics('u', s.id, [a, b]);
  assert.deepEqual(list.rows.map(r => r.title), ['Prelim', 'Rates of change']);
});

test('an uploaded file adds its outline (or one topic), keeps its text, and is removed with its last topic or its subject', async tt => {
  const w = store(tt);
  const s = w.createSubject('u', 'study', { name: 'Bio' });
  w.addTopic('u', s.id, { title: 'Existing' });
  const res = w.importTopics('u', s.id, { name: 'cells.pdf', storedName: 'a'.repeat(32) + '.pdf', type: 'pdf', size: 10, text: 'cell text' },
    [{ title: 'Cells', level: 0 }, { title: 'Organelles', level: 1 }]);
  assert.equal(res.added.length, 2);
  assert.deepEqual(res.rows.map(r => r.title), ['Existing', 'Cells', 'Organelles']);
  assert.equal(res.files[0].topics, 2);
  assert.equal(w.topicFileText('u', res.fileId).text, 'cell text');
  const single = w.importTopics('u', s.id, { name: 'Week 3 slides.pptx', storedName: 'b'.repeat(32) + '.pptx', type: 'pptx', size: 5, text: '' }, []);
  assert.deepEqual(single.rows.slice(-1).map(r => r.title), ['Week 3 slides']);
  const del = w.deleteTopics('u', s.id, single.added);
  assert.deepEqual(del.removedFiles, ['b'.repeat(32) + '.pptx']);
  assert.deepEqual(w.deleteSubject('u', s.id), ['a'.repeat(32) + '.pdf']);
});

// ───────── viewer support: pages for topics, Office copies
function pdfWithPages() {
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /Names << /Dests 12 0 R >> >>',
    2: '<< /Type /Pages /Kids [3 0 R 13 0 R] /Count 3 >>',
    3: '<< /Type /Page /Parent 2 0 R >>',
    13: '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>',
    4: '<< /Type /Page /Parent 13 0 R >>',
    5: '<< /Type /Page /Parent 13 0 R >>',
    6: '<< /Type /Outlines /First 7 0 R >>',
    7: '<< /Title (Direct) /Dest [4 0 R /XYZ 0 0 0] /Next 8 0 R >>',
    8: '<< /Title (Action) /A 11 0 R /Next 9 0 R >>',
    9: '<< /Title (Named) /Dest (chap3) /Next 10 0 R >>',
    10: '<< /Title (Unknown) /Dest (missing) >>',
    11: '<< /S /GoTo /D [3 0 R /Fit] >>',
    12: '<< /Names [(chap3) [5 0 R /Fit]] >>'
  };
  return Buffer.from(`%PDF-1.7\n${Object.entries(objs).map(([n, b]) => `${n} 0 obj\n${b}\nendobj\n`).join('')}%%EOF`, 'latin1');
}

test('PDF bookmarks carry their page: direct, GoTo action, named destination; unknown has none', async () => {
  const out = await parseFile(pdfWithPages(), 'pages.pdf');
  assert.deepEqual(out.outline, [{ title: 'Direct', level: 0, page: 2 }, { title: 'Action', level: 0, page: 1 }, { title: 'Named', level: 0, page: 3 }, { title: 'Unknown', level: 0 }]);
});

test('PowerPoint topics carry their slide number (sections take their first slide)', async () => {
  const plain = `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/><p:sldId id="258" r:id="r3"/></p:sldIdLst></p:presentation>`;
  assert.deepEqual((await parseFile(zip({ ...slides, 'ppt/presentation.xml': plain }), 'bio.pptx')).outline.map(o => o.page), [1, 2, 3]);
  const sectioned = plain.replace('</p:presentation>', '<p14:sectionLst><p14:section name="Unit 1"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section><p14:section name="Unit 2"><p14:sldIdLst><p14:sldId id="258"/></p14:sldIdLst></p14:section></p14:sectionLst></p:presentation>');
  assert.deepEqual((await parseFile(zip({ ...slides, 'ppt/presentation.xml': sectioned }), 'bio.pptx')).outline.map(o => `${o.title}@${o.page}`), ['Unit 1@1', 'Cells@1', 'Membranes@2', 'Unit 2@3', 'Mitosis@3']);
});

test('topics keep their page; an Office copy is tracked, gives Word topics their pages and is deleted with the file', async tt => {
  const w = store(tt);
  const s = w.createSubject('u', 'study', { name: 'Rizal' });
  const pdf = w.importTopics('u', s.id, { name: 'book.pdf', storedName: 'c'.repeat(32) + '.pdf', type: 'pdf', size: 1, text: '' }, [{ title: 'One', level: 0, page: 4 }, { title: 'Two', level: 0 }]);
  assert.deepEqual(pdf.rows.map(r => r.page), [4, null]);
  const doc = w.importTopics('u', s.id, { name: 'ch.docx', storedName: 'd'.repeat(32) + '.docx', type: 'docx', size: 1, text: 'x' }, [{ title: 'Intro', level: 0 }, { title: 'Intro', level: 0 }, { title: 'Body', level: 1 }]);
  assert.equal(w.topicFile('u', doc.fileId).preview, 'none');
  w.setFilePreview('u', doc.fileId, 'ready', 'd'.repeat(32) + '.pdf');
  assert.equal(w.listTopics('u', s.id).files.find(f => f.id === doc.fileId).preview, 'ready');
  assert.throws(() => w.setFilePreview('u', doc.fileId, 'weird'), /Invalid preview/);
  // Word's bookmarks: repeated titles go to successive bookmarks, in order
  assert.equal(w.setTopicPagesFromOutline('u', doc.fileId, [{ title: 'intro', page: 1 }, { title: 'Intro', page: 3 }, { title: 'Body', page: 4 }]), 3);
  assert.deepEqual(w.listTopics('u', s.id).rows.filter(r => r.fileId === doc.fileId).map(r => r.page), [1, 3, 4]);
  assert.throws(() => w.topicFile('other', doc.fileId), /File not found/);
  const removed = w.deleteTopics('u', s.id, doc.added).removedFiles;
  assert.deepEqual(removed.sort(), ['d'.repeat(32) + '.docx', 'd'.repeat(32) + '.pdf']);
});
