"""赛道计次裁决核心算法。

规则摘要：
- 每趟从同一选手的感应记录中选 起点(S) -> 中途门(M) -> 终点(F) 各一条，
  两段耗时（M-S、F-M）均须落在给定的正整数闭区间内。
- 同一选手的不同趟不得共用记录；后一趟起点时间须严格晚于前一趟终点时间。
- 最优化目标（按优先级）：
    1) 完整计次数最多；
    2) 各趟用时（终点秒数 - 起点秒数）之和最短；
    3) 按计次时间顺序串接的记录 ID 序列字典序最小。

实现方式：枚举所有合法“趟”，按终点时间排序后在 DAG 上做最长路 DP；
前驱用二分查找（要求前驱终点 < 当前起点），比较键直接使用
(趟数, 总用时, ID 序列) 的三元组（趟数越大越好、其余越小越好）。
"""

from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

GATES = ("S", "M", "F")


class AdjudicationError(ValueError):
    """输入非法错误，message 为可直接展示的中文说明。"""


MAX_RUNNERS = 3
MAX_RECORDS = 40


def _is_uint_text(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != "" and all(
        c in "0123456789" for c in value.strip()
    )


def _parse_nonneg_int(value: Any, field: str) -> int:
    # 拒绝 bool（bool 是 int 的子类），只接受十进制整数字面量，杜绝 1.0 / "0x1" 等。
    if isinstance(value, bool):
        raise AdjudicationError(f"{field}必须是非负整数")
    if isinstance(value, int):
        n = value
    elif _is_uint_text(value):
        n = int(value.strip())
    else:
        raise AdjudicationError(f"{field}必须是非负整数")
    if n < 0:
        raise AdjudicationError(f"{field}必须是非负整数")
    return n


def _parse_positive_int(value: Any, field: str) -> int:
    n = _parse_nonneg_int(value, field)
    if n <= 0:
        raise AdjudicationError(f"{field}必须是正整数")
    return n


def _require_object(value: Any, field: str) -> dict:
    if not isinstance(value, dict):
        raise AdjudicationError(f"{field}格式不正确")
    return value


def _require_list(value: Any, field: str) -> list:
    if not isinstance(value, list):
        raise AdjudicationError(f"{field}格式不正确")
    return value


def _parse_closed_range(standards: dict, lo_key: str, hi_key: str, label: str) -> tuple[int, int]:
    lo = _parse_positive_int(standards.get(lo_key), f"{label}区间下限")
    hi = _parse_positive_int(standards.get(hi_key), f"{label}区间上限")
    if lo > hi:
        raise AdjudicationError(f"{label}区间下限不能大于上限")
    return lo, hi


@dataclass(frozen=True)
class Record:
    id: str
    runner: int
    gate: str
    time: int


def parse_payload(payload: Any) -> tuple[list[int], dict[str, tuple[int, int]], list[Record]]:
    """校验并解析请求体，非法时抛出 AdjudicationError。

    返回 (按输入顺序排列的选手编号列表, 两段区间, 按输入顺序排列的记录列表)。
    """
    root = _require_object(payload, "请求体")

    standards = _require_object(root.get("standards"), "合格耗时区间")
    sm_range = _parse_closed_range(standards, "smMin", "smMax", "起点至中途门")
    mf_range = _parse_closed_range(standards, "mfMin", "mfMax", "中途门至终点")

    runner_rows = _require_list(root.get("runners"), "选手列表")
    if not 1 <= len(runner_rows) <= MAX_RUNNERS:
        raise AdjudicationError(f"选手人数必须为 1～{MAX_RUNNERS} 名")

    runner_ids: list[int] = []
    seen_runner: set[int] = set()
    for i, row in enumerate(runner_rows, 1):
        row = _require_object(row, f"第 {i} 名选手")
        number_raw = row.get("number")
        if number_raw is None or (isinstance(number_raw, str) and number_raw.strip() == ""):
            # 前端只发送有内容的选手行；收到空编号一律视为非法，防止静默漏录。
            raise AdjudicationError(f"第 {i} 名选手编号不能为空")
        rid = _parse_positive_int(number_raw, f"第 {i} 名选手编号")
        if rid in seen_runner:
            raise AdjudicationError(f"选手编号 {rid} 重复")
        seen_runner.add(rid)
        runner_ids.append(rid)

    record_rows = _require_list(root.get("records"), "感应记录列表")
    if len(record_rows) > MAX_RECORDS:
        raise AdjudicationError(f"感应记录至多 {MAX_RECORDS} 条")

    records: list[Record] = []
    seen_ids: set[str] = set()
    for i, row in enumerate(record_rows, 1):
        row = _require_object(row, f"第 {i} 条感应记录")

        # 四个字段全空视为未填写的占位行，直接跳过；部分空则按非法处理。
        rid_raw = row.get("id")
        runner_raw = row.get("runner")
        gate_raw = row.get("gate")
        time_raw = row.get("time")

        def _blank(v: Any) -> bool:
            return v is None or (isinstance(v, str) and v.strip() == "")

        if all(_blank(v) for v in (rid_raw, runner_raw, gate_raw, time_raw)):
            continue
        if any(_blank(v) for v in (rid_raw, runner_raw, gate_raw, time_raw)):
            raise AdjudicationError(f"第 {i} 条感应记录填写不完整")

        if not isinstance(rid_raw, str):
            raise AdjudicationError(f"第 {i} 条感应记录的 ID 必须是字符串")
        rid = rid_raw.strip()
        if rid in seen_ids:
            raise AdjudicationError(f"感应记录 ID 重复：{rid}")
        seen_ids.add(rid)

        runner = _parse_positive_int(runner_raw, f"记录 {rid} 的选手编号")
        if runner not in seen_runner:
            raise AdjudicationError(f"记录 {rid} 的选手编号 {runner} 未登记")

        if gate_raw not in GATES:
            raise AdjudicationError(f"记录 {rid} 的门必须为 S / M / F 之一")

        time_s = _parse_nonneg_int(time_raw, f"记录 {rid} 的秒数")
        records.append(Record(id=rid, runner=runner, gate=gate_raw, time=time_s))

    ranges = {"SM": sm_range, "MF": mf_range}
    return runner_ids, ranges, records


@dataclass(frozen=True)
class Trip:
    """一躺候选：三条记录及两段耗时、总用时。"""

    s: Record
    m: Record
    f: Record
    sm: int
    mf: int

    @property
    def total(self) -> int:
        return self.f.time - self.s.time

    @property
    def ids(self) -> tuple[str, ...]:
        return (self.s.id, self.m.id, self.f.id)


def _build_trips(
    runner_records: list[Record], ranges: dict[str, tuple[int, int]]
) -> list[Trip]:
    by_gate: dict[str, list[Record]] = defaultdict(list)
    for rec in runner_records:
        by_gate[rec.gate].append(rec)
    sm_lo, sm_hi = ranges["SM"]
    mf_lo, mf_hi = ranges["MF"]

    trips: list[Trip] = []
    # M 在内层，可按时间顺序做范围裁剪；数据量极小，直接全枚举也足够。
    for s in by_gate["S"]:
        for m in by_gate["M"]:
            sm = m.time - s.time
            if not (sm_lo <= sm <= sm_hi):
                continue
            for f in by_gate["F"]:
                mf = f.time - m.time
                if mf_lo <= mf <= mf_hi:
                    trips.append(Trip(s=s, m=m, f=f, sm=sm, mf=mf))

    # 以终点时间为主序，保证 DP 中前驱必然先出现；其余键保证结果确定。
    trips.sort(
        key=lambda t: (
            t.f.time,
            t.s.time,
            t.m.time,
            t.total,
            t.s.id,
            t.m.id,
            t.f.id,
        )
    )
    return trips


# 每个 DP 状态：(趟数, 总用时, ID 串接元组)
# 趟数越大越好；总用时、ID 序列越小越好。
Key = tuple[int, int, tuple[str, ...]]


def _key_better(cand: Key, best: Key | None) -> bool:
    """cand 是否优于（或等于）当前最优 best。"""
    if best is None:
        return True
    if cand[0] != best[0]:
        return cand[0] > best[0]
    if cand[1] != best[1]:
        return cand[1] < best[1]
    return cand[2] < best[2]


def _adjudicate_one(
    runner: int, records: list[Record], ranges: dict[str, tuple[int, int]]
) -> dict:
    mine = [r for r in records if r.runner == runner]
    trips = _build_trips(mine, ranges)

    finish_times = [t.f.time for t in trips]

    # prev[i]：以 trips[i] 结尾的最优链中，上一趟的下标（-1 为首趟）。
    prev: list[int] = []
    # 前缀最优（按 trips 顺序）及其下标，供二分跳转使用。
    prefix_best: list[Key] = []
    prefix_idx: list[int] = []

    for i, trip in enumerate(trips):
        base: Key = (1, trip.total, trip.ids)
        best: Key = base
        best_prev = -1

        # 只允许终点严格早于本趟起点的趟作为前驱。
        j = bisect_right(finish_times, trip.s.time - 1, 0, i) - 1
        if j >= 0:
            pk = prefix_best[j]
            cand: Key = (
                pk[0] + 1,
                pk[1] + trip.total,
                pk[2] + trip.ids,
            )
            if _key_better(cand, best):
                best = cand
                best_prev = prefix_idx[j]

        prev.append(best_prev)

        if i == 0:
            prefix_best.append(best)
            prefix_idx.append(i)
        else:
            pb = prefix_best[-1]
            if _key_better(best, pb):
                prefix_best.append(best)
                prefix_idx.append(i)
            else:
                prefix_best.append(pb)
                prefix_idx.append(prefix_idx[-1])

    used: set[str] = set()
    chosen: list[Trip] = []
    if trips:
        cur = prefix_idx[-1]
        while cur != -1:
            chosen.append(trips[cur])
            cur = prev[cur]
        chosen.reverse()
        for trip in chosen:
            used.update(trip.ids)

    laps_out = [
        {
            "start": {"id": t.s.id, "time": t.s.time},
            "middle": {"id": t.m.id, "time": t.m.time},
            "finish": {"id": t.f.id, "time": t.f.time},
            "smTime": t.sm,
            "mfTime": t.mf,
            "totalTime": t.total,
        }
        for t in chosen
    ]
    unused = [
        {"id": r.id, "gate": r.gate, "time": r.time}
        for r in mine
        if r.id not in used
    ]
    return {
        "runner": runner,
        "lapCount": len(chosen),
        "totalTime": sum((t.total for t in chosen), 0),
        "laps": laps_out,
        "unused": unused,
    }


def adjudicate(payload: Any) -> dict:
    """裁决入口：非法输入抛 AdjudicationError；合法时返回可序列化结果。"""
    runner_ids, ranges, records = parse_payload(payload)
    return {
        "runners": [_adjudicate_one(rid, records, ranges) for rid in runner_ids]
    }
