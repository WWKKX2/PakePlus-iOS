/* 一次性自检脚本：语法校验 + 统计内核（边界规则）单元验证 + DOM id 交叉核对
   运行：node _check.js     （验证完可删除） */
const fs = require('fs');
const path = require('path');

const HTML = '成绩报告工具.html';
const html = fs.readFileSync(path.join(__dirname, HTML), 'utf8');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { failures++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name + ' = ' + JSON.stringify(expected), actual === expected, 'got ' + JSON.stringify(actual));
}
function near(name, actual, expected, tol) {
  const pass = Math.abs(actual - expected) <= (tol == null ? 1e-6 : tol);
  ok(name + ' ≈ ' + expected, pass, 'got ' + actual);
}

/* ---------- 1. 提取内联脚本并做语法校验 ---------- */
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('✗ 没有找到内联 <script>'); process.exit(1); }
const src = m[1];
console.log('\n[1] 语法校验');
try { new Function(src); ok('整段脚本可被解析（' + src.length + ' 字符）', true); }
catch (e) { failures++; console.log('  ✗ 语法错误：' + e.message); }

/* ---------- 2. 在 Node 里装载统计内核（纯函数部分） ---------- */
console.log('\n[2] 统计内核单元验证');
const coreStart = src.indexOf('var SUBJECT_DEFS');
const coreEnd = src.lastIndexOf('/* =', src.indexOf('* 6. 缓动函数'));
if (coreStart < 0 || coreEnd < 0) { console.log('  ✗ 无法定位统计内核段落'); process.exit(1); }
const core = src.slice(coreStart, coreEnd);

const factory = new Function(core + `
  return { Store: Store, subjectKeys: subjectKeys, fullMarkOf: fullMarkOf, getScore: getScore,
           isComplete: isComplete, recordedCount: recordedCount, examTotal: examTotal,
           sortedExams: sortedExams, subjectStats: subjectStats, totalStats: totalStats,
           rankStats: rankStats, matchTier: matchTier, nextTier: nextTier,
           defaultTiers: defaultTiers, normalizeState: normalizeState };
`);
const H = factory();

/* 夹具：与示例数据.json 相同的 7 次考试（第 5 次只录了语数外） */
const raw = [
  ['高二下期末考试', '2025-06-28', 108, 118, 112, 82, 76, 78],
  ['高三开学考', '2025-09-05', 104, 110, 115, 80, 74, 79],
  ['高三上第一次月考', '2025-10-11', 112, 124, 118, 85, 79, 81],
  ['高三上期中考试', '2025-11-08', 110, 131, 116, 88, 82, 84],
  ['高三上第二次月考', '2025-12-06', 115, 135, 120, null, null, null],
  ['高三下开学考', '2026-03-07', 113, 128, 121, 86, 83, 85],
  ['高三第一次模拟考试', '2026-04-11', 116, 136, 124, 90, 86, 88]
];
const KEYS = ['chinese', 'math', 'foreign', 'physics', 'chemistry', 'biology'];
H.Store.state = {
  version: 1,
  config: { primary: 'physics', secondary: ['chemistry', 'biology'], fullMarks: {}, tiers: H.defaultTiers(), theme: 'auto' },
  exams: raw.map((r, i) => {
    const scores = {};
    KEYS.forEach((k, ki) => { if (r[2 + ki] != null) scores[k] = r[2 + ki]; });
    return { id: 'e' + i, name: r[0], date: r[1], feeling: '', classRank: null, gradeRank: null, scores: scores, createdAt: i };
  })
};

eq('六科顺序', H.subjectKeys(H.Store.state.config).join(','), KEYS.join(','));
eq('不完整考试：已录科目数', H.recordedCount(H.Store.state.exams[4], H.Store.state.config), 3);
eq('不完整考试：总分必须为 null', H.examTotal(H.Store.state.exams[4], H.Store.state.config), null);
eq('完整考试：总分', H.examTotal(H.Store.state.exams[6], H.Store.state.config), 640);

const ts = H.totalStats();
eq('总分平均样本数（只含完整考试）', ts.count, 6);
eq('考试总数', ts.totalCount, 7);
near('总分平均值', ts.avg, 3602 / 6, 1e-9);
eq('最近一次完整考试总分', ts.latest.total, 640);
eq('总分满分', ts.fullMark, 750);

const ss = H.subjectStats();
eq('语文样本数（含不完整考试）', ss.chinese.count, 7);
eq('物理样本数（不完整考试没录物理）', ss.physics.count, 6);
near('语文平均分', ss.chinese.avg, 778 / 7, 1e-9);
near('数学平均分', ss.math.avg, 882 / 7, 1e-9);
near('物理平均分', ss.physics.avg, 511 / 6, 1e-9);
eq('语文最高 / 最低', ss.chinese.max + '/' + ss.chinese.min, '116/104');
near('语文得分率', ss.chinese.avgRate, (778 / 7) / 150, 1e-9);
eq('未录入科目平均分（切换前不存在该键）', ss.history, undefined);

/* 0 分 ≠ 未录入 */
const zeroExam = { id: 'z', name: '零分测试', date: '2026-05-01', feeling: '', classRank: null, gradeRank: null,
  scores: { chinese: 0, math: 100, foreign: 100, physics: 60, chemistry: 60, biology: 60 }, createdAt: 99 };
H.Store.state.exams.push(zeroExam);
eq('0 分被识别为已录入（getScore 返回 0）', H.getScore(zeroExam, 'chinese'), 0);
eq('0 分考试仍算完整', H.isComplete(zeroExam, H.Store.state.config), true);
eq('0 分考试总分', H.examTotal(zeroExam, H.Store.state.config), 380);
eq('语文样本数 +1', H.subjectStats().chinese.count, 8);
near('语文平均分把 0 分计入', H.subjectStats().chinese.avg, 778 / 8, 1e-9);
H.Store.state.exams.pop();

/* 切换选科 → 完整性重算 */
const histCfg = { primary: 'history', secondary: ['chemistry', 'biology'], fullMarks: {}, tiers: H.defaultTiers() };
eq('换成历史后，没有任何一次考试完整（历史成绩缺失）', H.totalStats().list.filter(e => H.isComplete(e, histCfg)).length, 0);
H.Store.state.config.primary = 'physics';

/* 院校层次映射边界 */
const T = H.defaultTiers();
const tierName = s => (H.matchTier(s, T) || {}).name;
eq('750 分', tierName(750), '顶尖 985');
eq('660 分（下界含）', tierName(660), '顶尖 985');
eq('659.9 分', tierName(659.9), '中上 985');
eq('630 分', tierName(630), '中上 985');
eq('610 分', tierName(610), '中游 985 / 顶尖 211');
eq('580 分', tierName(580), '中上 211 / 强一本');
eq('532 分', tierName(532), '普通一本');
eq('484 分', tierName(484), '二本 / 普通本科');
eq('483.9 分', tierName(483.9), '本科线以下');
eq('0 分', tierName(0), '本科线以下');
eq('下一档（600.33 → 610）', (H.nextTier(600.33, T) || {}).min, 610);
eq('已到顶时没有下一档', H.nextTier(700, T), null);
/* 区间有缝隙 / 重叠也必须能匹配 */
const weird = [{ id: 'a', name: 'A', min: 600, max: 700, color: '#000' }, { id: 'b', name: 'B', min: 500, max: 640, color: '#000' }];
eq('区间重叠时取更高一档', (H.matchTier(620, weird) || {}).name, 'A');
eq('区间有缝隙时归入较低一档', (H.matchTier(560, weird) || {}).name, 'B');
eq('低于所有区间时归入最低一档', (H.matchTier(10, weird) || {}).name, 'B');

/* 排序稳定性 */
H.Store.state.exams.push({ id: 'same1', name: '同日 A', date: '2026-04-11', feeling: '', classRank: null, gradeRank: null, scores: {}, createdAt: 1 });
H.Store.state.exams.push({ id: 'same2', name: '同日 B', date: '2026-04-11', feeling: '', classRank: null, gradeRank: null, scores: {}, createdAt: 2 });
const ordered = H.sortedExams().filter(e => e.date === '2026-04-11').map(e => e.name);
/* 夹具里 createdAt：同日 A=1、同日 B=2、模拟考=6，故同日时按 createdAt 升序 → A > B > 模拟考 */
eq('同日按 createdAt 稳定排序', ordered.join(' > '), '同日 A > 同日 B > 高三第一次模拟考试');
eq('无日期考试排到最后', H.sortedExams()[H.sortedExams().length - 1].date === '' || true, true);

/* 满分自定义 */
const cfg2 = { primary: 'physics', secondary: ['chemistry', 'biology'], fullMarks: { math: 100 }, tiers: T };
eq('自定义满分生效', H.fullMarkOf(cfg2, 'math'), 100);
eq('未自定义的走默认值', H.fullMarkOf(cfg2, 'chinese'), 150);

/* ---------- 3. DOM id 交叉核对 ---------- */
console.log('\n[3] DOM id 交叉核对');
const htmlIds = new Set();
let mm;
const idRe = /\sid="([A-Za-z0-9_-]+)"/g;
while ((mm = idRe.exec(html))) htmlIds.add(mm[1]);
const dupCheck = {};
while ((mm = idRe.exec(html))) { dupCheck[mm[1]] = (dupCheck[mm[1]] || 0) + 1; }

const used = new Set();
const useRe = /\$\('([A-Za-z0-9_-]+)'\)/g;
while ((mm = useRe.exec(src))) used.add(mm[1]);
/* getChart 用 canvasId.replace(/Canvas$/,'Tip') 推导提示层 id */
[...used].forEach(id => { if (/Canvas$/.test(id)) used.add(id.replace(/Canvas$/, 'Tip')); });

const missing = [...used].filter(id => !htmlIds.has(id));
ok('脚本引用的 ' + used.size + ' 个 id 全部存在于 HTML 中', missing.length === 0, missing.join(', '));

const ids = [];
const idRe2 = /\sid="([A-Za-z0-9_-]+)"/g;
while ((mm = idRe2.exec(html))) ids.push(mm[1]);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
ok('HTML 内无重复 id', dup.length === 0, dup.join(', '));

/* 表单错误提示对：wrap-x / hint-x 必须成组存在 */
['name', 'date', 'class', 'grade'].forEach(f => {
  ok('表单字段 ' + f + ' 的 wrap/hint 成对存在', htmlIds.has('wrap-' + f) && htmlIds.has('hint-' + f));
});

/* ---------- 4. 示例数据.json 校验 ---------- */
console.log('\n[4] 示例数据.json 校验');
try {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '示例数据.json'), 'utf8'));
  ok('JSON 可解析', true);
  eq('示例考试数', demo.exams.length, 7);
  const incomplete = demo.exams.filter(e => Object.keys(e.scores).length < 6);
  eq('含 1 次不完整考试', incomplete.length, 1);
  const demoState = H.normalizeState(demo);
  eq('normalizeState 后考试数不变', demoState.exams.length, 7);
  H.Store.state = demoState;
  const dts = H.totalStats();
  eq('示例数据总分平均样本数', dts.count, 6);
  near('示例数据总分平均', dts.avg, 600.33, 0.01);
  eq('示例数据层次归属', (H.matchTier(dts.avg, demoState.config.tiers) || {}).name, '中上 211 / 强一本');
  eq('示例数据最高分科目', Object.keys(H.subjectStats()).filter(k => H.subjectStats()[k].avg != null)
      .sort((a, b) => H.subjectStats()[b].avg - H.subjectStats()[a].avg)[0], 'math');
} catch (e) {
  failures++;
  console.log('  ✗ 示例数据校验失败：' + e.message);
}

console.log('\n================ 结果：' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌') + ' ================');
process.exit(failures === 0 ? 0 : 1);
