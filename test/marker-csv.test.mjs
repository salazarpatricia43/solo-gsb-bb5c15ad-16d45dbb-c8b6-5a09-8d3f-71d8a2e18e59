// 现场标记 CSV/格式化纯函数测试（客户端模块，可直接在 Node 下运行）
import {
  buildMarkersCsv, csvCell, formatWallFull, formatWallClock,
  formatOffset, formatDeviationSec, formatPhase,
} from '../client/src/markers.js';

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const base = (seq, over) => ({
  seq,
  id: `m-${seq}`,
  name: `事件${seq}`,
  monoMs: 1000 * seq,
  wallMs: Date.UTC(2026, 8, 21, 1, 2, 3 + seq),
  phase: 'running',
  remainingMs: 60000 - seq * 1000,
  itemId: 'i0',
  itemName: '开场致辞',
  deviationMs: seq * 1500,
  ...over,
});

console.log('1) CSV 表头与转义');
const csv = buildMarkersCsv([base(2), base(1), base(3)]);
const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
ok('首行为表头', lines[0] === '序号,时刻,名称,环节,计时状态,剩余时间(ms),相对计划偏差,单调时钟(ms)', lines[0]);
ok('按 seq 升序输出（无论传入顺序）',
  /^1,/.test(lines[1]) && /^2,/.test(lines[2]) && /^3,/.test(lines[3]));
ok('含 UTF-8 BOM（Excel 中文兼容）', csv.charCodeAt(0) === 0xFEFF);
ok('行分隔为 CRLF', csv.includes('\r\n'));

const quoted = buildMarkersCsv([base(1, { name: '故障,麦克风"坏"\n重启' })]).split('\r\n')[1];
ok('逗号/引号/换行字段被双引号包裹且内部引号翻倍',
  quoted.includes('"故障,麦克风""坏""\n重启"'), quoted);

console.log('2) 单元格转义');
ok('普通文本不加引号', csvCell('发言切换') === '发言切换');
ok('空值输出空字符串', csvCell(null) === '' && csvCell(undefined) === '');
ok('含逗号加引号', csvCell('a,b') === '"a,b"');
ok('引号翻倍', csvCell('a"b') === '"a""b"');

console.log('3) 字段格式化');
const t = Date.UTC(2026, 8, 21, 1, 30, 5); // UTC；本地时区下只校验结构
const clock = formatWallClock(t);
ok('时钟格式 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(clock), clock);
ok('完整时刻格式 YYYY-MM-DD HH:MM:SS', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatWallFull(t)));
ok('非法时刻给出安全输出', formatWallClock(NaN) === '--:--:--' && formatWallFull(NaN) === '');

ok('偏移格式化（分:秒）', formatOffset(0) === 'T+00:00' && formatOffset(83000) === 'T+01:23');
ok('偏移超 1 小时带小时段', formatOffset(3725000) === 'T+01:02:05', formatOffset(3725000));
ok('负偏移归零', formatOffset(-5) === 'T+00:00');

ok('偏差秒带符号',
  formatDeviationSec(0) === '+0.0s'
  && formatDeviationSec(1500) === '+1.5s'
  && formatDeviationSec(-2300) === '-2.3s');

ok('计时状态中文化',
  formatPhase('idle') === '待开始' && formatPhase('running') === '进行中'
  && formatPhase('paused') === '已暂停' && formatPhase('finished') === '已超时');

console.log('4) 无环节归属与空列表');
const noItem = buildMarkersCsv([base(1, { itemId: null, itemName: null, phase: 'idle' })]).split('\r\n')[1];
ok('无归属环节输出空单元格（不出现 null 字样）',
  !noItem.includes('null') && noItem.split(',')[3] === '', noItem);
const emptyCsv = buildMarkersCsv([]).replace(/^﻿/, '').replace(/\r\n$/, '');
ok('空列表只输出表头', emptyCsv === '序号,时刻,名称,环节,计时状态,剩余时间(ms),相对计划偏差,单调时钟(ms)');

console.log(`\n现场标记 CSV 测试：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  console.log('失败项:', failures.join('; '));
  process.exit(1);
}
