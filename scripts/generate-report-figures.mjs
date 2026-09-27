import fs from 'node:fs';

const out = 'report_handoff/figures';
const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const svg = (w, h, body, title, note = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/><style>text{font-family:Arial,sans-serif;fill:#17202a} .title{font-size:20px;font-weight:700}.sub{font-size:12px;fill:#566573}.axis{stroke:#566573;stroke-width:1}.grid{stroke:#d5dbdb;stroke-width:1}.r{fill:#2874a6}.h{fill:#d35400}.lab{font-size:12px}.small{font-size:10px;fill:#566573}</style><text x="36" y="30" class="title">${esc(title)}</text>${body}${note ? `<text x="36" y="${h - 14}" class="small">${esc(note)}</text>` : ''}</svg>`;
const barChart = (file, title, labels, reactive, hybrid, unit) => {
  const W = 900, H = 500, left = 74, top = 76, bottom = 74, plotH = H - top - bottom, max = Math.max(...reactive, ...hybrid) * 1.18, groupW = 110, x0 = 100;
  let b = `<text x="${W - 190}" y="28" class="lab" fill="#2874a6">■ Reactive</text><text x="${W - 90}" y="28" class="lab" fill="#d35400">■ Hybrid</text>`;
  for (let i = 0; i <= 5; i++) { const y = top + plotH - plotH * i / 5; const v = max * i / 5; b += `<line x1="${left}" y1="${y}" x2="${W - 34}" y2="${y}" class="grid"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" class="small">${v.toFixed(v < 10 ? 1 : 0)}</text>`; }
  b += `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotH}" class="axis"/><line x1="${left}" y1="${top + plotH}" x2="${W - 34}" y2="${top + plotH}" class="axis"/>`;
  labels.forEach((lab, i) => { const x = x0 + i * groupW; const rh = reactive[i] / max * plotH, hh = hybrid[i] / max * plotH; b += `<rect x="${x}" y="${top + plotH - rh}" width="30" height="${rh}" class="r"/><rect x="${x + 36}" y="${top + plotH - hh}" width="30" height="${hh}" class="h"/><text x="${x + 33}" y="${top + plotH + 18}" text-anchor="middle" class="lab">${esc(lab)}</text><text x="${x + 15}" y="${top + plotH - rh - 5}" text-anchor="middle" class="small">${reactive[i]}</text><text x="${x + 51}" y="${top + plotH - hh - 5}" text-anchor="middle" class="small">${hybrid[i]}</text>`; });
  b += `<text x="18" y="${top + plotH / 2}" transform="rotate(-90 18 ${top + plotH / 2})" class="lab">${esc(unit)}</text><text x="${W / 2}" y="${H - 36}" text-anchor="middle" class="lab">repeat</text>`;
  fs.writeFileSync(`${out}/${file}`, svg(W, H, b, title, 'Source: reviewed local AWS formal artifacts; bars are raw per-repeat values.'));
};

barChart('figure-a-ramp-peak-bpt.svg', 'Figure A. Predictable-ramp genuine peak BacklogPerTask', ['r1','r2','r3'], [728,911,750], [40,44,45], 'peak BPT (jobs/task)');
barChart('figure-c-ramp-task-seconds.svg', 'Figure C. Predictable-ramp running-task time proxy', ['r1','r2','r3'], [600,630.692,671.164], [1139.196,1170.271,857.978], 'task-seconds (not AWS cost)');

const meanPanels = [
  ['peak visible queue', 913, 51.667], ['peak BPT', 796.333, 43], ['oldest age (s)', 33.333, 20],
];
let p = `<text x="690" y="28" class="lab" fill="#2874a6">■ Reactive mean</text><text x="790" y="28" class="lab" fill="#d35400">■ Hybrid mean</text>`;
meanPanels.forEach(([name, r, h], i) => { const y = 86 + i * 116, max = Math.max(r,h) * 1.2, scale = 250 / max; p += `<text x="36" y="${y}" class="lab">${esc(name)}</text><rect x="200" y="${y - 16}" width="${r * scale}" height="22" class="r"/><rect x="200" y="${y + 12}" width="${h * scale}" height="22" class="h"/><text x="${210 + r * scale}" y="${y + 1}" class="small">${r}</text><text x="${210 + h * scale}" y="${y + 29}" class="small">${h}</text>`; });
fs.writeFileSync(`${out}/figure-b-ramp-mean-pressure.svg`, svg(900, 500, p, 'Figure B. Predictable-ramp mean pressure comparison', 'Each row keeps native units; means use the three valid repeats per arm.'));

const events = [
  ['Reactive r2 request', 596.589, '#2874a6'], ['Reactive first ready', 620.686, '#5dade2'], ['Hybrid predictive request', 433.712, '#d35400'], ['Hybrid first ready', 475.168, '#f5b041'],
];
let t = `<text x="36" y="66" class="sub">Representative r2 timelines are normalized to each run\'s workload start; request and first-ready times are from raw scaling/log evidence.</text><line x1="90" y1="190" x2="850" y2="190" class="axis"/><text x="90" y="215" class="lab">0 s</text><text x="450" y="215" class="lab">300 s</text><text x="830" y="215" class="lab">630 s</text>`;
events.forEach(([name, sec, color], i) => { const x = 90 + sec / 630 * 760; const y = 90 + i * 25; t += `<line x1="${x}" y1="${y}" x2="${x}" y2="190" stroke="${color}" stroke-width="3"/><circle cx="${x}" cy="190" r="5" fill="${color}"/><text x="${x + 6}" y="${y + 4}" class="lab" fill="${color}">${esc(name)} (${sec.toFixed(1)} s)</text>`; });
t += `<text x="90" y="260" class="lab">Interpretation: hybrid r2 requested earlier than reactive r2; the first-ready events followed the requests by about 41.5 s and 24.1 s respectively.</text>`;
fs.writeFileSync(`${out}/figure-d-ramp-r2-timeline.svg`, svg(900, 330, t, 'Figure D. Representative predictable-ramp r2 scaling timeline', 'No smoothing; event times are preserved observations.'));

const burst = `<text x="690" y="28" class="lab" fill="#2874a6">■ Reactive r1</text><text x="790" y="28" class="lab" fill="#d35400">■ Hybrid r1</text>`;
const vals = [['peak visible queue',790,460],['peak BPT',691,112.5],['oldest age (s)',30,29],['task-seconds',1729.254,2071.156]];
let e = burst; vals.forEach(([n,r,h],i)=>{const y=78+i*80,max=Math.max(r,h)*1.2,scale=240/max;e+=`<text x="36" y="${y}" class="lab">${n}</text><rect x="220" y="${y-16}" width="${r*scale}" height="20" class="r"/><rect x="220" y="${y+10}" width="${h*scale}" height="20" class="h"/><text x="${230+r*scale}" y="${y}" class="small">${r}</text><text x="${230+h*scale}" y="${y+26}" class="small">${h}</text>`});
fs.writeFileSync(`${out}/figure-e-burst-r1-preliminary.svg`, svg(900, 430, e, 'Figure E. Sudden-burst r1 descriptive comparison (PRELIMINARY)', 'One valid repeat per arm; not a completed 3×3 burst conclusion.'));
