"use strict";

const MAX_RUNNERS = 3;
const MAX_RECORDS = 40;
const GATE_LABELS = { S: "起点 S", M: "中途门 M", F: "终点 F" };
// 连续编辑合并窗口：停顿该毫秒数后才发出重算请求。
const RECOMPUTE_DELAY = 300;

const runnerRows = document.getElementById("runner-rows");
const recordRows = document.getElementById("record-rows");
const addRunnerBtn = document.getElementById("add-runner");
const addRecordBtn = document.getElementById("add-record");
const recordCount = document.getElementById("record-count");
const form = document.getElementById("judge-form");
const errorBox = document.getElementById("error-box");
const statusHint = document.getElementById("status-hint");
const resultsBox = document.getElementById("results");
const submitBtn = document.getElementById("submit-btn");

/* ---------- 行管理 ---------- */

function runnerRowHtml(index, value = "") {
  return `
    <div class="runner-row" data-index="${index}">
      <span class="row-index">选手 ${index}</span>
      <input type="number" min="1" step="1" class="runner-number" value="${escapeAttr(value)}" placeholder="正整数编号" />
      <button type="button" class="btn danger remove-runner" ${index === 1 ? "hidden" : ""}>删除</button>
    </div>`;
}

function recordRowHtml() {
  return `
    <tr class="record-row">
      <td><input type="text" class="rec-id" placeholder="唯一 ID" /></td>
      <td><input type="number" min="1" step="1" class="rec-runner" placeholder="选手编号" /></td>
      <td>
        <select class="rec-gate">
          <option value="">选择门</option>
          <option value="S">S 起点</option>
          <option value="M">M 中途门</option>
          <option value="F">F 终点</option>
        </select>
      </td>
      <td><input type="number" min="0" step="1" class="rec-time" placeholder="非负秒" /></td>
      <td><button type="button" class="btn danger remove-record">×</button></td>
    </tr>`;
}

function addRunnerRow(value) {
  if (runnerRows.children.length >= MAX_RUNNERS) return;
  runnerRows.insertAdjacentHTML("beforeend", runnerRowHtml(runnerRows.children.length + 1, value));
  refreshRunnerButtons();
}

function refreshRunnerButtons() {
  [...runnerRows.children].forEach((row, i) => {
    row.dataset.index = i + 1;
    row.querySelector(".row-index").textContent = `选手 ${i + 1}`;
    const btn = row.querySelector(".remove-runner");
    btn.hidden = runnerRows.children.length === 1;
  });
  addRunnerBtn.disabled = runnerRows.children.length >= MAX_RUNNERS;
}

function addRecordRow() {
  if (recordRows.children.length >= MAX_RECORDS) return;
  recordRows.insertAdjacentHTML("beforeend", recordRowHtml());
  refreshRecordCount();
}

function refreshRecordCount() {
  recordCount.textContent = `${recordRows.children.length} / ${MAX_RECORDS}`;
  addRecordBtn.disabled = recordRows.children.length >= MAX_RECORDS;
}

addRunnerBtn.addEventListener("click", () => {
  addRunnerRow();
  requestRecompute(false);
});
addRecordBtn.addEventListener("click", () => {
  addRecordRow();
  requestRecompute(false);
});

runnerRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-runner")) {
    e.target.closest(".runner-row").remove();
    refreshRunnerButtons();
    requestRecompute(false);
  }
});
recordRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-record")) {
    e.target.closest(".record-row").remove();
    refreshRecordCount();
    requestRecompute(false);
  }
});

/* ---------- 输入驱动的自动重算 ----------
 *
 * 每次修改（输入、增删行、载入示例、手动裁决）都：
 *   1. 立即清空旧结果与旧错误；
 *   2. 令所有在途请求与待发任务作废（版本号 + AbortController）；
 *   3. 按当前完整输入重新裁决；连续编辑在防抖窗口内合并为一次请求。
 * 响应返回时只核对版本号：过期的成功/失败一律丢弃，不得覆盖较新状态。
 */

let stateVersion = 0;
let debounceTimer = null;
let inFlight = null; // { version, controller }

function clearOutputs() {
  resultsBox.innerHTML = "";
  errorBox.hidden = true;
  errorBox.textContent = "";
}

// 作废所有在途响应与待发计时，并立即清掉旧结果/旧错误。
function invalidate() {
  stateVersion += 1;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (inFlight) {
    inFlight.controller.abort();
    inFlight = null;
  }
  clearOutputs();
}

function isBlankInput() {
  const stdIds = ["smMin", "smMax", "mfMin", "mfMax"];
  if (stdIds.some((id) => document.getElementById(id).value.trim() !== "")) return false;
  if ([...runnerRows.querySelectorAll(".runner-number")].some((el) => el.value.trim() !== "")) {
    return false;
  }
  for (const row of recordRows.querySelectorAll(".record-row")) {
    const filled =
      row.querySelector(".rec-id").value.trim() !== "" ||
      row.querySelector(".rec-runner").value.trim() !== "" ||
      row.querySelector(".rec-gate").value !== "" ||
      row.querySelector(".rec-time").value.trim() !== "";
    if (filled) return false;
  }
  return true;
}

// immediate=true 时取消合并、立刻发请求（手动裁决按钮）；否则进入防抖窗口。
function requestRecompute(immediate) {
  invalidate();
  if (isBlankInput()) {
    // 全空输入（如点击“清空”后）：既不请求也不报错，回到初始空白态。
    statusHint.hidden = true;
    return;
  }
  statusHint.hidden = false;
  if (immediate) {
    sendRequest();
  } else {
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      sendRequest();
    }, RECOMPUTE_DELAY);
  }
}

form.addEventListener("input", () => requestRecompute(false));
form.addEventListener("change", () => requestRecompute(false));

/* ---------- 收集与提交 ---------- */

function collectPayload() {
  const runners = [...runnerRows.querySelectorAll(".runner-row")]
    .map((row) => row.querySelector(".runner-number").value.trim())
    .filter((v) => v !== "")
    .map((v) => ({ number: v }));

  const records = [...recordRows.querySelectorAll(".record-row")].map((row) => ({
    id: row.querySelector(".rec-id").value.trim(),
    runner: row.querySelector(".rec-runner").value.trim(),
    gate: row.querySelector(".rec-gate").value,
    time: row.querySelector(".rec-time").value.trim(),
  }));

  return {
    standards: {
      smMin: document.getElementById("smMin").value.trim(),
      smMax: document.getElementById("smMax").value.trim(),
      mfMin: document.getElementById("mfMin").value.trim(),
      mfMax: document.getElementById("mfMax").value.trim(),
    },
    runners,
    records,
  };
}

async function sendRequest() {
  const version = stateVersion;
  const controller = new AbortController();
  inFlight = { version, controller };
  statusHint.hidden = false;

  let applied = false;
  try {
    const resp = await fetch("/api/adjudicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload()),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => null);
    if (version !== stateVersion) return; // 已被更新的修改取代，丢弃（成功亦然）。
    applied = true;
    if (!resp.ok || !data || data.ok !== true) {
      // 非法输入：清空结果区，只显示错误（不展示部分结果）。
      resultsBox.innerHTML = "";
      showError((data && data.error) || "裁决失败");
    } else {
      errorBox.hidden = true;
      renderResults(data.result);
    }
  } catch (err) {
    if (err.name === "AbortError") return; // 主动作废的请求。
    if (version !== stateVersion) return; // 过期的网络失败同样不得覆盖较新状态。
    applied = true;
    resultsBox.innerHTML = "";
    showError(`无法连接裁决服务：${err.message}`);
  } finally {
    if (inFlight && inFlight.version === version) inFlight = null;
    // 只有真正对当前输入生效的响应才能收起提示；过期响应交给更新的请求处理。
    if (applied && version === stateVersion) statusHint.hidden = true;
  }
}

// 手动裁决：立即按当前输入重算，无需等待防抖窗口。
form.addEventListener("submit", (e) => {
  e.preventDefault();
  requestRecompute(true);
});

function showError(msg) {
  errorBox.textContent = `⚠ ${msg}`;
  errorBox.hidden = false;
}

/* ---------- 结果渲染 ---------- */

function gateChip(gate, id, time) {
  return `<span class="chip ${gate}">
    <span class="chip-id">${escapeHtml(id)}</span>
    <span class="chip-t">${GATE_LABELS[gate]} · ${time} 秒</span>
  </span>`;
}

function renderResults(result) {
  resultsBox.innerHTML = result.runners
    .map((r) => {
      const badge =
        r.lapCount === 0
          ? `<span class="badge zero">0 次完整计次</span>`
          : `<span class="badge ok">${r.lapCount} 次完整计次</span>`;
      const meta =
        r.lapCount === 0
          ? `<span class="result-meta">无完整计次</span>`
          : `<span class="result-meta">各趟用时之和：${r.totalTime} 秒</span>`;

      const lapsHtml =
        r.lapCount === 0
          ? `<div class="zero-note">该选手没有符合两段耗时区间的完整一趟，计 0 次；全部感应记录列入未采纳。</div>`
          : r.laps
              .map((lap, i) => {
                return `
                <div class="lap-item">
                  <div class="lap-title">第 ${i + 1} 趟 · 总用时 ${lap.totalTime} 秒</div>
                  <div class="lap-chain">
                    ${gateChip("S", lap.start.id, lap.start.time)}
                    <span class="arrow">— ${lap.smTime} 秒 →</span>
                    ${gateChip("M", lap.middle.id, lap.middle.time)}
                    <span class="arrow">— ${lap.mfTime} 秒 →</span>
                    ${gateChip("F", lap.finish.id, lap.finish.time)}
                  </div>
                  <div class="seg-times">
                    起点→中途门 <strong>${lap.smTime}</strong> 秒，
                    中途门→终点 <strong>${lap.mfTime}</strong> 秒
                  </div>
                </div>`;
              })
              .join("");

      const unusedHtml =
        r.unused.length === 0
          ? `<span class="empty-line">（无未采纳记录）</span>`
          : r.unused
              .map(
                (u) =>
                  `<span class="chip-mini ${u.gate}">${GATE_LABELS[u.gate]} · ${escapeHtml(
                    u.id
                  )} · ${u.time} 秒</span>`
              )
              .join("");

      return `
      <section class="result-card">
        <div class="result-head">
          <h3>选手 ${r.runner}</h3>
          ${badge}
          ${meta}
        </div>
        <div>${lapsHtml}</div>
        <div class="subsection">
          <h4>未采纳记录（该选手输入但未进入任何一趟）</h4>
          ${unusedHtml}
        </div>
      </section>`;
    })
    .join("");
}

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
function escapeAttr(s) {
  return escapeHtml(s);
}

/* ---------- 示例 / 清空 ---------- */

const SAMPLE = {
  smMin: "10",
  smMax: "60",
  mfMin: "10",
  mfMax: "60",
  runners: [{ number: "101" }, { number: "102" }],
  records: [
    { id: "a1", runner: "101", gate: "S", time: "0" },
    { id: "b1", runner: "101", gate: "M", time: "12" },
    { id: "c1", runner: "101", gate: "F", time: "25" },
    { id: "a2", runner: "101", gate: "S", time: "30" },
    { id: "b2", runner: "101", gate: "M", time: "45" },
    { id: "c2", runner: "101", gate: "F", time: "58" },
    { id: "x1", runner: "101", gate: "M", time: "200" },
    { id: "x2", runner: "101", gate: "S", time: "31" },
    { id: "d1", runner: "102", gate: "S", time: "5" },
    { id: "e1", runner: "102", gate: "M", time: "15" },
    { id: "f1", runner: "102", gate: "F", time: "25" },
  ],
};

function loadSample() {
  document.getElementById("smMin").value = SAMPLE.smMin;
  document.getElementById("smMax").value = SAMPLE.smMax;
  document.getElementById("mfMin").value = SAMPLE.mfMin;
  document.getElementById("mfMax").value = SAMPLE.mfMax;

  runnerRows.innerHTML = "";
  SAMPLE.runners.forEach((r) => addRunnerRow(r.number));
  refreshRunnerButtons();

  recordRows.innerHTML = "";
  SAMPLE.records.forEach(() => addRecordRow());
  [...recordRows.querySelectorAll(".record-row")].forEach((row, i) => {
    const rec = SAMPLE.records[i];
    row.querySelector(".rec-id").value = rec.id;
    row.querySelector(".rec-runner").value = rec.runner;
    row.querySelector(".rec-gate").value = rec.gate;
    row.querySelector(".rec-time").value = rec.time;
  });
  refreshRecordCount();

  // 载入示例视同一次完整修改：立即清旧状态并自动重算。
  requestRecompute(false);
}

function clearAll() {
  document.getElementById("smMin").value = "";
  document.getElementById("smMax").value = "";
  document.getElementById("mfMin").value = "";
  document.getElementById("mfMax").value = "";
  runnerRows.innerHTML = "";
  addRunnerRow();
  recordRows.innerHTML = "";
  addRecordRow();
  refreshRunnerButtons();
  refreshRecordCount();

  // 版本号 +1：结果、错误立即清空，此前在途请求之后返回也不会恢复任何内容。
  invalidate();
  statusHint.hidden = true;
}

document.getElementById("sample-btn").addEventListener("click", loadSample);
document.getElementById("clear-btn").addEventListener("click", clearAll);

/* ---------- 初始行（首屏不自动发起裁决，保持空白等待首次修改） ---------- */
addRunnerRow();
addRecordRow();
addRecordRow();
refreshRunnerButtons();
refreshRecordCount();
