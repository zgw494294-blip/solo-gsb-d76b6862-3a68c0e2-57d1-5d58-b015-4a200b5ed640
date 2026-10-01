"use strict";

const MAX_RUNNERS = 3;
const MAX_RECORDS = 40;
const GATE_LABELS = { S: "起点 S", M: "中途门 M", F: "终点 F" };

const runnerRows = document.getElementById("runner-rows");
const recordRows = document.getElementById("record-rows");
const addRunnerBtn = document.getElementById("add-runner");
const addRecordBtn = document.getElementById("add-record");
const recordCount = document.getElementById("record-count");
const form = document.getElementById("judge-form");
const errorBox = document.getElementById("error-box");
const staleHint = document.getElementById("stale-hint");
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

addRunnerBtn.addEventListener("click", () => addRunnerRow());
addRecordBtn.addEventListener("click", () => addRecordRow());

runnerRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-runner")) {
    e.target.closest(".runner-row").remove();
    refreshRunnerButtons();
    markStale();
  }
});
recordRows.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-record")) {
    e.target.closest(".record-row").remove();
    refreshRecordCount();
    markStale();
  }
});

/* ---------- 输入修改后统一标记过期 ---------- */

function markStale() {
  if (resultsBox.dataset.fresh === "1") staleHint.hidden = false;
}
form.addEventListener("input", markStale);
form.addEventListener("change", markStale);

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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.hidden = true;
  staleHint.hidden = true;
  submitBtn.disabled = true;
  try {
    const resp = await fetch("/api/adjudicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      // 非法输入：清空结果区，只显示错误（不展示部分结果）。
      resultsBox.innerHTML = "";
      resultsBox.dataset.fresh = "";
      showError(data.error || "裁决失败");
    } else {
      renderResults(data.result);
      resultsBox.dataset.fresh = "1";
    }
  } catch (err) {
    resultsBox.innerHTML = "";
    resultsBox.dataset.fresh = "";
    showError(`无法连接裁决服务：${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
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

  errorBox.hidden = true;
  staleHint.hidden = false;
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
  errorBox.hidden = true;
  staleHint.hidden = true;
  resultsBox.innerHTML = "";
  resultsBox.dataset.fresh = "";
}

document.getElementById("sample-btn").addEventListener("click", loadSample);
document.getElementById("clear-btn").addEventListener("click", clearAll);

/* ---------- 初始行 ---------- */
addRunnerRow();
addRecordRow();
addRecordRow();
refreshRunnerButtons();
refreshRecordCount();
