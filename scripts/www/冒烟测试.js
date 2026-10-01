/* 无头冒烟测试：用轻量 DOM 桩把 成绩报告工具.html 的脚本真正跑起来，
   走完 概览渲染 / 录入 / 编辑 / 删除 / 选科切换 / 导入 / 导出 / 清空 全流程，捕获运行期异常。 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '成绩报告工具.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const demoJson = fs.readFileSync(path.join(__dirname, '示例数据.json'), 'utf8');

let failures = 0;
function step(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) {
    failures++;
    console.log('  ✗ ' + name + '  →  ' + e.message);
    console.log(String(e.stack || '').split('\n').slice(1, 4).map(s => '      ' + s.trim()).join('\n'));
  }
}
function ok(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ============================ DOM 桩 ============================ */
let rafId = 0, fakeNow = 0;
const created = [];

function ctxStub() {
  const t = {
    canvas: {},
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 12 })
  };
  return new Proxy(t, { get(o, k) { return (k in o) ? o[k] : function () {}; }, set() { return true; } });
}

function El(tag) {
  const el = {
    tagName: tag || 'div', id: '', className: '', innerHTML: '', textContent: '',
    checked: false, hidden: false, disabled: false, title: '', type: '',
    style: {}, dataset: {}, children: [], _attrs: {}, _ls: {},
    clientWidth: 640, clientHeight: 320, offsetWidth: 640, offsetHeight: 180, scrollHeight: 180, scrollLeft: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, f) { const on = (f === undefined) ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; }
    },
    addEventListener(t, f) { this._ls[t] = f; }, removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; c.parentElement = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 32 }; },
    scrollIntoView() {}, focus() {}, select() {}, click() {}, blur() {},
    getContext() { return ctxStub(); },
    trigger(t, ev) { if (this._ls[t]) this._ls[t](ev || { target: this }); }
  };
  /* 像浏览器一样，给 input.value 赋值时统一转成字符串 */
  let _v = '';
  Object.defineProperty(el, 'value', {
    get() { return _v; },
    set(x) { _v = (x == null) ? '' : String(x); },
    enumerable: true
  });
  created.push(el);
  return el;
}

const byId = new Map();
const VIEWS = ['dashboard', 'input', 'records', 'charts', 'stats', 'settings'];
const viewsStub = VIEWS.map(v => {
  const e = El('section');
  e.setAttribute('data-view', v);
  e.querySelector = s => (s === '.stagger' ? El('div') : null);
  return e;
});
const tabsStub = VIEWS.map((v, i) => {
  const e = El('button');
  e.setAttribute('data-view', v);
  e.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
  return e;
});

const documentStub = {
  readyState: 'complete', visibilityState: 'visible',
  documentElement: El('html'), body: El('body'),
  getElementById(id) { if (!byId.has(id)) { const e = El('div'); e.id = id; byId.set(id, e); } return byId.get(id); },
  createElement(t) { return El(t); },
  addEventListener() {}, removeEventListener() {},
  querySelector(sel) {
    if (sel.indexOf('.tab[') === 0) return tabsStub[0];
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.view') return viewsStub;
    if (sel === '.tab') return tabsStub;
    return [];
  }
};
const localStorageStub = {
  _d: {},
  getItem(k) { return (k in this._d) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
const windowStub = {
  localStorage: localStorageStub,
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {}, removeEventListener() {}, scrollTo() {}
};
const computed = {
  '--accent': '#0A84FF', '--font': 'sans-serif', '--text': '#111', '--text-2': '#555', '--text-3': '#999',
  '--grid': '#dddddd', '--grid-soft': '#eeeeee', '--card-strong': '#ffffff'
};
const getComputedStyleStub = () => ({ getPropertyValue: n => computed[n] || '' });

/* requestAnimationFrame：用"跳跃式假时钟"同步跑完一帧，既能执行到绘制代码又不会无限递归 */
const requestAnimationFrameStub = cb => { fakeNow += 900; const id = ++rafId; cb(fakeNow); return id; };

class FileReaderStub {
  readAsText() { this.result = FileReaderStub.text; if (this.onload) this.onload(); }
}
FileReaderStub.text = '';
class BlobStub { constructor(parts) { this.parts = parts; this.size = String(parts[0] || '').length; } }
const URLStub = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };

/* ============================ 装载应用 ============================ */
console.log('\n[1] 启动');
let H = null;
step('执行整段脚本（含 boot()）', () => {
  /* 剥掉 IIFE 外壳，把内部函数暴露出来（避免在 return 上踩 ASI 的坑） */
  const open = src.indexOf('{');
  const close = src.lastIndexOf('})();');
  if (open < 0 || close < 0) throw new Error('未能定位 IIFE 结构');
  const inner = src.slice(open + 1, close);
  const factory = new Function(
    'document', 'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
    'Blob', 'URL', 'FileReader', 'ResizeObserver',
    inner + `
    return {
      Store: Store, uiState: uiState,
      switchView: switchView, renderView: renderView, refresh: refresh,
      saveExam: saveExam, editExam: editExam, deleteExam: deleteExam, resetForm: resetForm,
      updateFormStatus: updateFormStatus, renderScoreGrid: renderScoreGrid,
      onSubjectSelectChange: onSubjectSelectChange, saveTierEditor: saveTierEditor, addTierRow: addTierRow,
      loadDemo: loadDemo, resetAll: resetAll, exportJSON: exportJSON, handleImportFile: handleImportFile,
      cycleTheme: cycleTheme, flushState: flushState, loadState: loadState,
      examTotal: examTotal, subjectStats: subjectStats, totalStats: totalStats,
      isComplete: isComplete, subjectKeys: subjectKeys, matchTier: matchTier, nextTier: nextTier,
      sortedExams: sortedExams, buildLineData: buildLineData, buildRadarData: buildRadarData,
      examCardHtml: examCardHtml, tierPanelHtml: tierPanelHtml
    };`
  );
  H = factory(
    documentStub, windowStub, { now: () => fakeNow }, requestAnimationFrameStub, () => {}, getComputedStyleStub,
    BlobStub, URLStub, FileReaderStub, undefined
  );
});
ok('boot() 渲染了概览指标卡', byId.get('dashStats') && byId.get('dashStats').innerHTML.indexOf('总分平均') >= 0);
ok('boot() 渲染了层次参考卡（空状态）', byId.get('dashTier').innerHTML.indexOf('还没有可用于参考的总分') >= 0);
ok('品牌栏显示六科', byId.get('brandSub').textContent.indexOf('语文') >= 0);
ok('雷达图与折线图画布已注册数据', byId.get('dashRadarCanvas').width > 0 && byId.get('dashTrendCanvas').width > 0);

console.log('\n[2] 载入示例数据');
step('loadDemo()（空数据时直接应用）', () => H.loadDemo());
ok('示例考试 7 次', H.Store.state.exams.length === 7);
ok('总分平均基于 6 次完整考试', H.totalStats().count === 6);
ok('语文样本 7 次（含未录满那次）', H.subjectStats().chinese.count === 7);
ok('物理样本 6 次', H.subjectStats().physics.count === 6);
ok('层次参考卡显示"中上 211 / 强一本"', byId.get('dashTier').innerHTML.indexOf('中上 211 / 强一本') >= 0);
H.flushState();   // 防抖写入是异步的，这里直接落盘再断言
ok('写入 localStorage', JSON.parse(localStorageStub.getItem('hs-grade-report-v1')).exams.length === 7);

console.log('\n[3] 六个视图逐个渲染（图表绘制全部执行）');
VIEWS.forEach(v => step('renderView(' + v + ')', () => H.switchView(v)));
ok('成绩视图按考试渲染出卡片', byId.get('recordsBody').innerHTML.indexOf('exam-card') >= 0);
ok('按科目视图可渲染', (() => { H.uiState.recordsTab = 'subject'; H.renderView('records'); return byId.get('recordsBody').innerHTML.indexOf('历次成绩') >= 0; })());
ok('图表视图折线科目 chip 渲染', byId.get('lineChips').innerHTML.indexOf('data-line-key') >= 0);
ok('统计视图单科平均表渲染', byId.get('statSubjectTable').innerHTML.indexOf('平均分') >= 0);
ok('设置视图层次编辑器渲染', byId.get('tierEditor').innerHTML.indexOf('tier-edit-row') >= 0);
ok('设置视图满分输入渲染', byId.get('fullMarkGrid').innerHTML.indexOf('data-fullmark') >= 0);
ok('雷达图三种数据源都能渲染', ['latest', 'exam', 'avg'].every(m => {
  H.uiState.radarMode = m; H.renderView('charts'); return true;
}));

console.log('\n[4] 录入（完整六科 / 不完整 / 校验）');
/* 通过 scoreGrid 的 input 事件模拟输入：grid 桩的 _ls.input 由 bindEvents 注册 */
function typeScores(scores) {
  H.resetForm();
  const grid = byId.get('scoreGrid');
  Object.keys(scores).forEach(k => {
    const inp = El('input');
    inp.setAttribute('data-score', k);
    inp.value = String(scores[k]);
    grid.trigger('input', { target: inp });
  });
}
step('不完整考试：只录语数外也能保存', () => {
  H.resetForm();
  typeScores({ chinese: 111, math: 122, foreign: 133 });
  byId.get('f-name').value = '冒烟-未录满';
  byId.get('f-date').value = '2026-05-20';
  byId.get('f-class').value = '';
  byId.get('f-grade').value = '';
  H.saveExam();
});
ok('考试数 +1', H.Store.state.exams.length === 8);
ok('不完整考试总分为 null', H.examTotal(H.Store.state.exams[7], H.Store.state.config) === null);
ok('总分平均样本数不变（仍 6）', H.totalStats().count === 6);
ok('语文样本数变成 8（该次已录科目仍计入）', H.subjectStats().chinese.count === 8);
ok('该次考试卡片带"已录 3/6 科"标记', H.examCardHtml(H.Store.state.config, H.Store.state.exams[7], false).indexOf('已录 3/6 科') >= 0);

step('完整考试：六科齐全自动算总分', () => {
  H.resetForm();
  typeScores({ chinese: 120, math: 140, foreign: 130, physics: 92, chemistry: 90, biology: 91 });
  byId.get('f-name').value = '冒烟-完整';
  byId.get('f-date').value = '2026-05-21';
  byId.get('f-class').value = '2';
  byId.get('f-grade').value = '20';
  H.saveExam();
});
ok('考试数 9', H.Store.state.exams.length === 9);
ok('总分 = 663', H.examTotal(H.Store.state.exams[8], H.Store.state.config) === 663);
ok('总分平均样本数变成 7', H.totalStats().count === 7);
ok('663 分匹配到"顶尖 985"', (H.matchTier(663, H.Store.state.config.tiers) || {}).name === '顶尖 985');

step('名称为空时应拦截，不新增记录', () => {
  const before = H.Store.state.exams.length;
  H.resetForm();
  typeScores({ chinese: 100 });
  byId.get('f-name').value = '';
  byId.get('f-date').value = '2026-05-22';
  H.saveExam();
  if (H.Store.state.exams.length !== before) throw new Error('非法数据被写入了');
});
step('分数超过满分时应拦截', () => {
  const before = H.Store.state.exams.length;
  H.resetForm();
  typeScores({ chinese: 400 });
  byId.get('f-name').value = '超分测试';
  byId.get('f-date').value = '2026-05-23';
  H.saveExam();
  if (H.Store.state.exams.length !== before) throw new Error('超满分数据被写入了');
});

console.log('\n[5] 编辑与删除');
const targetId = H.Store.state.exams[8].id;
step('editExam() 载入表单', () => H.editExam(targetId));
ok('表单回填了名称', byId.get('f-name').value === '冒烟-完整');
ok('表单回填了六科分数', byId.get('scoreGrid').innerHTML.indexOf('data-score') >= 0);
step('改名后保存', () => {
  byId.get('f-name').value = '冒烟-已改名';
  H.saveExam();
});
ok('名称已更新', H.Store.state.exams.filter(e => e.id === targetId)[0].name === '冒烟-已改名');
step('deleteExam() 弹出确认框并点确认', () => {
  H.deleteExam(targetId);
  created[created.length - 1].trigger('click');       // 确认按钮
});
ok('记录已删除', H.Store.state.exams.filter(e => e.id === targetId).length === 0);
ok('删除后考试数 8', H.Store.state.exams.length === 8);

console.log('\n[6] 选科切换（含影响提示）');
step('改为 历史 + 政治 + 地理 并确认', () => {
  byId.get('cfgPrimary').value = 'history';
  byId.get('cfgSec1').value = 'politics';
  byId.get('cfgSec2').value = 'geography';
  H.onSubjectSelectChange();
  created[created.length - 1].trigger('click');
});
ok('首选变为 history', H.Store.state.config.primary === 'history');
ok('再选变为 politics + geography', H.Store.state.config.secondary.join(',') === 'politics,geography');
ok('六科顺序随之更新', H.subjectKeys(H.Store.state.config).join(',') === 'chinese,math,foreign,history,politics,geography');
ok('没有历史成绩 → 完整考试变为 0', H.totalStats().count === 0);
ok('旧科目数据仍保留在底层（物理分数没被删）', H.Store.state.exams.some(e => e.scores.physics != null));
step('切回 物理 + 化学 + 生物', () => {
  byId.get('cfgPrimary').value = 'physics';
  byId.get('cfgSec1').value = 'chemistry';
  byId.get('cfgSec2').value = 'biology';
  H.onSubjectSelectChange();
  created[created.length - 1].trigger('click');
});
ok('切回后完整考试恢复为 6 次（示例里那 1 次未录满的仍不算）', H.totalStats().count === 6);

console.log('\n[7] 导入 / 导出 / 主题 / 清空');
step('导入 示例数据.json（走 FileReader）', () => {
  FileReaderStub.text = demoJson;
  H.handleImportFile({ name: '示例数据.json' });
  created[created.length - 1].trigger('click');       // 确认"替换并导入"
});
ok('导入后 7 次考试', H.Store.state.exams.length === 7);
ok('导入后层次归属正确', (H.matchTier(H.totalStats().avg, H.Store.state.config.tiers) || {}).name === '中上 211 / 强一本');
step('导出 JSON（Blob + a.click）', () => H.exportJSON());
step('主题循环 3 次回到 auto', () => { H.cycleTheme(); H.cycleTheme(); H.cycleTheme(); });
ok('主题回到 auto', H.Store.state.config.theme === 'auto');
step('落盘 flushState()', () => H.flushState());
ok('localStorage 内容与内存一致', JSON.parse(localStorageStub.getItem('hs-grade-report-v1')).exams.length === 7);
step('从 localStorage 重新载入 loadState()', () => H.loadState());
ok('重新载入后仍是 7 次考试', H.Store.state.exams.length === 7);
step('清空全部数据并确认', () => {
  H.resetAll();
  created[created.length - 1].trigger('click');
});
ok('已清空', H.Store.state.exams.length === 0);
ok('清空后回到空状态文案', (() => { H.renderView('dashboard'); return byId.get('dashRecent').innerHTML.indexOf('还没有任何考试记录') >= 0; })());

console.log('\n================ 冒烟测试：' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌') + ' ================');
process.exit(failures === 0 ? 0 : 1);
