// 现场标记：时间线格式化与本场会话 CSV 导出（纯函数，便于单测）。
// 标记的时刻 / 环节归属 / 偏差均在服务端记录当下冻结，客户端只负责展示与导出。

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 日历时刻（wallMs，由服务端 Date.now 给出）格式化为 HH:MM:SS
export function formatWallClock(wallMs) {
  if (!Number.isFinite(wallMs)) return '--:--:--';
  const d = new Date(wallMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// YYYY-MM-DD HH:MM:SS（CSV 单元格与悬停提示使用）
export function formatWallFull(wallMs) {
  if (!Number.isFinite(wallMs)) return '';
  const d = new Date(wallMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 文件名字符串：YYYYMMDD-HHMMSS（本地时区）
export function formatFileStamp(wallMs) {
  const d = new Date(wallMs);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function formatPhase(phase) {
  return { idle: '待开始', running: '进行中', paused: '已暂停', finished: '已超时' }[phase] || phase || '';
}

// 偏差（毫秒）格式化为带符号秒：+12s / -3s / 0s（CSV 使用，避免本地化文字影响计算）
export function formatDeviationSec(ms) {
  if (!Number.isFinite(ms)) return '';
  return `${(ms / 1000) >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`;
}

// 相对会话首个标记的偏移（秒），用于时间线展示“T+01:23”
export function formatOffset(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'T+00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `T+${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `T+${pad2(m)}:${pad2(s)}`;
}

// RFC 4180：含逗号 / 引号 / 换行的单元格加双引号并把内部引号翻倍
export function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const MARKER_CSV_HEADER = [
  '序号', '时刻', '名称', '环节', '计时状态', '剩余时间(ms)', '相对计划偏差', '单调时钟(ms)',
];

// 生成整场会话的 CSV 文本（按发生顺序，即服务端 seq 升序）。
// monoMs 为进程内单调毫秒，仅用于精确核对间隔；wallMs 为日历时刻。
export function buildMarkersCsv(markers) {
  const rows = [...markers].sort((a, b) => (a.seq - b.seq) || (a.monoMs - b.monoMs));
  const lines = [MARKER_CSV_HEADER.map(csvCell).join(',')];
  for (const m of rows) {
    lines.push([
      m.seq,
      formatWallFull(m.wallMs),
      m.name ?? '',
      m.itemName ?? '',
      formatPhase(m.phase),
      Math.max(0, Math.round(Number(m.remainingMs) || 0)),
      formatDeviationSec(Number(m.deviationMs) || 0),
      Math.round(Number(m.monoMs) || 0),
    ].map(csvCell).join(','));
  }
  // 前置 UTF-8 BOM，保证 Excel 直接打开中文不乱码
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// 浏览器下载 CSV（Blob + a[download]）
export function downloadMarkersCsv(markers, nowMs = Date.now()) {
  const csv = buildMarkersCsv(markers);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `现场标记-${formatFileStamp(nowMs)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
