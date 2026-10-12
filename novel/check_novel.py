#!/usr/bin/env python3
"""T11 원고 자동 검사기.

사용법:
    python3 check_novel.py 원고.docx            # DOCX 검사
    python3 check_novel.py 원고.md              # MD 검사
    python3 check_novel.py 원고.docx --show CH03-P012   # 앵커 문단 출력
    python3 check_novel.py 원고.docx --forbid 실명목록.txt  # 실명 금지어 검사(목록 파일은 제출하지 않음)

통과하면 마지막 줄에 'RESULT: PASS (n/n)'이, 실패하면 'RESULT: FAIL'과 실패 항목이 나온다.
설치가 필요한 것은 DOCX를 읽을 때의 python-docx 하나뿐이다.
"""
import re
import sys
import unicodedata
from pathlib import Path

START = "[[ALEPH_BODY_START]]"
END = "[[ALEPH_BODY_END]]"
CHAPTER_RE = re.compile(r"^(\d+)장\.\s*(.+?)\s*$")
TOC_LINE_RE = re.compile(r"^(?:[-*]\s*)?(\d+)장\.\s*(.+?)\s*$")
ANCHOR_RE = re.compile(r"^\[(CH\d{2}-P\d{3})\]\s*")
REF_RE = re.compile(r"CH\d{2}-P\d{3}")
CATEGORIES = ["인물", "관계", "지명", "시간선", "세계 규칙"]
FORBIDDEN = [
    ("C08", re.compile(r"TODO")),
    ("C09", re.compile(r"TBD")),
    ("C10", re.compile(r"FIXME", re.I)),
    ("C10", re.compile(r"자리\s*표시")),
    ("C10", re.compile(r"내용\s*추가\s*예정")),
    ("C10", re.compile(r"나중에\s*채움")),
]
CONTACT = [
    ("전화번호", re.compile(r"01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}")),
    ("이메일", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")),
]
SECRET = [
    ("OpenAI/Anthropic 키", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}")),
    ("GitHub 토큰", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("AWS 키", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("JWT", re.compile(r"\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}")),
    ("비밀번호 원문", re.compile(r"(?i)(password|passwd|비밀번호)\s*[:=]\s*\S+")),
]


# ---------- 읽기: 문단(블록) 목록으로 통일 ----------
def read_blocks(path):
    """[(style, text)] 목록. style은 'h1','h2','h3','p','cell' 중 하나."""
    if path.suffix.lower() == ".docx":
        from docx import Document
        from docx.oxml.ns import qn

        doc = Document(str(path))
        blocks = []
        for p in doc.element.body.iter(qn("w:p")):
            text = "".join(t.text or "" for t in p.iter(qn("w:t")))
            in_table = any(a.tag == qn("w:tc") for a in p.iterancestors())
            style = "p"
            ppr = p.find(qn("w:pPr"))
            if ppr is not None and ppr.find(qn("w:pStyle")) is not None:
                sid = ppr.find(qn("w:pStyle")).get(qn("w:val")) or ""
                m = re.match(r"(?i)heading(\d)", sid)
                if m:
                    style = "h" + m.group(1)
                elif sid.lower() == "title":
                    style = "h1"
            blocks.append(("cell" if in_table else style, text))
        return blocks
    # MD / TXT: 빈 줄로 나눈 덩어리가 문단
    raw = path.read_text(encoding="utf-8")
    blocks = []
    for chunk in re.split(r"\n\s*\n", raw):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", chunk.strip())
        if m and "\n" not in chunk.strip():
            blocks.append(("h" + str(len(m.group(1))), m.group(2)))
        elif chunk.lstrip().startswith("|"):
            for line in chunk.splitlines():
                blocks.append(("cell", line))
        elif re.match(r"^\s*[-*]\s", chunk):
            for line in chunk.splitlines():
                blocks.append(("p", line.strip()))
        else:
            blocks.append(("p", chunk.strip()))
    return blocks


def white_space_free(s):
    return "".join(ch for ch in s if not ch.isspace() and ch not in "​﻿")


def norm_dup(s):
    s = unicodedata.normalize("NFKC", s).lower()
    return "".join(
        ch for ch in s if not ch.isspace() and not unicodedata.category(ch).startswith("P")
    )


# ---------- 검사 ----------
def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    show = argv[argv.index("--show") + 1] if "--show" in argv else None
    forbid = argv[argv.index("--forbid") + 1] if "--forbid" in argv else None

    blocks = read_blocks(path)
    texts = [t for _, t in blocks]
    results = []

    def check(cid, ok, detail):
        results.append((cid, ok, detail))

    check("C02", path.suffix.lower() in (".docx", ".md", ".txt"), f"형식 {path.suffix}")

    # 경계 표시
    s_idx = [i for i, t in enumerate(texts) if START in t]
    e_idx = [i for i, t in enumerate(texts) if END in t]
    raw_all = "\n".join(texts)
    check("C42", raw_all.count(START) == 1 and len(s_idx) == 1 and texts[s_idx[0]].strip() == START,
          f"START {raw_all.count(START)}회")
    check("C43", raw_all.count(END) == 1 and len(e_idx) == 1 and texts[e_idx[0]].strip() == END,
          f"END {raw_all.count(END)}회")
    if not (s_idx and e_idx and s_idx[0] < e_idx[0]):
        check("C44", False, "START가 END보다 앞에 있지 않음")
        return report(results)
    check("C44", True, "START < END")
    si, ei = s_idx[0], e_idx[0]
    body = blocks[si + 1:ei]

    # 장 나누기
    chapters = []  # [{num,title,paras:[(anchor,text)]}]
    for style, t in body:
        m = CHAPTER_RE.match(t.strip())
        if style.startswith("h") and m:
            chapters.append({"num": int(m.group(1)), "title": m.group(2), "paras": []})
            continue
        if not chapters:
            check("C42", False, f"첫 장 제목 앞에 본문이 있음: {t[:30]}")
            continue
        a = ANCHOR_RE.match(t)
        chapters[-1]["paras"].append((a.group(1) if a else None, t))

    check("C42", bool(body) and CHAPTER_RE.match(body[0][1].strip()) is not None,
          "START 바로 다음이 첫 장 제목")
    check("C06", len(chapters) >= 10, f"장 수 {len(chapters)}")
    empty = [c["num"] for c in chapters if sum(len(white_space_free(t)) for _, t in c["paras"]) < 200]
    check("C07", not empty, f"빈(200자 미만) 장 {empty}" if empty else "빈 장 없음")

    # 글자 수
    body_text = "\n".join(t for _, t in body)
    total = len(white_space_free(unicodedata.normalize("NFC", body_text)))
    no_anchor = "\n".join(ANCHOR_RE.sub("", t) for _, t in body)
    total_na = len(white_space_free(unicodedata.normalize("NFC", no_anchor)))
    check("C05", total >= 30000 and total_na >= 30000,
          f"공백 제외 {total:,}자 (앵커 제외 {total_na:,}자)")
    for c in chapters:
        n = sum(len(white_space_free(ANCHOR_RE.sub("", t))) for _, t in c["paras"])
        print(f"  {c['num']:>2}장 {c['title']:<24} {n:>6,}자 · 문단 {len(c['paras'])}")

    # 앵커
    anchors, bad = {}, []
    for c in chapters:
        for i, (a, t) in enumerate(c["paras"], 1):
            want = f"CH{c['num']:02d}-P{i:03d}"
            if a != want:
                bad.append(f"{want}≠{a}")
            anchors[want] = ANCHOR_RE.sub("", t)
    check("ANCHOR", not bad, f"문단 앵커 {len(anchors)}개" + (f", 어긋남 {bad[:3]}" if bad else ""))
    if show:
        print(f"\n[{show}]\n{anchors.get(show, '(없는 앵커)')}\n")

    # 금지 문구 (파일 전체)
    for cid in ("C08", "C09", "C10"):
        hits = [p.pattern for c2, p in FORBIDDEN if c2 == cid and p.search(raw_all)]
        check(cid, not hits, f"발견 {hits}" if hits else "0건")

    # 목차
    toc = []
    toc_i = next((i for i, (s, t) in enumerate(blocks[:si]) if s.startswith("h") and t.strip() == "목차"), None)
    if toc_i is not None:
        for s, t in blocks[toc_i + 1:si]:
            if s.startswith("h"):
                break
            m = TOC_LINE_RE.match(t.strip())
            if m:
                toc.append((int(m.group(1)), m.group(2)))
    body_toc = [(c["num"], c["title"]) for c in chapters]
    check("C12", len(toc) == len(body_toc), f"목차 {len(toc)}장 / 본문 {len(body_toc)}장")
    check("C11", sorted(t for _, t in toc) == sorted(t for _, t in body_toc), "장 제목 일치")
    check("C13", toc == body_toc, "장 순서 일치")

    # 중복 문단
    seen, dups = {}, []
    for a, t in anchors.items():
        k = norm_dup(t)
        if len(k) >= 40:
            if k in seen:
                dups.append((seen[k], a))
            seen.setdefault(k, a)
    # 앵커를 남긴 원문 기준으로도 확인(채점기가 앵커를 지우지 않을 경우와 같음)
    check("C19", not dups, f"동일 문단 쌍 {len(dups)}개 {dups[:3]}")

    # 대조표 (본문 뒤)
    after = blocks[ei + 1:]
    heads = [t.strip() for s, t in after if s.startswith("h")]
    missing = [c for c in CATEGORIES if not any(h.endswith(c) or h.endswith(c + " 대조표") or re.search(rf"\b{c}$", h) for h in heads)]
    check("C04/C14", not missing, f"대조표 범주 누락 {missing}" if missing else "다섯 범주 있음")
    refs = REF_RE.findall("\n".join(t for _, t in after))
    unknown = sorted(set(r for r in refs if r not in anchors))
    check("C15", refs and not unknown, f"대조표·기록의 앵커 참조 {len(refs)}개, 없는 앵커 {unknown[:5]}")

    # 인물 첫 항목 = 주인공, 첫 장에 이름 존재
    cast_i = next((i for i, (s, t) in enumerate(after) if s.startswith("h") and t.strip().endswith("인물")), None)
    hero = None
    if cast_i is not None:
        rows = [t for s, t in after[cast_i + 1:] if s == "cell"]
        if after and path.suffix.lower() == ".docx":
            # DOCX 표: 셀 단위 → 첫 행은 머리글, 둘째 행 첫 셀이 첫 항목
            from docx import Document
            doc = Document(str(path))
            for tbl in doc.tables:
                if tbl.rows and tbl.rows[0].cells[0].text.strip() == "인물":
                    hero = tbl.rows[1].cells[0].text.strip()
                    break
        else:
            data = [r for r in rows if not re.match(r"^\|\s*[-:| ]+\|?$", r)]
            if len(data) >= 2:
                hero = data[1].strip("|").split("|")[0].strip()
    first_ch = " ".join(t for _, t in chapters[0]["paras"]) if chapters else ""
    hero_name = re.split(r"[\s(（]", hero)[0] if hero else None
    check("C47", bool(hero_name) and hero_name in first_ch,
          f"인물 첫 항목 '{hero}', 첫 장 등장 {bool(hero_name and hero_name in first_ch)}")

    # 큰 수정 3건
    rev_text = "\n".join(t for _, t in after)
    n_rev = len(re.findall(r"^수정\s*\d+", "\n".join(t for s, t in after if s.startswith("h")), re.M))
    fields = ["위치", "수정 전", "수정 후", "발견 경위", "수정 내용", "원인 분류"]
    miss_f = [f for f in fields if rev_text.count(f) < 3]
    check("C20-25", n_rev >= 3 and not miss_f, f"큰 수정 {n_rev}건, 부족한 칸 {miss_f}")

    # 개인정보·비밀값 (파일 전체)
    hits = [(n, m.group(0)) for n, p in CONTACT for m in p.finditer(raw_all)]
    check("C40", not hits, f"연락처 의심 {hits[:3]}" if hits else "연락처 0건")
    hits = [n for n, p in SECRET if p.search(raw_all)]
    check("C41", not hits, f"비밀값 의심 {hits}" if hits else "비밀값 0건")
    if forbid:
        names = [n.strip() for n in Path(forbid).read_text(encoding="utf-8").splitlines() if n.strip()]
        found = [n for n in names if n in raw_all]
        check("C40", not found, f"금지 실명 발견 {found}" if found else f"금지 실명 {len(names)}개 0건")

    return report(results)


def report(results):
    print()
    for cid, ok, detail in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {cid:<8} {detail}")
    failed = [cid for cid, ok, _ in results if not ok]
    print()
    if failed:
        print(f"RESULT: FAIL ({', '.join(failed)})")
        return 1
    print(f"RESULT: PASS ({len(results)}/{len(results)})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
