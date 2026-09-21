import { useMemo, useState } from 'react';
import { formatTime, formatDeviation } from '../time.js';
import {
  formatWallClock, formatWallFull, formatPhase,
  formatOffset, downloadMarkersCsv,
} from '../markers.js';

const MAX_NAME_LEN = 30;

// 常用事件一键填入（仍可自由编辑后再记录）
const QUICK_NAMES = ['发言切换', '设备故障', '提示上场', '现场休会'];

// 现场标记面板：持有者在当前环节记录带名称的事件。
// 服务端以单调时钟保存发生时刻、记录当下的环节归属与相对计划偏差，
// 时间线按发生顺序展示；支持删除最近一条与按本场会话导出 CSV。
export default function MarkerPanel({ markers, currentItemIds, canMark, send, lastError, onClearError }) {
  const [name, setName] = useState('');

  // 时间线：最新在上；CSV 导出内部再按 seq 升序
  const timeline = useMemo(
    () => [...markers].sort((a, b) => (b.monoMs - a.monoMs) || (b.seq - a.seq)),
    [markers],
  );
  const firstMono = useMemo(
    () => markers.reduce((min, m) => (min == null || m.monoMs < min ? m.monoMs : min), null),
    [markers],
  );
  const goneIds = useMemo(() => new Set(currentItemIds ?? []), [currentItemIds]);

  const submit = () => {
    const text = name.trim();
    if (!canMark || !text) return;
    send({ command: 'marker_add', name: text.slice(0, MAX_NAME_LEN) });
    setName('');
  };

  const removeLast = () => {
    if (!canMark || markers.length === 0) return;
    send({ command: 'marker_remove_last' });
  };

  const markerError = lastError?.code === 'BAD_MARKER' || lastError?.code === 'MARKERS_FULL'
    ? lastError
    : null;

  return (
    <fieldset className="panel marker-panel" disabled={!canMark}>
      <legend>现场标记（记录本场事件时间线；仅控制台可见，投屏不显示）</legend>

      <div className="marker-add">
        <input
          value={name}
          maxLength={MAX_NAME_LEN}
          placeholder="标记名称，如：发言切换 / 麦克风故障（最多 30 字）"
          onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LEN))}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!name.trim()}>
          ＋ 记录标记
        </button>
        <button
          type="button"
          className="btn btn-danger-ghost"
          onClick={removeLast}
          disabled={markers.length === 0}
          title={markers.length ? `删除最近一条：${markers[markers.length - 1].name}` : '暂无标记'}
        >
          删除最近一条
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => downloadMarkersCsv(markers)}
          disabled={markers.length === 0}
          title="导出本场全部标记为 CSV（按发生顺序）"
        >
          ⬇ 导出 CSV
        </button>
      </div>

      <div className="marker-quick">
        {QUICK_NAMES.map((q) => (
          <button
            key={q}
            type="button"
            className="btn btn-mini marker-quick-btn"
            onClick={() => setName(q)}
            title={`填入“${q}”，再点记录标记`}
          >
            {q}
          </button>
        ))}
        <span className="marker-counter">{name.trim().length}/{MAX_NAME_LEN}</span>
        <span className="marker-total">本场共 {markers.length} 条</span>
      </div>

      {markerError && (
        <p className="agenda-error">⚠ {markerError.message}
          <button type="button" className="marker-error-dismiss" onClick={onClearError}>知道了</button>
        </p>
      )}

      {timeline.length === 0 ? (
        <p className="hint">尚无标记。计时运行、暂停或归零时均可记录；时刻与偏差以服务端单调时钟为准。</p>
      ) : (
        <ol className="marker-timeline">
          {timeline.map((m) => (
            <li key={m.id} className="marker-row">
              <span className="marker-time" title={formatWallFull(m.wallMs)}>
                <b>{formatWallClock(m.wallMs)}</b>
                <em className="marker-offset">{firstMono == null ? '' : formatOffset(m.monoMs - firstMono)}</em>
              </span>
              <span className="marker-name" title={m.name}>{m.name}</span>
              <span className="marker-item">
                {m.itemName ? (
                  <>
                    <span className="marker-item-tag">{m.itemName}</span>
                    {m.itemId && !goneIds.has(m.itemId) && (
                      <em className="tag marker-tag-gone">议程已变更</em>
                    )}
                  </>
                ) : (
                  <span className="marker-item-none">（未设定环节）</span>
                )}
              </span>
              <span className="marker-meta">
                <em className="marker-phase">{formatPhase(m.phase)}</em>
                {m.phase !== 'finished' && (
                  <em className="marker-remaining">剩 {formatTime(m.remainingMs)}</em>
                )}
                <em className={deviationClass(m.deviationMs)}>
                  偏差 {formatDeviation(m.deviationMs)}
                </em>
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="hint">
        每条标记在记录当下冻结环节归属与相对计划偏差；之后暂停、重连或进入下一环节，
        历史标记顺序与归属保持不变。标记仅存服务端内存，服务重启即开始一场新会话。
      </p>
    </fieldset>
  );
}

function deviationClass(ms) {
  if (Math.abs(ms) < 1000) return 'dev-ok';
  return ms < 0 ? 'dev-early' : 'dev-late';
}
