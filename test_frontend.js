/* 前端自动重算流程的端到端桩测试：极简 DOM + 可控 fetch / 定时器。 */
const fs = require("fs");
const vm = require("vm");

/* ---------- 断言 ---------- */
let pass = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  pass++;
}

/* ---------- 极简 DOM ---------- */
class El {
  constructor(tag) {
    this.tag = tag;
    this.classes = [];
    this.listeners = {};
    this.children = [];
    this.parent = null;
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this._text = "";
    this._html = "";
  }
  get classList() {
    return {
      contains: (c) => this.classes.includes(c),
      add: () => {},
      remove: () => {},
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = v;
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = v;
    if (v === "") this.children = [];
  }
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  dispatch(t, ev) {
    for (const fn of this.listeners[t] || []) fn(ev || { target: this });
  }
  insertAdjacentHTML(_pos, html) {
    const row = instantiateRow(html);
    row.parent = this;
    this.children.push(row);
  }
  _descendants() {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    const cls = sel.replace(/^\./, "");
    if (sel.startsWith("#")) return byId[sel.slice(1)] || null;
    return this._descendants().find((e) => e.classes.includes(cls)) || null;
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, "");
    if (sel.startsWith("#")) {
      const e = byId[sel.slice(1)];
      return e ? [e] : [];
    }
    return this._descendants().filter((e) => e.classes.includes(cls));
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  closest(sel) {
    const cls = sel.replace(/^\./, "");
    let cur = this;
    while (cur) {
      if (cur.classes.includes(cls)) return cur;
      cur = cur.parent;
    }
    return null;
  }
}

function instantiateRow(html) {
  const top = html.match(/<(?:div|tr)[^>]*class="([\w-]+)"/);
  const row = new El("div");
  row.classes = [top[1]];
  const classesOf = (tag) => ((tag.match(/class="([^"]*)"/) || [])[1] || "").split(/\s+/).filter(Boolean);
  const add = (el) => {
    el.parent = row;
    row.children.push(el);
  };
  for (const m of html.matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    const el = new El("input");
    el.classes = classesOf(tag);
    const v = tag.match(/value="([^"]*)"/);
    if (v) el.value = v[1];
    add(el);
  }
  const sel = html.match(/<select class="([\w-]+)"/);
  if (sel) {
    const el = new El("select");
    el.classes = [sel[1]];
    add(el);
  }
  for (const m of html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)) {
    const tag = m[0];
    const el = new El("button");
    el.classes = classesOf(tag);
    if (/\shidden/.test(tag)) el.hidden = true;
    add(el);
  }
  for (const m of html.matchAll(/<span class="([\w-]+)">/g)) {
    const el = new El("span");
    el.classes = [m[1]];
    add(el);
  }
  return row;
}

const byId = {};
function makeEl(id, tag = "div", value) {
  const el = new El(tag);
  el.id = id;
  if (value !== undefined) el.value = value;
  byId[id] = el;
  return el;
}

const ids = [
  ["runner-rows"], ["record-rows"], ["add-runner", "button"], ["add-record", "button"],
  ["record-count"], ["judge-form", "form"], ["error-box", "div", undefined, true],
  ["status-hint", "div", undefined, true], ["results"],
  ["submit-btn", "button"], ["sample-btn", "button"], ["clear-btn", "button"],
  ["smMin", "input", "10"], ["smMax", "input", "60"], ["mfMin", "input", "10"],
  ["mfMax", "input", "60"],
];
for (const [id, tag, v, initiallyHidden] of ids) {
  const el = makeEl(id, tag, v);
  if (initiallyHidden) el.hidden = true;
}

const document = { getElementById: (id) => byId[id] };

/* ---------- 可控定时器 ---------- */
let timers = [];
let timerSeq = 0;
const sandboxSetTimeout = (fn) => {
  const id = ++timerSeq;
  timers.push({ id, fn });
  return id;
};
const sandboxClearTimeout = (id) => {
  timers = timers.filter((t) => t.id !== id);
};
function flushTimers() {
  const due = timers;
  timers = [];
  for (const t of due) t.fn();
}
const tick = () => new Promise((r) => setImmediate(r));

/* ---------- 可控 fetch ---------- */
const pending = [];
let fetchCount = 0;
let ignoreAbort = false;

class Signal {
  constructor() {
    this.aborted = false;
    this.ls = [];
  }
  addEventListener(_t, fn) {
    if (this.aborted) fn();
    else this.ls.push(fn);
  }
}
class AbortController {
  constructor() {
    this.signal = new Signal();
  }
  abort() {
    this.signal.aborted = true;
    for (const fn of this.signal.ls) fn();
  }
}

const fetchMock = (url, opts) =>
  new Promise((resolve, reject) => {
    const req = { url, body: JSON.parse(opts.body) };
    fetchCount++;
    opts.signal.addEventListener("abort", () => {
      if (ignoreAbort) return; // 模拟“响应恰好在 abort 前后到达”的竞态
      req.aborted = true;
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
    req.respond = (status, payload) =>
      resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      });
    req.fail = (msg) => reject(new Error(msg || "network down"));
    pending.push(req);
  });

const sandbox = {
  document,
  setTimeout: sandboxSetTimeout,
  clearTimeout: sandboxClearTimeout,
  fetch: fetchMock,
  AbortController,
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + "/static/app.js", "utf8"), sandbox);

/* ---------- 便利方法 ---------- */
const form = byId["judge-form"];
const results = byId["results"];
const errorBox = byId["error-box"];
const statusHint = byId["status-hint"];
const runnerRowsEl = byId["runner-rows"];
const recordRowsEl = byId["record-rows"];

const edit = (el) => form.dispatch("input", { target: el });
const successBody = () => ({
  ok: true,
  result: {
    runners: [
      {
        runner: 101,
        lapCount: 1,
        totalTime: 25,
        laps: [
          {
            start: { id: "a", time: 0 },
            middle: { id: "b", time: 12 },
            finish: { id: "c", time: 25 },
            smTime: 12,
            mfTime: 13,
            totalTime: 25,
          },
        ],
        unused: [],
      },
    ],
  },
});
const hasResult = () => results.innerHTML.includes("result-card");

(async () => {
  /* 1. 首屏不请求、无结果、无错误 */
  ok(pending.length === 0 && fetchCount === 0, "首屏不发起任何请求");
  ok(!hasResult() && errorBox.hidden && statusHint.hidden, "首屏空白无提示");

  /* 2. 修改区间 → 防抖后自动请求，成功渲染 */
  byId.smMin.value = "11";
  edit(byId.smMin);
  ok(statusHint.hidden === false, "修改后立即显示重算提示");
  ok(pending.length === 0, "防抖窗口内暂未发请求");
  flushTimers();
  ok(pending.length === 1, "停顿后发出一次重算请求");
  ok(pending[0].body.standards.smMin === "11", "请求体携带当前完整输入");
  pending[0].respond(200, successBody());
  await tick();
  await tick();
  ok(hasResult() && statusHint.hidden, "成功响应更新结果并收起提示");
  const req1 = pending.shift();

  /* 3. 连续编辑合并：多次输入只发一个请求 */
  const before = fetchCount;
  byId.smMin.value = "12";
  edit(byId.smMin);
  byId.smMax.value = "55";
  edit(byId.smMax);
  byId.mfMin.value = "9";
  edit(byId.mfMin);
  ok(timers.length === 1, "连续编辑只保留一个待发任务");
  flushTimers();
  ok(fetchCount === before + 1, "合并后只发一次请求");

  /* 4. 等待期间仍可编辑：旧成功响应过期，不得覆盖新状态 */
  // 先消费测试 3 遗留的待发请求（其响应过期，不渲染）。
  flushTimers();
  const leftoverReq = pending.shift();
  leftoverReq.respond(200, successBody());
  await tick();
  await tick();
  // 模拟“服务端仍在处理、响应晚到”：忽略 abort，使多个请求并存于在途队列。
  ignoreAbort = true;
  form.dispatch("submit", { preventDefault() {} }); // 请求 A（旧输入）
  const staleReq = pending.shift();
  byId.smMax.value = "50"; // 等待期间继续编辑（防抖任务随后被立即提交取代）
  edit(byId.smMax);
  form.dispatch("submit", { preventDefault() {} }); // 请求 B（当前输入）
  const freshReq = pending.shift();
  staleReq.respond(200, successBody()); // A 晚到（成功）
  await tick();
  await tick();
  ok(!hasResult(), "过期成功响应不得渲染结果");
  ok(errorBox.hidden, "过期成功响应不得改动错误区");
  freshReq.respond(200, successBody());
  await tick();
  await tick();
  ok(hasResult() && statusHint.hidden, "当前请求成功后正常渲染");

  /* 5. 过期失败响应同样不得覆盖较新状态 */
  form.dispatch("submit", { preventDefault() {} });
  const staleFail = pending.shift();
  byId.smMax.value = "20";
  edit(byId.smMax);
  form.dispatch("submit", { preventDefault() {} });
  const freshOk = pending.shift();
  staleFail.fail("network down"); // 旧请求网络失败
  await tick();
  await tick();
  ok(errorBox.hidden && !hasResult(), "过期网络失败不得覆盖较新状态");
  freshOk.respond(200, successBody());
  await tick();
  await tick();
  ok(hasResult(), "新请求成功后恢复结果");
  ignoreAbort = false;

  /* 6. 非法输入：只显示错误、无结果；改回合法自动恢复 */
  byId.smMin.value = "999";
  edit(byId.smMin);
  flushTimers();
  pending.shift().respond(422, { ok: false, error: "起点至中途门区间下限不能大于上限" });
  await tick();
  await tick();
  ok(!errorBox.hidden && errorBox.textContent.includes("下限"), "非法输入显示中文错误");
  ok(!hasResult(), "非法输入不展示任何结果");
  byId.smMin.value = "10";
  edit(byId.smMin);
  flushTimers();
  pending.shift().respond(200, successBody());
  await tick();
  await tick();
  ok(errorBox.hidden && hasResult(), "改回合法值后自动恢复裁决，无需点按钮");

  /* 7. 增、删记录行都会自动重算（原先增行无任何提示） */
  const addBtn = byId["add-record"];
  addBtn.dispatch("click");
  ok(statusHint.hidden === false, "添加记录行立即触发重算流程");
  flushTimers();
  const addReq = pending.shift();
  ok(addReq.body.records.length === recordRowsEl.children.length, "新增行计入完整输入");
  addReq.respond(422, { ok: false, error: "第 12 条感应记录填写不完整" });
  await tick();
  await tick();
  ok(errorBox.textContent.includes("不完整"), "新增空行按非法输入报错");
  const lastRow = recordRowsEl.children[recordRowsEl.children.length - 1];
  const removeBtn = lastRow.querySelector(".remove-record");
  recordRowsEl.dispatch("click", { target: removeBtn });
  flushTimers();
  pending.shift().respond(200, successBody());
  await tick();
  await tick();
  ok(errorBox.hidden && hasResult(), "删除行后同样自动重算");

  /* 8. 删选手行也触发重算 */
  byId["add-runner"].dispatch("click");
  flushTimers();
  ok(pending.length === 1, "添加选手行触发重算");
  pending.shift().respond(422, { ok: false, error: "第 2 名选手编号不能为空" });
  await tick();
  await tick();
  ok(!errorBox.hidden, "空编号选手报错");
  const runner2 = runnerRowsEl.children[1];
  runnerRowsEl.dispatch("click", { target: runner2.querySelector(".remove-runner") });
  flushTimers();
  pending.shift().respond(200, successBody());
  await tick();
  await tick();
  ok(hasResult() && errorBox.hidden, "删除选手行后自动恢复");

  /* 9. 手动裁决按钮：不进防抖、立即发请求，按钮始终可用 */
  ok(byId["submit-btn"].disabled === false, "等待响应时裁决按钮不被禁用");
  byId.smMax.value = "70";
  edit(byId.smMax); // 留下一个待发防抖任务
  const beforeManual = fetchCount;
  form.dispatch("submit", { preventDefault() {} });
  ok(fetchCount === beforeManual + 1, "手动裁决立即发请求且不额外多发");
  ok(timers.length === 0, "手动裁决取消待发的防抖任务");
  pending.shift().respond(200, successBody());
  await tick();
  await tick();
  ok(hasResult(), "手动裁决渲染结果");

  /* 10. 填入示例自动重算 */
  byId["sample-btn"].dispatch("click");
  flushTimers();
  const sampleReq = pending.shift();
  ok(sampleReq.body.records.length === 11 && sampleReq.body.runners.length === 2, "载入示例提交完整输入");
  sampleReq.respond(200, successBody());
  await tick();
  await tick();
  ok(hasResult(), "示例载入后自动展示结果");

  /* 11. 清空：结果、错误、提示同时清除；在途请求被 abort；迟到响应不恢复 */
  byId.smMin.value = "5";
  edit(byId.smMin);
  flushTimers();
  const inFlightReq = pending.shift();
  ok(inFlightReq.aborted === undefined, "请求发出时尚未 abort");
  byId["clear-btn"].dispatch("click");
  await tick();
  ok(inFlightReq.aborted === true, "清空时作废在途请求");
  ok(!hasResult() && errorBox.hidden && statusHint.hidden, "清空同时清掉结果与错误");
  ok(timers.length === 0 && fetchCount > 0, "清空后不再补发请求");
  // 极端竞态：旧响应无视 abort 晚到
  ignoreAbort = true;
  byId.smMin.value = "7";
  edit(byId.smMin);
  flushTimers();
  const lateReq = pending.shift();
  byId["clear-btn"].dispatch("click");
  await tick();
  lateReq.respond(200, successBody());
  await tick();
  await tick();
  ok(!hasResult() && errorBox.hidden && statusHint.hidden, "清空后迟到的旧成功响应不恢复任何内容");
  lateReq; // eslint-disable-line no-unused-expressions

  /* 12. 清空后重新编辑仍可自动重算 */
  byId.smMin.value = "10";
  byId.smMax.value = "60";
  byId.mfMin.value = "10";
  byId.mfMax.value = "60";
  const firstRunner = runnerRowsEl.querySelector(".runner-number");
  firstRunner.value = "101";
  edit(firstRunner);
  flushTimers();
  pending.shift().respond(200, {
    ok: true,
    result: { runners: [{ runner: 101, lapCount: 0, totalTime: 0, laps: [], unused: [] }] },
  });
  await tick();
  await tick();
  ok(hasResult() && errorBox.hidden, "清空后重新编辑可自动恢复裁决");

  /* 13. 全空输入不请求也不报错（如把所有内容删空） */
  for (const id of ["smMin", "smMax", "mfMin", "mfMax"]) byId[id].value = "";
  firstRunner.value = "";
  edit(firstRunner);
  ok(timers.length === 0, "全空输入不调度请求");
  ok(!hasResult() && errorBox.hidden && statusHint.hidden, "全空输入回到空白态");

  /* 14. 部分填写（区间有值、选手为空）视为非法，照常请求并显示错误 */
  byId.smMin.value = "10";
  edit(byId.smMin);
  flushTimers();
  ok(pending.length === 1, "部分填写仍会发起重算");
  pending.shift().respond(422, { ok: false, error: "选手人数必须为 1～3 名" });
  await tick();
  await tick();
  ok(!errorBox.hidden && !hasResult(), "部分填写只显示错误");

  console.log(`ALL FRONTEND TESTS PASSED (${pass} assertions)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
