/** Small, dependency-free SVG charts. AWS history and local simulation must never be mixed. */
import fs from 'node:fs';
import path from 'node:path';

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const palette = ['#1463a5', '#d55e00', '#00866d', '#6a4c93'];

export function lineChart({ title, yLabel, series, startedAt, endedAt }) {
  const width = 900; const height = 400; const left = 78; const right = 20;
  const top = 48; const bottom = 60;
  const start = Date.parse(startedAt); const end = Date.parse(endedAt);
  const points = series.flatMap((item) => item.points || []);
  const maxY = Math.max(1, ...points.map((item) => Number(item.value) || 0));
  const x = (timestamp) => left + (Date.parse(timestamp) - start) / Math.max(1, end - start) * (width - left - right);
  const y = (value) => height - bottom - Math.max(0, Number(value)) / maxY * (height - top - bottom);
  const lines = series.map((item, index) => {
    const coords = item.points.filter((point) => Number.isFinite(Number(point.value))
      && Number.isFinite(Date.parse(point.timestamp)))
      .map((point) => `${x(point.timestamp).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
    return `<polyline fill="none" stroke="${palette[index % palette.length]}" stroke-width="2" points="${coords}"/>`;
  }).join('');
  const legend = series.map((item, index) => `<text x="${left + index * 190}" y="${height - 13}" fill="${palette[index % palette.length]}" font-size="12">${escape(item.name)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="${left}" y="25" font-size="18" font-family="sans-serif">${escape(title)}</text><text x="5" y="${top}" font-size="12" font-family="sans-serif">${escape(yLabel)}</text><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#333"/><line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" stroke="#333"/><text x="${left}" y="${height - bottom + 17}" font-size="11">0 min</text><text x="${width - right - 45}" y="${height - bottom + 17}" font-size="11">${((end - start) / 60000).toFixed(1)} min</text><text x="${left - 48}" y="${top + 6}" font-size="11">${maxY.toFixed(1)}</text>${lines}${legend}</svg>`;
}

export function barChart({ title, yLabel, categories }) {
  const width = 700; const height = 390; const left = 75; const bottom = 80;
  const maxY = Math.max(1, ...categories.map((item) => item.value));
  const barWidth = Math.min(100, 440 / Math.max(1, categories.length));
  const gap = (width - left - 20) / Math.max(1, categories.length);
  const bars = categories.map((item, index) => {
    const h = item.value / maxY * 240; const x = left + gap * index + (gap - barWidth) / 2;
    return `<rect x="${x}" y="${height - bottom - h}" width="${barWidth}" height="${h}" fill="${palette[index % palette.length]}"/><text x="${x}" y="${height - bottom - h - 5}" font-size="12">${item.value.toFixed(1)}</text><text x="${x}" y="${height - bottom + 20}" font-size="11">${escape(item.name)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="${left}" y="26" font-size="18" font-family="sans-serif">${escape(title)}</text><text x="5" y="48" font-size="12">${escape(yLabel)}</text><line x1="${left}" y1="${height - bottom}" x2="${width - 20}" y2="${height - bottom}" stroke="#333"/>${bars}</svg>`;
}

export function eventTimeline({ title, startedAt, endedAt, events }) {
  const width = 900; const height = 70 + Math.max(1, events.length) * 32;
  const start = Date.parse(startedAt); const duration = Math.max(1, Date.parse(endedAt) - start);
  const marks = events.map((event, index) => {
    const x = 145 + Math.max(0, Math.min(1, (Date.parse(event.timestamp) - start) / duration)) * 700;
    const y = 68 + index * 32;
    return `<text x="8" y="${y + 4}" font-size="11">${escape(event.label)}</text><circle cx="${x.toFixed(1)}" cy="${y}" r="5" fill="${palette[index % palette.length]}"/><text x="${Math.min(x + 7, 790).toFixed(1)}" y="${y + 4}" font-size="10">${((Date.parse(event.timestamp) - start) / 1000).toFixed(1)}s</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="8" y="25" font-size="18">${escape(title)}</text><line x1="145" y1="42" x2="845" y2="42" stroke="#333"/><text x="145" y="55" font-size="10">0s</text><text x="800" y="55" font-size="10">${(duration / 1000).toFixed(0)}s</text>${marks}</svg>`;
}

export function writeRunCharts(run, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const { samples, history } = run.raw;
  const start = samples[0]?.timestamp; const end = samples.at(-1)?.timestamp;
  if (!start || !end) return [];
  const charts = [
    ['arrival-prediction.svg', lineChart({ title: `${run.runId}: arrival and forecast (genuine CloudWatch)`,
      yLabel: 'Jobs/s', startedAt: start, endedAt: end, series: [
        { name: 'Observed arrivals', points: history.predictive.AnalysisArrivalRate || [] },
        { name: 'Predicted arrivals', points: history.predictive.PredictedArrivalRate || [] },
      ] })],
    ['visible-backlog.svg', lineChart({ title: `${run.runId}: visible analysis backlog (SQS samples)`,
      yLabel: 'Jobs', startedAt: start, endedAt: end,
      series: [{ name: 'Visible', points: samples.map((item) => ({ timestamp: item.timestamp,
        value: item.queue?.visibleMessages || 0 })) }] })],
    ['running-tasks.svg', lineChart({ title: `${run.runId}: running ECS tasks (sampled)`,
      yLabel: 'Tasks', startedAt: start, endedAt: end,
      series: [{ name: 'Running', points: samples.map((item) => ({ timestamp: item.timestamp,
        value: item.service?.runningCount || 0 })) }] })],
    ['scale-request-timeline.svg', eventTimeline({ title: `${run.runId}: scale-out sequence`,
      startedAt: start, endedAt: end, events: [
        { label: 'First overload', timestamp: run.firstOverloadAt },
        { label: 'Scale request', timestamp: run.firstScaleRequestAt },
        { label: 'First worker ready', timestamp: run.firstWorkerReadyAt },
      ].filter((event) => event.timestamp) })],
  ];
  for (const [name, svg] of charts) fs.writeFileSync(path.join(outputDir, name), svg);
  return charts.map(([name]) => path.join(outputDir, name));
}
