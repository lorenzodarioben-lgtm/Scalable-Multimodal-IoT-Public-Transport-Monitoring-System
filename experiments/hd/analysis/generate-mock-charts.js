#!/usr/bin/env node
/** Layout-only chart samples. Never use these as an HD result. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineChart, barChart, eventTimeline } from './charts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'artifacts/hd-mock-charts');
fs.mkdirSync(output, { recursive: true });
const watermark = 'MOCK DATA — NOT EXPERIMENTAL EVIDENCE';
const origin = Date.parse('2000-01-01T00:00:00Z');
const at = (second) => new Date(origin + second * 1000).toISOString();
const times = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 630];
const points = (values) => times.map((second, index) => ({ timestamp: at(second), value: values[index] }));
const line = (filename, title, yLabel, series) => fs.writeFileSync(path.join(output, filename),
  lineChart({ title, yLabel, startedAt: at(0), endedAt: at(630), series, watermark }));
const bar = (filename, title, yLabel, categories) => fs.writeFileSync(path.join(output, filename),
  barChart({ title, yLabel, categories, watermark }));
line('01-arrival-vs-prediction.svg', 'Ramp: arrival versus forecast', 'Jobs/s', [
  { name: 'Observed', points: points([10, 10, 10, 16, 16, 25, 25, 33, 33, 50, 50, 50]) },
  { name: 'Predicted', points: points([10, 10, 11, 15, 18, 24, 30, 36, 42, 47, 50, 50]) },
]);
line('02-visible-backlog.svg', 'Ramp: matched visible backlog', 'Jobs', [
  { name: 'Reactive mean', points: points([0, 0, 0, 10, 0, 25, 30, 50, 100, 300, 500, 300]) },
  { name: 'Hybrid mean', points: points([0, 0, 0, 10, 0, 25, 30, 30, 20, 50, 40, 0]) },
]);
line('03-running-tasks.svg', 'Ramp: matched running tasks', 'Tasks', [
  { name: 'Reactive mean', points: points([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 5]) },
  { name: 'Hybrid mean', points: points([1, 1, 1, 1, 1, 1, 1, 1, 5, 5, 5, 5]) },
]);
bar('04-peak-backlog.svg', 'Ramp: peak visible backlog', 'Jobs', [
  { name: 'Reactive', value: 500 }, { name: 'Hybrid', value: 50 },
]);
bar('05-oldest-age.svg', 'Ramp: peak oldest-message age', 'Seconds', [
  { name: 'Reactive', value: 22 }, { name: 'Hybrid', value: 4 },
]);
bar('06-scale-latency.svg', 'Ramp: scale-request latency', 'Seconds', [
  { name: 'Reactive', value: 93 }, { name: 'Hybrid', value: 0 },
]);
bar('07-task-seconds.svg', 'Ramp: measurement resource-use proxy', 'Task-seconds', [
  { name: 'Reactive', value: 650 }, { name: 'Hybrid', value: 800 },
]);
bar('08-forecast-mae.svg', 'Hybrid forecast MAE by repeat', 'Jobs/s', [
  { name: 'r1', value: 8 }, { name: 'r2', value: 9 }, { name: 'r3', value: 10 },
]);
fs.writeFileSync(path.join(output, '09-scale-timeline.svg'), eventTimeline({
  title: 'Ramp: request-to-ready sequence', startedAt: at(0), endedAt: at(630), watermark,
  events: [{ label: 'Overload', timestamp: at(510) }, { label: 'Request', timestamp: at(420) },
    { label: 'First RUNNING', timestamp: at(450) }, { label: 'First READY', timestamp: at(460) }],
}));
process.stdout.write(`${watermark}\n${output}\n`);
