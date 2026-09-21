// 现场标记（marker）集成测试：启动独立服务实例（独立端口），验证：
//  1. 仅持有者可记录/删除标记，非持有者收到 NOT_CONTROLLER；
//  2. 标记以单调时钟保存，返回冻结的当前环节、计时状态、剩余与相对计划偏差；
//  3. 暂停/继续后记录标记，历史标记内容不被回改；进入下一环节后旧标记归属保持；
//  4. 删除最近一条：只删末尾、seq 不回收，再记录的 seq 严格更大；
//  5. 名称校验（空 / 超 30 字 → BAD_MARKER）；
//  6. 控制台重连后收到本场全部标记（整体替换），投屏连接在协议层收不到任何标记；
//  7. 未设当前环节时也可记录（环节归属为 null）；整体替换议程后旧标记显示原归属。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_MARKER_PORT || 3399;
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const state = { markers: [] };
    ws.on('open', () => resolve({ ws, inbox, state }));
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      if (m.type === 'markers') state.markers = m.markers;
    });
  });
}
async function next(inbox, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
async function nextSnap(inbox, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = 0; i < inbox.length; i++) {
      if (inbox[i].type === 'snapshot' && (!pred || pred(inbox[i]))) {
        return inbox.splice(i, 1)[0];
      }
    }
    if (Date.now() > deadline) throw new Error('等待匹配快照超时');
    await sleep(20);
  }
}
async function drain(inbox, ms = 300) {
  await sleep(ms);
  return inbox.splice(0);
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 投屏连接在协议层收不到任何标记消息');
  const display = await connect();
  await next(display.inbox, 'hello');
  await next(display.inbox, 'snapshot');
  display.ws.send(JSON.stringify({
    command: 'screen_register',
    screenId: 's-aaaaaaaa-1111-4222-8333-cccccccccc01',
    name: '主会场大屏',
  }));
  await next(display.inbox, 'screen_hello');

  console.log('2) 控制台获取控制权并准备议程');
  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({ command: 'acquire' }));
  const g = await next(con.inbox, 'control');
  ok('控制台获得控制权', g.granted === true);
  // 申请成功即收到（空）标记名单
  const initMarkers = await next(con.inbox, 'markers');
  ok('申请控制权后收到本场标记名单', Array.isArray(initMarkers.markers) && initMarkers.markers.length === 0);

  const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'i0', name: '开场致辞', startMs: H(9), durationMs: 60000, fixed: false },
      { id: 'i1', name: '主题演讲', startMs: H(9, 1), durationMs: 120000, fixed: false },
    ],
  }));
  await nextSnap(con.inbox, (m) => m.agenda && m.agenda.items.length === 2);
  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'i0' }));
  await nextSnap(con.inbox, (m) => m.agenda && m.agenda.currentId === 'i0');

  console.log('3) 非持有者记录标记被拒');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  other.ws.send(JSON.stringify({ command: 'marker_add', name: '越权标记' }));
  const errNotCtrl = await next(other.inbox, 'error');
  ok('非持有者 marker_add 返回 NOT_CONTROLLER', errNotCtrl.code === 'NOT_CONTROLLER', errNotCtrl.code);
  other.ws.close();

  console.log('4) 未开始也可记录：归属当前环节、phase=idle、偏差≈0');
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '设备调试' }));
  const mk1Msg = await next(con.inbox, 'markers');
  let mk1 = mk1Msg.markers[0];
  ok('标记 seq=1 且名称被保存', mk1.seq === 1 && mk1.name === '设备调试', JSON.stringify(mk1));
  ok('冻结环节归属 i0/开场致辞', mk1.itemId === 'i0' && mk1.itemName === '开场致辞', JSON.stringify(mk1));
  ok('记录时 phase=idle、剩余=环节时长 60s',
    mk1.phase === 'idle' && mk1.remainingMs === 60000, JSON.stringify(mk1));
  ok('单调时刻与日历时刻均为正数',
    Number.isFinite(mk1.monoMs) && mk1.monoMs > 0 && mk1.wallMs > 0);
  ok('未开始时偏差≈0', Math.abs(mk1.deviationMs) < 50, `${mk1.deviationMs}`);

  console.log('5) 运行 2s 后记录：偏差仍≈0（未超时假设准时结束），剩余约 58s');
  con.ws.send(JSON.stringify({ command: 'start' }));
  await nextSnap(con.inbox, (m) => m.phase === 'running');
  await sleep(2000);
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '发言切换' }));
  const mk2Msg = await next(con.inbox, 'markers');
  const mk2 = mk2Msg.markers.find((m) => m.seq === 2);
  ok('第二条标记 seq=2、phase=running、名称正确',
    mk2 && mk2.phase === 'running' && mk2.name === '发言切换');
  ok('剩余时间约 58s（误差 <0.5s）',
    mk2 && Math.abs(mk2.remainingMs - 58000) < 500, `${mk2?.remainingMs}`);
  ok('运行未结束时偏差≈0', mk2 && Math.abs(mk2.deviationMs) < 50, `${mk2?.deviationMs}`);
  ok('monoMs 严格递增', mk2 && mk2.monoMs > mk1.monoMs);

  console.log('6) 暂停后记录：phase=paused，且历史标记不被回改');
  con.ws.send(JSON.stringify({ command: 'pause' }));
  await nextSnap(con.inbox, (m) => m.phase === 'paused');
  await sleep(300);
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '设备故障' }));
  const mk3Msg = await next(con.inbox, 'markers');
  const mk3 = mk3Msg.markers.find((m) => m.seq === 3);
  ok('暂停中标记 phase=paused', mk3 && mk3.phase === 'paused');
  const frozenRem = mk3.remainingMs;
  const reRead = con.state.markers;
  const old1 = reRead.find((m) => m.seq === 1);
  const old2 = reRead.find((m) => m.seq === 2);
  ok('历史标记 1/2 仍保留原 phase 与归属',
    old1.phase === 'idle' && old1.itemId === 'i0' && old2.phase === 'running' && old2.itemId === 'i0');
  ok('历史标记剩余时间未随暂停改变（标记 2 仍≈58s）',
    Math.abs(old2.remainingMs - mk2.remainingMs) < 1, `${old2.remainingMs}`);
  ok('暂停期间剩余时间冻结', Math.abs(frozenRem - mk2.remainingMs) < 600, `${frozenRem}`);
  con.ws.send(JSON.stringify({ command: 'resume' }));
  await nextSnap(con.inbox, (m) => m.phase === 'running');

  console.log('7) 进入下一环节后：旧标记归属仍是 i0/开场致辞');
  con.ws.send(JSON.stringify({ command: 'advance' }));
  await nextSnap(con.inbox, (m) => m.agenda && m.agenda.currentId === 'i1' && m.phase === 'running');
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '下一位讲者' }));
  const mk4Msg = await next(con.inbox, 'markers');
  const mk4 = mk4Msg.markers.find((m) => m.seq === 4);
  ok('新标记归属 i1/主题演讲', mk4 && mk4.itemId === 'i1' && mk4.itemName === '主题演讲', JSON.stringify(mk4));
  const kept = mk4Msg.markers;
  ok('前 3 条标记归属与顺序保持不变',
    kept.filter((m) => m.itemId === 'i0').length === 3
      && kept.map((m) => m.seq).join(',') === '1,2,3,4',
    kept.map((m) => `${m.seq}:${m.itemId}`).join(' '));

  console.log('8) 删除最近一条：只删末尾、seq 不回收；删除后再记 seq 继续递增');
  con.ws.send(JSON.stringify({ command: 'marker_remove_last' }));
  const delMsg = await next(con.inbox, 'markers');
  ok('删除后剩 3 条且为最早三条',
    delMsg.markers.length === 3 && delMsg.markers.map((m) => m.seq).join(',') === '1,2,3');
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '补记' }));
  const mk5Msg = await next(con.inbox, 'markers');
  const seqs = mk5Msg.markers.map((m) => m.seq);
  ok('新标记 seq=5（不回收已删除的 4），顺序单调',
    seqs.join(',') === '1,2,3,5', seqs.join(','));

  console.log('9) 名称校验：空名 / 超 30 字 → BAD_MARKER，名单不变');
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '   ' }));
  const errEmpty = await next(con.inbox, 'error');
  ok('空白名称被拒 BAD_MARKER', errEmpty.code === 'BAD_MARKER', errEmpty.code);
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '字'.repeat(31) }));
  const errLong = await next(con.inbox, 'error');
  ok('超过 30 字被拒 BAD_MARKER', errLong.code === 'BAD_MARKER', errLong.code);
  await sleep(100);
  ok('被拒后名单不变（仍 4 条）', con.state.markers.length === 4, `${con.state.markers.length}`);
  ok('名称首尾空白被 trim', (() => {
    con.ws.send(JSON.stringify({ command: 'marker_add', name: '  换场  ' }));
    return true;
  })());
  const trimMsg = await next(con.inbox, 'markers');
  const trimmed = trimMsg.markers.find((m) => m.name === '换场');
  ok('带空白的名称记录为 trim 后的“换场”', !!trimmed);

  console.log('10) 整体替换议程：旧标记保留原归属名称');
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'n0', name: '全新环节', startMs: H(14), durationMs: 300000, fixed: false },
    ],
  }));
  await nextSnap(con.inbox, (m) => m.agenda && m.agenda.items[0].id === 'n0');
  con.ws.send(JSON.stringify({ command: 'marker_remove_last' })); // 去掉“换场”，保留跨议程旧标记
  await next(con.inbox, 'markers');
  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'n0' }));
  await nextSnap(con.inbox, (m) => m.agenda && m.agenda.currentId === 'n0');
  con.ws.send(JSON.stringify({ command: 'marker_add', name: '新议程标记' }));
  const newMsg = await next(con.inbox, 'markers');
  ok('新议程标记归属 n0/全新环节',
    newMsg.markers.at(-1).itemId === 'n0' && newMsg.markers.at(-1).itemName === '全新环节');
  ok('旧议程标记仍显示原归属 i0/i1 名称',
    newMsg.markers.some((m) => m.itemName === '开场致辞')
      && newMsg.markers.some((m) => m.itemName === '主题演讲'));
  ok('替换议程不改变标记顺序（按 monoMs 升序）',
    newMsg.markers.every((m, i, arr) => i === 0 || arr[i - 1].monoMs <= m.monoMs));

  console.log('11) 控制台重连：首包后重新申请即收到本场全部标记（整体替换）');
  con.ws.close();
  await sleep(200);
  const con2 = await connect();
  await next(con2.inbox, 'hello');
  await next(con2.inbox, 'snapshot');
  con2.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(con2.inbox, 'control');
  const reconnectMarkers = await next(con2.inbox, 'markers');
  ok('重连后标记条数一致', reconnectMarkers.markers.length === con.state.markers.length,
    `${reconnectMarkers.markers.length} vs ${con.state.markers.length}`);
  ok('重连后字段完整（seq/名称/归属/偏差/时刻）',
    reconnectMarkers.markers.every((m) =>
      Number.isInteger(m.seq) && m.name && m.wallMs > 0
      && (m.itemId === null || typeof m.itemName === 'string')
      && Number.isFinite(m.deviationMs)));

  console.log('12) 投屏全程未收到任何标记消息');
  await drain(display.inbox, 300);
  const leaked = display.inbox.filter((m) => m.type === 'markers');
  ok('投屏收件箱无 markers 消息', leaked.length === 0, `${leaked.length} 条`);

  // 清理
  try { display.ws.close(); } catch {}
  try { con2.ws.close(); } catch {}

  console.log(`\n现场标记测试：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('  ✗ 测试异常:', e);
  process.exitCode = 1;
} finally {
  child.kill();
}
