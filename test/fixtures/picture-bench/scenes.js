'use strict';
/* Generated infographics with known text, for the picture benchmark (test/picture-bench.js).
   Each scene is drawn from the same data its answer key comes from, so the key is exact:
     title, headings (panel headings), labels ("Example", "Notes"), lines (every sentence, bullet and row),
     numbers (each must be read exactly), rows (table rows: cells in order), facts (what a student must keep:
     checked against the notes' key points), questions (a question and the words its answer must contain).
   The scenes cover what real slides do: numbered steps, a data table, Title Case headings, small dense text,
   low contrast, and a chart. */
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONTS = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
try { GlobalFonts.registerFromPath(path.join(FONTS, 'inter-latin-wght-normal.woff2'), 'BenchInter'); } catch { /* falls back to Arial */ }
const FACE = 'BenchInter, Arial, sans-serif';

function wrap(g, text, width) {
  const words = text.split(' '); const lines = []; let line = '';
  for (const w of words) { const next = line ? `${line} ${w}` : w; if (g.measureText(next).width > width && line) { lines.push(line); line = w; } else line = next; }
  if (line) lines.push(line);
  return lines;
}
function para(g, text, x, y, width, size, color, lh = 1.35) {
  g.font = `${size}px ${FACE}`; g.fillStyle = color;
  const lines = wrap(g, text, width);
  lines.forEach((l, i) => g.fillText(l, x, y + i * size * lh));
  return y + lines.length * size * lh;
}
function canvas(w, h, bg = '#ffffff') { const c = createCanvas(w, h); const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, w, h); g.textBaseline = 'top'; return { c, g }; }
function title(g, w, text, sub) {
  g.fillStyle = '#1f3b5c'; g.fillRect(w * 0.15, 20, w * 0.7, sub ? 96 : 70);
  g.font = `bold 40px ${FACE}`; g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.fillText(text, w / 2, 32);
  if (sub) { g.font = `20px ${FACE}`; g.fillText(sub, w / 2, 80); }
  g.textAlign = 'left';
}

// ── 1. numbered steps in coloured panels (capital headings, step numbers in circles)
function processSteps() {
  const steps = [
    ['SET GOALS', 'Decide what the organization wants to achieve in the next fiscal year.'],
    ['ESTIMATE REVENUE', 'Forecast income from sales, grants and other sources.'],
    ['PLAN EXPENSES', 'List fixed and variable costs for every department.'],
    ['APPROVE BUDGET', 'Management reviews the plan and approves the final amounts.'],
    ['MONITOR RESULTS', 'Compare actual spending with the budget every month.']
  ];
  const W = 1600, H = 820; const { c, g } = canvas(W, H, '#f4f6fa');
  title(g, W, 'THE BUDGETING PROCESS', 'Five steps from goals to results');
  const colors = ['#f8d7da', '#fde8c8', '#d8f0d2', '#d6e6fb', '#e6dcf7'];
  steps.forEach(([h, d], i) => {
    const x = 40 + i * 308; g.fillStyle = colors[i]; g.fillRect(x, 160, 288, 600);
    g.fillStyle = '#1f3b5c'; g.beginPath(); g.arc(x + 144, 210, 30, 0, Math.PI * 2); g.fill();
    g.font = `bold 30px ${FACE}`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(String(i + 1), x + 144, 194); g.textAlign = 'left';
    g.font = `bold 24px ${FACE}`; g.fillStyle = '#1f3b5c'; wrap(g, h, 250).forEach((l, k) => g.fillText(l, x + 20, 270 + k * 30));
    g.fillStyle = '#c9ced8'; g.fillRect(x + 60, 360, 168, 120); // decorative icon block
    para(g, d, x + 20, 520, 250, 20, '#2b2f36');
  });
  return { name: 'process-steps', c, truth: {
    title: 'The Budgeting Process', headings: steps.map(s => s[0]), labels: [],
    lines: ['Five steps from goals to results', ...steps.map(s => s[1])], numbers: [], rows: [],
    facts: steps.map(s => s[1]),
    questions: [{ q: 'What happens in the approve budget step?', answer: ['management', 'approves'] }, { q: 'How often are results monitored against the budget?', answer: ['every month'] }]
  } };
}

// ── 2. a data table with a notes box
function dataTable() {
  const header = ['Region', 'Q1', 'Q2', 'Q3', 'Total'];
  const rows = [['North', '120', '135', '150', '405'], ['South', '98', '110', '104', '312'], ['East', '143', '151', '160', '454'], ['West', '87', '92', '99', '278'], ['Total', '448', '488', '513', '1449']];
  const notes = ['East had the highest total sales.', 'West grew by 12 units from Q1 to Q3.'];
  const W = 1400, H = 900; const { c, g } = canvas(W, H);
  title(g, W, 'QUARTERLY SALES REPORT', 'Units sold per region');
  const x0 = 200, y0 = 170, cw = [260, 160, 160, 160, 200], rh = 60;
  const xs = cw.reduce((a, w, i) => (a.push((a[i - 1] || x0) + (i ? cw[i - 1] : 0)), a), []);
  g.fillStyle = '#1f3b5c'; g.fillRect(x0, y0, cw.reduce((a, b) => a + b), rh);
  g.font = `bold 24px ${FACE}`; g.fillStyle = '#fff'; header.forEach((h, i) => g.fillText(h, xs[i] + 20, y0 + 18));
  rows.forEach((r, k) => {
    g.fillStyle = k % 2 ? '#eef2f8' : '#ffffff'; g.fillRect(x0, y0 + rh * (k + 1), cw.reduce((a, b) => a + b), rh);
    g.font = `${k === rows.length - 1 ? 'bold ' : ''}24px ${FACE}`; g.fillStyle = '#222';
    r.forEach((cell, i) => g.fillText(cell, xs[i] + 20, y0 + rh * (k + 1) + 18));
  });
  g.fillStyle = '#fff4d6'; g.fillRect(x0, 600, 940, 200);
  g.font = `bold 24px ${FACE}`; g.fillStyle = '#8a5a00'; g.fillText('Notes:', x0 + 20, 620);
  notes.forEach((n, i) => { g.font = `22px ${FACE}`; g.fillStyle = '#333'; g.fillText(`• ${n}`, x0 + 30, 670 + i * 40); });
  return { name: 'data-table', c, truth: {
    title: 'Quarterly Sales Report', headings: [], labels: ['Notes'],
    lines: ['Units sold per region', ...notes], numbers: rows.flat().filter(v => /\d/.test(v)), rows: [header, ...rows],
    facts: notes,
    questions: [{ q: 'How many units did the East region sell in Q2?', answer: ['151'] }, { q: 'What were the total units sold in Q3?', answer: ['513'] }]
  } };
}

// ── 3. three columns with Title Case headings, definitions, Example labels and bullets
function comparison() {
  const cols = [
    ['Mitosis', 'Cell division that produces two identical daughter cells.', ['Growth of skin cells', 'Repair of damaged tissue']],
    ['Meiosis', 'Cell division that produces four gametes with half the chromosomes.', ['Formation of sperm cells', 'Formation of egg cells']],
    ['Binary Fission', 'A single cell splits into two cells without a nucleus dividing.', ['Bacteria reproducing', 'Archaea reproducing']]
  ];
  const W = 1500, H = 860; const { c, g } = canvas(W, H, '#fbfaf7');
  title(g, W, 'Types of Cell Division');
  cols.forEach(([h, d, ex], i) => {
    const x = 50 + i * 480; g.fillStyle = ['#e3f1e1', '#e1ecf7', '#f7e9e1'][i]; g.fillRect(x, 130, 440, 680);
    g.font = `bold 34px ${FACE}`; g.fillStyle = '#23412b'; g.fillText(h, x + 24, 150);
    const y = para(g, d, x + 24, 210, 390, 22, '#222');
    g.font = `bold 22px ${FACE}`; g.fillStyle = '#7a4b00'; g.fillText('Example:', x + 24, y + 30);
    ex.forEach((e, k) => { g.font = `21px ${FACE}`; g.fillStyle = '#333'; g.fillText(`• ${e}`, x + 34, y + 72 + k * 36); });
  });
  return { name: 'comparison', c, truth: {
    title: 'Types of Cell Division', headings: cols.map(x => x[0]), labels: ['Example'],
    lines: cols.flatMap(x => [x[1], ...x[2]]), numbers: [], rows: [],
    facts: cols.map(x => x[1]),
    questions: [{ q: 'What does meiosis produce?', answer: ['four gametes'] }, { q: 'Give an example of binary fission.', answer: ['bacteria'] }]
  } };
}

// ── 4. small dense text on a wide slide (shrunk to 1280 px before reading)
function denseSmall() {
  const panels = [
    ['PLANNING', ['Planning sets objectives and decides how to reach them.', 'Strategic plans cover three to five years.', 'Operational plans cover one year or less.']],
    ['ORGANIZING', ['Organizing arranges people, tasks and resources.', 'A span of control of 8 employees is typical for supervisors.', 'Departments group similar activities.']],
    ['LEADING', ['Leading motivates people to reach the objectives.', 'Transformational leaders inspire change.', 'Communication links leaders and teams.']],
    ['CONTROLLING', ['Controlling compares results with standards.', 'A variance above 5% needs corrective action.', 'Feedback closes the management cycle.']]
  ];
  const W = 1920, H = 1080; const { c, g } = canvas(W, H);
  title(g, W, 'FUNCTIONS OF MANAGEMENT');
  panels.forEach(([h, ls], i) => {
    const x = 40 + i * 470; g.fillStyle = '#f1f3f7'; g.fillRect(x, 140, 440, 900);
    g.font = `bold 20px ${FACE}`; g.fillStyle = '#1f3b5c'; g.fillText(h, x + 16, 160);
    let y = 200; for (const l of ls) y = para(g, l, x + 16, y, 400, 14, '#333') + 10;
  });
  return { name: 'dense-small', c, truth: {
    title: 'Functions of Management', headings: panels.map(p => p[0]), labels: [],
    lines: panels.flatMap(p => p[1]), numbers: ['8', '5%'], rows: [],
    facts: panels.map(p => p[1][0]),
    questions: [{ q: 'What variance needs corrective action?', answer: ['5%'] }, { q: 'How long do strategic plans cover?', answer: ['three to five years'] }]
  } };
}

// ── 5. low contrast: white on light orange, grey on white
function lowContrast() {
  const items = [
    ['DEMAND', 'Buyers want more of a good when its price falls.'],
    ['SUPPLY', 'Sellers offer more of a good when its price rises.'],
    ['EQUILIBRIUM', 'The market clears where demand meets supply.']
  ];
  const W = 1400, H = 760; const { c, g } = canvas(W, H);
  g.font = `bold 38px ${FACE}`; g.fillStyle = '#b8b8b8'; g.fillText('Market Basics', 60, 40);
  items.forEach(([h, d], i) => {
    const x = 60 + i * 440; g.fillStyle = '#f6b27a'; g.fillRect(x, 140, 400, 560);
    g.font = `bold 28px ${FACE}`; g.fillStyle = '#ffffff'; g.fillText(h, x + 24, 170);
    para(g, d, x + 24, 240, 350, 22, '#fff7ef');
  });
  return { name: 'low-contrast', c, truth: {
    title: 'Market Basics', headings: items.map(x => x[0]), labels: [],
    lines: items.map(x => x[1]), numbers: [], rows: [],
    facts: items.map(x => x[1]),
    questions: [{ q: 'Where does the market clear?', answer: ['demand meets supply'] }]
  } };
}

// ── 6. a bar chart with values
function barChart() {
  const bars = [['2021', 42], ['2022', 58], ['2023', 73], ['2024', 91]];
  const W = 1300, H = 820; const { c, g } = canvas(W, H);
  title(g, W, 'ONLINE ENROLLMENT GROWTH', 'Students enrolled (thousands)');
  const base = 700;
  bars.forEach(([label, v], i) => {
    const x = 200 + i * 240; const h = v * 5;
    g.fillStyle = '#3c7dd9'; g.fillRect(x, base - h, 140, h);
    g.font = `bold 26px ${FACE}`; g.fillStyle = '#222'; g.fillText(String(v), x + 48, base - h - 36);
    g.font = `24px ${FACE}`; g.fillText(label, x + 40, base + 16);
  });
  g.font = `20px ${FACE}`; g.fillStyle = '#555'; g.fillText('Enrollment more than doubled from 2021 to 2024.', 200, 770);
  return { name: 'bar-chart', c, truth: {
    title: 'Online Enrollment Growth', headings: [], labels: [],
    lines: ['Students enrolled (thousands)', 'Enrollment more than doubled from 2021 to 2024.'], numbers: ['42', '58', '73', '91', '2021', '2024'], rows: [],
    facts: ['Enrollment more than doubled from 2021 to 2024.'],
    questions: [{ q: 'How many students enrolled in 2023?', answer: ['73'] }]
  } };
}

// ── Held-out scenes: written after the structure rules were tuned, and never tuned on. Their scores show whether
//    the rules generalize beyond the scenes above.
function timeline() {
  const events = [['1760', 'Industrial Revolution begins in Britain'], ['1837', 'Electric telegraph patented'], ['1876', 'Telephone patented by Bell'], ['1903', 'First powered airplane flight']];
  const W = 1600, H = 700; const { c, g } = canvas(W, H, '#fffdf8');
  g.font = `bold 36px ${FACE}`; g.fillStyle = '#5a2d0c'; g.fillText('Milestones of the Industrial Age', 60, 40);
  g.fillStyle = '#5a2d0c'; g.fillRect(60, 330, W - 120, 6);
  events.forEach(([y, e], i) => {
    const x = 120 + i * 370; g.beginPath(); g.arc(x, 333, 16, 0, Math.PI * 2); g.fill();
    g.font = `bold 30px ${FACE}`; g.fillText(y, x - 36, 260);
    para(g, e, x - 60, 380, 300, 22, '#333');
  });
  return { name: 'holdout-timeline', c, truth: {
    title: 'Milestones of the Industrial Age', headings: [], labels: [],
    lines: events.map(e => e[1]), numbers: events.map(e => e[0]), rows: [],
    facts: [],
    questions: [{ q: 'When was the telephone patented?', answer: ['1876'] }, { q: 'When did the first powered airplane flight happen?', answer: ['1903'] }]
  } };
}
function prosCons() {
  const cols = [['Advantages', ['Lower cost per unit', 'Faster delivery to customers', 'Consistent product quality']], ['Disadvantages', ['High start-up investment', 'Less flexibility for custom orders', 'Workers may need retraining']]];
  const W = 1400, H = 760; const { c, g } = canvas(W, H, '#f7f9fb');
  g.font = `bold 38px ${FACE}`; g.fillStyle = '#123'; g.fillText('Mass Production', 60, 40);
  para(g, 'Mass production makes large amounts of standardized products on assembly lines.', 60, 100, 1200, 22, '#333');
  cols.forEach(([h, items], i) => {
    const x = 60 + i * 660; g.fillStyle = i ? '#fbe3e3' : '#e3f6e8'; g.fillRect(x, 180, 620, 520);
    g.font = `bold 30px ${FACE}`; g.fillStyle = '#123'; g.fillText(h, x + 24, 204);
    items.forEach((t, k) => { g.font = `22px ${FACE}`; g.fillStyle = '#222'; g.fillText(`${i ? '✗' : '✓'} ${t}`, x + 30, 270 + k * 48); });
  });
  return { name: 'holdout-pros-cons', c, truth: {
    title: 'Mass Production', headings: cols.map(x => x[0]), labels: [],
    lines: ['Mass production makes large amounts of standardized products on assembly lines.', ...cols.flatMap(x => x[1])], numbers: [], rows: [],
    facts: ['Mass production makes large amounts of standardized products on assembly lines.'],
    questions: [{ q: 'What is a disadvantage of mass production?', answer: ['investment'] }, { q: 'What are the advantages of mass production?', answer: ['lower cost'] }]
  } };
}
function textTable() {
  const header = ['Term', 'Meaning'];
  const rows = [['Asset', 'Something the business owns'], ['Liability', 'Something the business owes'], ['Equity', 'Owner claim after liabilities']];
  const W = 1300, H = 640; const { c, g } = canvas(W, H);
  title(g, W, 'ACCOUNTING TERMS');
  const x0 = 120, y0 = 150, cw = [300, 760], rh = 70;
  g.fillStyle = '#244a2f'; g.fillRect(x0, y0, 1060, rh);
  g.font = `bold 26px ${FACE}`; g.fillStyle = '#fff'; g.fillText(header[0], x0 + 20, y0 + 22); g.fillText(header[1], x0 + cw[0] + 20, y0 + 22);
  rows.forEach((r, k) => {
    g.fillStyle = k % 2 ? '#edf5ef' : '#fff'; g.fillRect(x0, y0 + rh * (k + 1), 1060, rh);
    g.font = `bold 24px ${FACE}`; g.fillStyle = '#222'; g.fillText(r[0], x0 + 20, y0 + rh * (k + 1) + 22);
    g.font = `24px ${FACE}`; g.fillText(r[1], x0 + cw[0] + 20, y0 + rh * (k + 1) + 22);
  });
  return { name: 'holdout-text-table', c, truth: {
    title: 'Accounting Terms', headings: [], labels: [],
    lines: rows.map(r => r[1]), numbers: [], rows: [header, ...rows],
    facts: rows.map(r => r[1]),
    questions: [{ q: 'What is a liability?', answer: ['owes'] }, { q: 'What does equity mean?', answer: ['owner claim'] }]
  } };
}

// ── Hard scenes: what still breaks readers. Tiny text after shrinking, light-on-dark slides, rotated labels,
//    and a two-column article whose reading order matters.
function tinyText() {
  const cols = [
    ['MARKETING MIX', ['Product is what the business sells.', 'Price is what the customer pays.', 'Place is where the product is sold.', 'Promotion tells customers about it.']],
    ['MARKET RESEARCH', ['Primary research collects new data.', 'Secondary research uses existing data.', 'A survey of 400 customers was used.', 'Focus groups test new ideas.']],
    ['SEGMENTATION', ['Demographic groups share age or income.', 'Geographic groups share a location.', 'Behavioural groups share buying habits.', 'Each segment needs its own message.']],
    ['BRANDING', ['A brand is the identity of a product.', 'Logos help customers remember a brand.', 'Brand loyalty reduces price sensitivity.', 'Rebranding cost the firm 2 million pesos.']],
    ['DISTRIBUTION', ['Direct channels sell straight to customers.', 'Indirect channels use wholesalers.', 'E-commerce grew by 18% last year.', 'Logistics moves goods to stores.']],
    ['PRICING', ['Cost-plus pricing adds a fixed margin.', 'Penetration pricing starts low.', 'Skimming pricing starts high.', 'Psychological prices end in 99.']]
  ];
  const W = 1920, H = 1080; const { c, g } = canvas(W, H);
  g.font = `bold 30px ${FACE}`; g.fillStyle = '#123'; g.fillText('Marketing Fundamentals', 40, 30);
  cols.forEach(([h, ls], i) => {
    const x = 40 + i * 312; g.fillStyle = '#f3f4f6'; g.fillRect(x, 90, 296, 960);
    g.font = `bold 14px ${FACE}`; g.fillStyle = '#123'; g.fillText(h, x + 10, 104);
    let y = 132; for (const l of ls) y = para(g, l, x + 10, y, 276, 11, '#333') + 8;
  });
  return { name: 'hard-tiny-text', c, truth: {
    title: 'Marketing Fundamentals', headings: cols.map(x => x[0]), labels: [],
    lines: cols.flatMap(x => x[1]), numbers: ['400', '2', '18%', '99'], rows: [],
    facts: cols.map(x => x[1][0]),
    questions: [{ q: 'How many customers were surveyed?', answer: ['400'] }, { q: 'How much did e-commerce grow last year?', answer: ['18%'] }]
  } };
}
function darkSlide() {
  const items = [['Inflation', 'A general rise in prices over time.'], ['Deflation', 'A general fall in prices over time.'], ['Stagflation', 'High inflation together with slow growth.']];
  const W = 1600, H = 900; const { c, g } = canvas(W, H);
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#0b1d3a'); grad.addColorStop(1, '#2b0b3a'); g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.font = `bold 44px ${FACE}`; g.fillStyle = '#ffd166'; g.fillText('PRICE LEVEL CHANGES', 70, 60);
  items.forEach(([h, d], i) => {
    const y = 200 + i * 220; g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(70, y, 1460, 180);
    g.font = `bold 32px ${FACE}`; g.fillStyle = '#7fdbff'; g.fillText(h, 100, y + 30);
    para(g, d, 100, y + 90, 1300, 26, '#e8e8f0');
  });
  return { name: 'hard-dark-slide', c, truth: {
    title: 'Price Level Changes', headings: items.map(x => x[0]), labels: [],
    lines: items.map(x => x[1]), numbers: [], rows: [],
    facts: items.map(x => x[1]),
    questions: [{ q: 'What is stagflation?', answer: ['slow growth'] }]
  } };
}
function rotated() {
  const W = 1400, H = 800; const { c, g } = canvas(W, H, '#fbfbfb');
  g.font = `bold 36px ${FACE}`; g.fillStyle = '#222'; g.fillText('Supply Chain Stages', 60, 40);
  const stages = [['Sourcing', 'Buying raw materials from suppliers.'], ['Production', 'Turning materials into finished goods.'], ['Delivery', 'Moving goods to the customer.']];
  stages.forEach(([h, d], i) => {
    g.save(); g.translate(120 + i * 430, 200); g.rotate(-0.12);
    g.fillStyle = ['#ffe3b3', '#cdeccd', '#cfe3ff'][i]; g.fillRect(0, 0, 360, 300);
    g.font = `bold 28px ${FACE}`; g.fillStyle = '#222'; g.fillText(h, 20, 24);
    para(g, d, 20, 90, 320, 22, '#333'); g.restore();
  });
  g.save(); g.translate(1350, 760); g.rotate(-Math.PI / 2); g.font = `18px ${FACE}`; g.fillStyle = '#777'; g.fillText('Source: Operations Handbook 2024', 0, 0); g.restore();
  return { name: 'hard-rotated', c, truth: {
    title: 'Supply Chain Stages', headings: stages.map(x => x[0]), labels: [],
    lines: stages.map(x => x[1]), numbers: [], rows: [],
    facts: stages.map(x => x[1]),
    questions: [{ q: 'What happens in production?', answer: ['finished goods'] }]
  } };
}
function twoColumns() {
  const left = ['Photosynthesis takes place in the chloroplasts of plant cells.', 'Light energy is captured by chlorophyll.', 'Water molecules are split and oxygen is released.'];
  const right = ['The Calvin cycle uses carbon dioxide to build sugars.', 'It runs in the stroma of the chloroplast.', 'ATP and NADPH from the light reactions power it.'];
  const W = 1500, H = 820; const { c, g } = canvas(W, H, '#fffef9');
  g.font = `bold 38px ${FACE}`; g.fillStyle = '#1d3b1d'; g.fillText('How Plants Make Food', 60, 40);
  g.font = `bold 26px ${FACE}`; g.fillText('Light Reactions', 60, 130); g.fillText('Calvin Cycle', 780, 130);
  let y = 190; for (const l of left) y = para(g, l, 60, y, 640, 22, '#333') + 18;
  y = 190; for (const l of right) y = para(g, l, 780, y, 640, 22, '#333') + 18;
  g.fillStyle = '#ccc'; g.fillRect(740, 130, 2, 600);
  return { name: 'hard-two-columns', c, truth: {
    title: 'How Plants Make Food', headings: ['Light Reactions', 'Calvin Cycle'], labels: [],
    lines: [...left, ...right], numbers: [], rows: [],
    facts: [left[0], right[0]],
    questions: [{ q: 'Where does the Calvin cycle run?', answer: ['stroma'] }, { q: 'What captures light energy?', answer: ['chlorophyll'] }]
  } };
}

function scenes() {
  return [processSteps(), dataTable(), comparison(), denseSmall(), lowContrast(), barChart(), timeline(), prosCons(), textTable(),
    tinyText(), darkSlide(), rotated(), twoColumns()]
    .map(s => ({ name: s.name, png: s.c.toBuffer('image/png'), truth: s.truth }));
}

module.exports = { scenes };
