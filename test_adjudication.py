"""对裁决算法的正确性测试：固定用例 + 随机数据对拍暴力枚举。"""

import copy
import random
import sys

sys.path.insert(0, ".")
from app.adjudication import AdjudicationError, Record, adjudicate, parse_payload

RANGES = {"SM": (10, 60), "MF": (10, 60)}


def recs(spec):
    return [Record(id=i, runner=r, gate=g, time=t) for i, r, g, t in spec]


def brute_force(runner_records, ranges):
    """独立参考实现：在按终点排序的趟上做“选/不选”的记忆化递归。

    F(i, t) = 仅从 trips[i:] 中选取、且首趟起点必须 > t 时的最优键；
    与生产代码的前缀 DP 是两种独立写法，用于对拍。
    """
    import functools

    from app.adjudication import _build_trips

    trips = _build_trips(runner_records, ranges)

    def key_of(seq_ids, seq):
        return (-len(seq), sum(x.total for x in seq), tuple(seq_ids))

    INF = 10**18

    @functools.lru_cache(maxsize=None)
    def solve(i, bound):
        # 返回 (趟数, 总用时, ID 串接元组, 选择的 trip 下标元组)
        if i >= len(trips):
            return 0, 0, (), ()
        skip = solve(i + 1, bound)
        best = skip
        t = trips[i]
        if t.s.time > bound:
            tail = solve(i + 1, t.f.time)
            take = (
                tail[0] + 1,
                tail[1] + t.total,
                (t.s.id, t.m.id, t.f.id) + tail[2],
                (i,) + tail[3],
            )
            # 比较：(-趟数, 总用时, ID 序列) 越小越好。
            sk = (-skip[0], skip[1], skip[2])
            tk = (-take[0], take[1], take[2])
            if tk < sk:
                best = take
        return best

    cnt, tot, ids, sel = solve(0, -1)
    chosen = [trips[i] for i in sel]
    used_ids = []
    for t in chosen:
        assert ranges["SM"][0] <= t.sm <= ranges["SM"][1]
        assert ranges["MF"][0] <= t.mf <= ranges["MF"][1]
        used_ids.extend([t.s.id, t.m.id, t.f.id])
    assert len(used_ids) == len(set(used_ids))
    for a, b in zip(chosen, chosen[1:]):
        assert b.s.time > a.f.time
    return cnt, tot, ids, set(ids)


def fast_result(runner, all_records, ranges):
    res = adjudicate(
        {
            "standards": {
                "smMin": ranges["SM"][0], "smMax": ranges["SM"][1],
                "mfMin": ranges["MF"][0], "mfMax": ranges["MF"][1],
            },
            "runners": [{"number": runner}],
            "records": [
                {"id": r.id, "runner": r.runner, "gate": r.gate, "time": r.time}
                for r in all_records
            ],
        }
    )["runners"][0]
    ids = tuple(x for lap in res["laps"] for x in
                (lap["start"]["id"], lap["middle"]["id"], lap["finish"]["id"]))
    used = set(ids)
    return res["lapCount"], res["totalTime"], ids, used, res


def test_sample():
    spec = [
        ("a1", 101, "S", 0), ("b1", 101, "M", 12), ("c1", 101, "F", 25),
        ("a2", 101, "S", 30), ("b2", 101, "M", 45), ("c2", 101, "F", 58),
        ("x1", 101, "M", 200), ("x2", 101, "S", 31),
        ("d1", 102, "S", 5), ("e1", 102, "M", 15), ("f1", 102, "F", 25),
    ]
    out = adjudicate({
        "standards": {"smMin": 10, "smMax": 60, "mfMin": 10, "mfMax": 60},
        "runners": [{"number": 101}, {"number": 102}],
        "records": [{"id": i, "runner": r, "gate": g, "time": t} for i, r, g, t in spec],
    })
    r1 = out["runners"][0]
    assert r1["lapCount"] == 2, r1
    # 第二趟起点 x2(31) 比 a2(30) 总用时更短（58-31=27 < 58-30=28），按规则 2 选 x2
    assert [l["start"]["id"] for l in r1["laps"]] == ["a1", "x2"], r1
    assert r1["totalTime"] == 25 + 27, r1
    assert sorted(u["id"] for u in r1["unused"]) == ["a2", "x1"], r1
    r2 = out["runners"][1]
    assert r2["lapCount"] == 1 and r2["laps"][0]["start"]["id"] == "d1"
    assert len(r2["unused"]) == 0
    print("test_sample OK")


def test_zero_laps():
    spec = [("s1", 7, "S", 0), ("m1", 7, "M", 5), ("f1", 7, "F", 9)]  # 两段都太短
    cnt, tot, ids, used, res = fast_result(7, recs(spec), RANGES)
    assert (cnt, tot, ids) == (0, 0, ())
    assert {u["id"] for u in res["unused"]} == {"s1", "m1", "f1"}
    print("test_zero_laps OK")


def test_inclusive_bounds():
    spec = [("s", 1, "S", 0), ("m", 1, "M", 10), ("f", 1, "F", 20)]  # 恰为下限
    cnt, *_ = fast_result(1, recs(spec), RANGES)
    assert cnt == 1
    spec2 = [("s", 1, "S", 0), ("m", 1, "M", 60), ("f", 1, "F", 120)]  # 恰为上限
    cnt, *_ = fast_result(1, recs(spec2), RANGES)
    assert cnt == 1
    spec3 = [("s", 1, "S", 0), ("m", 1, "M", 61), ("f", 1, "F", 121)]
    cnt, *_ = fast_result(1, recs(spec3), RANGES)
    assert cnt == 0
    print("test_inclusive_bounds OK")


def test_strict_separation_and_sharing():
    # 一趟终点 25，另一趟起点也是 25：不得计两趟；且共用起点也不可能。
    spec = [
        ("s1", 1, "S", 0), ("m1", 1, "M", 10), ("f1", 1, "F", 25),
        ("m2", 1, "M", 35), ("f2", 1, "F", 50),
    ]
    cnt, *_ = fast_result(1, recs(spec), RANGES)
    assert cnt == 1
    # 起点严格晚于：26 > 25 可以两趟（第二段 sm=10, mf=14）。
    spec.append(("s2", 1, "S", 26))
    spec[3] = ("m2", 1, "M", 36)
    cnt, *_ = fast_result(1, recs(spec), RANGES)
    assert cnt == 2
    print("test_strict_separation_and_sharing OK")


def test_time_tiebreak():
    # 两套单趟方案：(s0,m10,f25)=25 与 (s1,m11,f25)=24，应选总用时短的。
    spec = [
        ("s0", 1, "S", 0), ("s1", 1, "S", 1),
        ("m0", 1, "M", 10), ("m1", 1, "M", 11),
        ("f0", 1, "F", 25),
    ]
    cnt, tot, ids, *_ = fast_result(1, recs(spec), RANGES)
    assert cnt == 1 and tot == 24 and ids == ("s1", "m1", "f0"), ids
    print("test_time_tiebreak OK")


def test_lex_tiebreak():
    # 两条同秒起点，趟数与总用时相同，ID 字典序小的胜出。
    spec = [
        ("za", 1, "S", 0), ("aa", 1, "S", 0),
        ("m0", 1, "M", 10), ("f0", 1, "F", 20),
    ]
    cnt, tot, ids, *_ = fast_result(1, recs(spec), RANGES)
    assert ids == ("aa", "m0", "f0"), ids
    print("test_lex_tiebreak OK")


def test_count_beats_time():
    # 两小趟（总用时 40）严格可串；另有一条可单独成趟的大起点 sBig 只能组成一趟，
    # 但两小趟计次数更多 → 计次数优先于总用时。
    spec = [
        ("s1", 1, "S", 0), ("m1", 1, "M", 10), ("f1", 1, "F", 25),
        ("s2", 1, "S", 110), ("m2", 1, "M", 120), ("f2", 1, "F", 130),
        # sBig 可与 m1/f1 组成一趟（10/50），但与 s1 冲突，选它最多 1 趟。
        ("sBig", 1, "S", 0),
    ]
    cnt, tot, ids, *_ = fast_result(1, recs(spec), RANGES)
    assert cnt == 2 and tot == 45, (cnt, tot)
    assert ids == ("s1", "m1", "f1", "s2", "m2", "f2")
    print("test_count_beats_time OK")


def test_lex_tiebreak_multilap():
    # 两趟方案，第一趟的起点有 zS / aS 两个同秒候选，趟数与总用时相同，
    # 完整串接 ID 序列字典序更小者（aS 开头）应胜出。
    spec = [
        ("zS", 1, "S", 0), ("aS", 1, "S", 0), ("M1", 1, "M", 10), ("F1", 1, "F", 20),
        ("S2", 1, "S", 30), ("M2", 1, "M", 40), ("F2", 1, "F", 50),
    ]
    cnt, tot, ids, *_ = fast_result(1, recs(spec), RANGES)
    assert cnt == 2 and tot == 40
    assert ids == ("aS", "M1", "F1", "S2", "M2", "F2"), ids
    print("test_lex_tiebreak_multilap OK")


def test_validation():
    base = {
        "standards": {"smMin": 10, "smMax": 60, "mfMin": 10, "mfMax": 60},
        "runners": [{"number": 1}],
        "records": [],
    }
    def must_fail(tweak, label):
        payload = copy.deepcopy(base)
        tweak(payload)
        try:
            parse_payload(payload)
        except AdjudicationError:
            return
        raise AssertionError(f"应当校验失败: {label}")

    must_fail(lambda p: p["standards"].update(smMin=0), "下限非正")
    must_fail(lambda p: p["standards"].update(smMax=9), "下限>上限")
    must_fail(lambda p: p["runners"].append({"number": 1}), "编号重复")
    must_fail(lambda p: p["runners"].clear(), "零名选手")
    must_fail(lambda p: p["runners"].extend([{"number": 2}, {"number": 3}, {"number": 4}]), "四名选手")
    must_fail(lambda p: p["records"].update if False else p.update(records=[
        {"id": "x", "runner": 2, "gate": "S", "time": 0}]), "未登记选手")
    must_fail(lambda p: p.update(records=[{"id": "x", "runner": 1, "gate": "X", "time": 0}]), "门非法")
    must_fail(lambda p: p.update(records=[{"id": "x", "runner": 1, "gate": "S", "time": -1}]), "负秒")
    must_fail(lambda p: p.update(records=[{"id": "x", "runner": 1, "gate": "S", "time": 1.5}]), "小数秒")
    must_fail(lambda p: p.update(records=[{"id": " x ", "runner": 1, "gate": "S", "time": 0},
                                          {"id": "x", "runner": 1, "gate": "F", "time": 5}]), "ID 重复（trim 后）")
    must_fail(lambda p: p.update(records=[{"id": "x", "runner": 1, "gate": "S"}]), "记录缺字段")
    must_fail(lambda p: p.update(records=[{"id": "x", "runner": 1, "gate": "S", "time": "0²"}]), "Unicode 数字")

    # 全空行跳过；40 条上限
    ok = copy.deepcopy(base)
    ok["records"] = [{"id": "", "runner": "", "gate": "", "time": ""}]
    _, _, rs = parse_payload(ok)
    assert rs == []
    big = copy.deepcopy(base)
    big["records"] = [
        {"id": f"r{i}", "runner": 1, "gate": "S", "time": 0} for i in range(41)]
    try:
        parse_payload(big)
        raise AssertionError("41 条应失败")
    except AdjudicationError:
        pass
    big40 = copy.deepcopy(base)
    big40["records"] = [
        {"id": f"r{i}", "runner": 1, "gate": "S", "time": 0} for i in range(40)]
    parse_payload(big40)
    print("test_validation OK")


def random_fuzz(seed, n_records):
    rng = random.Random(seed)
    gates_pool = ["S", "M", "F"]
    spec = []
    for i in range(n_records):
        spec.append((f"r{i:03d}", 1, rng.choice(gates_pool), rng.randint(0, 120)))
    mine = recs(spec)
    b_cnt, b_tot, b_ids, b_used = brute_force(mine, RANGES)
    f_cnt, f_tot, f_ids, f_used, res = fast_result(1, mine, RANGES)
    assert (f_cnt, f_tot, f_ids) == (b_cnt, b_tot, b_ids), (
        f"seed={seed} mismatch: fast={(f_cnt, f_tot, f_ids)} brute={(b_cnt, b_tot, b_ids)}")
    assert f_used == b_used
    # 未采纳记录数一致
    assert len(res["unused"]) == len(mine) - 3 * f_cnt
    # 每趟内部与相邻趟的约束
    for lap in res["laps"]:
        assert 10 <= lap["smTime"] <= 60 and 10 <= lap["mfTime"] <= 60
    for a, b in zip(res["laps"], res["laps"][1:]):
        assert b["start"]["time"] > a["finish"]["time"]
        assert b["start"]["time"] > a["finish"]["time"]


if __name__ == "__main__":
    test_sample()
    test_zero_laps()
    test_inclusive_bounds()
    test_strict_separation_and_sharing()
    test_time_tiebreak()
    test_lex_tiebreak()
    test_lex_tiebreak_multilap()
    test_count_beats_time()
    test_validation()
    for seed in range(400):
        random_fuzz(seed, 6 + seed % 10)
    print("fuzz x400 OK")
    print("ALL TESTS PASSED")
