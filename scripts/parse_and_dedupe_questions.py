from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable

from explanation_engine import build_explanation


QUESTION_RE = re.compile(r"^\s*(\d{1,4})\s*[、.．。]\s*(.+)$")
EMBEDDED_QUESTION_RE = re.compile(
    r"(?<!\d)(?=(\d{1,4})\s*[、.．。]\s*(?:[\u4e00-\u9fff“\"《]|\d{4}年))"
)
OPTION_RE = re.compile(
    r"(?<![A-Za-z0-9])([A-F])\s*(?:[.．、]|(?=[\u4e00-\u9fff《“]))"
)
INLINE_ANSWER_RES = [
    re.compile(r"【\s*正确答案(?:是)?\s*】\s*[:：]?\s*([A-F]{1,6})", re.I),
    re.compile(r"(?:正确答案|参考答案|答案)\s*[:：]\s*([A-F]{1,6})", re.I),
]
ANSWER_KEY_RE = re.compile(r"(\d{1,4})\s*[.、．]?\s*([A-F]{1,6})(?=\s|\d|[，,。；;】\]）)]|$)", re.I)
CHAPTER_RE = re.compile(r"第\s*[一二三四五六七八九十百0-9]+\s*章[^\n]{0,40}")
INTRO_RE = re.compile(r"^(?:《[^》]+》\s*)?(导论|绪论)(?:\s|$)")


def normalize_spaces(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\ufeff", "").replace("\u200b", "")
    value = re.sub(r"[ \t\u3000]+", " ", value)
    return value.strip()


def normalize_answer(value: str | None) -> str | None:
    if not value:
        return None
    letters = "".join(sorted(set(re.findall(r"[A-F]", value.upper()))))
    return letters or None


def canonical_chapter(value: str) -> str:
    compact = normalize_spaces(value)
    chapter_names = {
        "一": "第一章 世界的物质性及其发展规律",
        "1": "第一章 世界的物质性及其发展规律",
        "二": "第二章 认识世界和改造世界",
        "2": "第二章 认识世界和改造世界",
        "三": "第三章 人类社会及其发展规律",
        "3": "第三章 人类社会及其发展规律",
        "四": "第四章 资本主义的形成及其本质",
        "4": "第四章 资本主义的形成及其本质",
        "五": "第五章 资本主义发展的历史进程",
        "5": "第五章 资本主义发展的历史进程",
        "六": "第六章 社会主义社会及其发展",
        "6": "第六章 社会主义社会及其发展",
        "七": "第七章 共产主义是人类最崇高的社会理想",
        "7": "第七章 共产主义是人类最崇高的社会理想",
    }
    match = re.search(r"第\s*([一二三四五六七1234567])\s*章", compact)
    if match:
        return chapter_names.get(match.group(1), compact)
    if compact in {"绪论", "导论"}:
        return "导论"
    return compact


def normalized_stem(value: str) -> str:
    value = normalize_spaces(value)
    value = re.sub(r"【\s*[A-F]*\s*】", "", value, flags=re.I)
    value = re.sub(r"[（(\[]\s*[A-F]*\s*[）)\]]", "", value, flags=re.I)
    value = re.sub(r"[（）()【】\[\]<>《》“”‘’'\"，。！？、：；,.!?;:\s·—_\-]+", "", value)
    return value.lower()


def detect_type(line: str, current: str) -> str:
    if "多项" in line or "多选" in line:
        return "multiple"
    if "单项" in line or "单选" in line:
        return "single"
    if "判断" in line:
        return "true_false"
    return current


def expand_embedded_questions(lines: list[str]) -> list[str]:
    expanded: list[str] = []
    for line in lines:
        if "参考答案" in line or "正确答案" in line:
            expanded.append(line)
            continue
        starts = [match.start() for match in EMBEDDED_QUESTION_RE.finditer(line)]
        if not starts:
            expanded.append(line)
            continue
        cursor = 0
        for start in starts:
            prefix = normalize_spaces(line[cursor:start])
            if prefix:
                expanded.append(prefix)
            cursor = start
        tail = normalize_spaces(line[cursor:])
        if tail:
            expanded.append(tail)
    return expanded


@dataclass
class Candidate:
    source: str
    number: int
    chapter: str
    question_type: str
    stem: str
    options: dict[str, str]
    answer: str | None
    explanation: str | None = None
    raw: str = ""
    source_index: int = 0

    @property
    def key(self) -> str:
        return normalized_stem(self.stem)


def split_options(raw: str) -> tuple[str, dict[str, str]]:
    matches = list(OPTION_RE.finditer(raw))
    if len(matches) < 2:
        return normalize_spaces(raw), {}

    seen: set[str] = set()
    ordered = []
    for match in matches:
        letter = match.group(1).upper()
        if letter in seen:
            continue
        seen.add(letter)
        ordered.append(match)

    if len(ordered) < 2 or ordered[0].group(1).upper() != "A":
        return normalize_spaces(raw), {}

    stem = normalize_spaces(raw[: ordered[0].start()])
    options: dict[str, str] = {}
    for index, match in enumerate(ordered):
        letter = match.group(1).upper()
        end = ordered[index + 1].start() if index + 1 < len(ordered) else len(raw)
        text = normalize_spaces(raw[match.end() : end])
        text = re.sub(r"【\s*正确答案(?:是)?\s*】\s*[:：]?\s*[A-F]{1,6}.*$", "", text).strip()
        text = re.sub(r"(?:正确答案|参考答案|答案)\s*[:：]\s*[A-F]{1,6}.*$", "", text).strip()
        if text:
            options[letter] = text
    return stem, options


def extract_inline_answer(raw: str, stem: str) -> str | None:
    boxed_tail = re.search(r"((?:【\s*[A-F]?\s*】\s*){1,6})$", stem, flags=re.I)
    if boxed_tail:
        letters = re.findall(r"[A-F]", boxed_tail.group(1), flags=re.I)
        if letters:
            return normalize_answer("".join(letters))
    for pattern in INLINE_ANSWER_RES:
        match = pattern.search(raw)
        if match:
            return normalize_answer(match.group(1))
    match = re.search(
        r"[（(【\[]\s*([A-F]{1,6})\s*[）)】\]]\s*[)）]?\s*(?:错误|产生|实现的?|提出|属于|是|的)?\s*[。；,.，;]?\s*$",
        stem,
        flags=re.I,
    )
    return normalize_answer(match.group(1)) if match else None


def clean_stem(stem: str, answer: str | None = None) -> str:
    stem = re.sub(r"【\s*正确答案(?:是)?\s*】\s*[:：]?\s*[A-F]{1,6}", "", stem)
    stem = re.sub(r"(?:正确答案|参考答案|答案)\s*[:：]\s*[A-F]{1,6}", "", stem)
    stem = re.sub(r"(?:【\s*[A-F]?\s*】\s*){1,6}$", "（ ）", stem, flags=re.I)
    if answer:
        def replace_matching_answer(match: re.Match[str]) -> str:
            return "（ ）" if normalize_answer(match.group(1)) == answer else match.group(0)

        stem = re.sub(
            r"[（(【\[]\s*([A-F]{1,8})\s*[）)】\]]",
            replace_matching_answer,
            stem,
            flags=re.I,
        )
        stem = re.sub(r"（\s*）\s*[)）]", "（ ）", stem)
    return normalize_spaces(stem).rstrip("：:")


def parse_source(path: Path) -> list[Candidate]:
    lines = [normalize_spaces(line) for line in path.read_text(encoding="utf-8", errors="ignore").splitlines()]
    lines = expand_embedded_questions(lines)
    candidates: list[Candidate] = []
    current_lines: list[str] = []
    current_number = 0
    current_chapter = "未分类"
    current_type = "single"
    section_start = 0

    def flush() -> None:
        nonlocal current_lines, current_number
        if not current_lines:
            return
        raw = " ".join(current_lines)
        stem, options = split_options(raw)
        if len(options) >= 2 and len(normalized_stem(stem)) >= 4:
            answer = extract_inline_answer(raw, stem)
            qtype = current_type
            if answer and len(answer) > 1:
                qtype = "multiple"
            candidates.append(
                Candidate(
                    source=path.name,
                    number=current_number,
                    chapter=current_chapter,
                    question_type=qtype,
                    stem=clean_stem(stem, answer),
                    options=options,
                    answer=answer,
                    raw=raw,
                    source_index=len(candidates),
                )
            )
        current_lines = []
        current_number = 0

    for line in lines:
        if not line:
            continue

        intro_match = INTRO_RE.match(line)
        if intro_match and not QUESTION_RE.match(line):
            flush()
            current_chapter = "导论"
            current_type = detect_type(line, current_type)
            section_start = len(candidates)
            continue

        chapter_match = CHAPTER_RE.search(line)
        if chapter_match and not QUESTION_RE.match(line):
            flush()
            current_chapter = canonical_chapter(chapter_match.group(0))
            section_start = len(candidates)
            continue

        next_type = detect_type(line, current_type)
        if next_type != current_type and not QUESTION_RE.match(line):
            flush()
            current_type = next_type
            section_start = len(candidates)
            continue

        if "参考答案" in line or "正确答案" in line and not current_lines:
            pairs = [(int(number), normalize_answer(answer)) for number, answer in ANSWER_KEY_RE.findall(line)]
            if pairs:
                recent = candidates[section_start:]
                by_number: dict[int, list[Candidate]] = defaultdict(list)
                for candidate in recent:
                    by_number[candidate.number].append(candidate)
                for number, answer in pairs:
                    if answer and by_number.get(number):
                        by_number[number][-1].answer = answer
                continue

        question_match = QUESTION_RE.match(line)
        if question_match:
            flush()
            current_number = int(question_match.group(1))
            current_lines = [question_match.group(2)]
        elif current_lines:
            current_lines.append(line)

    flush()
    return candidates


def option_signature(options: dict[str, str]) -> str:
    return "|".join(normalized_stem(options.get(letter, "")) for letter in sorted(options))


def compatible(left: Candidate, right: Candidate) -> bool:
    if left.key == right.key:
        return True
    if not left.key or not right.key:
        return False
    shorter, longer = sorted((left.key, right.key), key=len)
    if len(shorter) / max(len(longer), 1) < 0.90:
        return False
    if shorter[:8] != longer[:8] and shorter[-8:] != longer[-8:]:
        return False
    ratio = SequenceMatcher(None, shorter, longer, autojunk=False).ratio()
    if ratio < 0.955:
        return False
    left_options = option_signature(left.options)
    right_options = option_signature(right.options)
    if left_options and right_options:
        option_ratio = SequenceMatcher(None, left_options, right_options, autojunk=False).ratio()
        return option_ratio >= 0.82
    return True


def quality(candidate: Candidate) -> tuple[int, int, int, int]:
    return (
        1 if candidate.answer else 0,
        len(candidate.options),
        1 if candidate.chapter != "未分类" else 0,
        len(candidate.stem),
    )


@dataclass
class MergedQuestion:
    representative: Candidate
    candidates: list[Candidate] = field(default_factory=list)


def dedupe(candidates: list[Candidate]) -> list[MergedQuestion]:
    groups: list[MergedQuestion] = []
    exact: dict[str, int] = {}
    length_buckets: dict[int, list[int]] = defaultdict(list)

    ordered = sorted(candidates, key=quality, reverse=True)
    for candidate in ordered:
        if candidate.key in exact:
            groups[exact[candidate.key]].candidates.append(candidate)
            continue

        target: int | None = None
        size = len(candidate.key)
        for bucket in range(max(0, size - 8), size + 9):
            for group_index in length_buckets.get(bucket, []):
                if compatible(groups[group_index].representative, candidate):
                    target = group_index
                    break
            if target is not None:
                break

        if target is None:
            target = len(groups)
            groups.append(MergedQuestion(representative=candidate, candidates=[candidate]))
            exact[candidate.key] = target
            length_buckets[size].append(target)
        else:
            groups[target].candidates.append(candidate)
            exact[candidate.key] = target

    return groups


def choose_answer(group: MergedQuestion) -> tuple[str | None, list[str]]:
    answers = [candidate.answer for candidate in group.candidates if candidate.answer]
    if not answers:
        return None, []
    counts = Counter(answers)
    answer, _ = counts.most_common(1)[0]
    conflicts = sorted(value for value in counts if value != answer)
    return answer, conflicts


MOCK_BLUEPRINT = {
    "single": [
        ("导论", 3),
        ("第一章", 8),
        ("第二章", 6),
        ("第三章", 5),
        ("第四章", 6),
        ("第五章", 4),
        ("第六章", 4),
        ("第七章", 4),
    ],
    "multiple": [
        ("导论", 2),
        ("第一章", 4),
        ("第二章", 3),
        ("第三章", 2),
        ("第四章", 3),
        ("第五章", 2),
        ("第六章", 2),
        ("第七章", 2),
    ],
}


def rebuild_mock_papers(questions: list[dict[str, object]], paper_count: int = 8) -> dict[str, object]:
    """Build balanced, non-overlapping full-syllabus mock papers."""
    pools: dict[tuple[str, str], list[dict[str, object]]] = {}
    for question in questions:
        answer = str(question.get("answer") or "")
        options = question.get("options") or {}
        if (
            question.get("needsReview")
            or question.get("chapter") == "未分类"
            or not answer
            or answer[0] not in options
        ):
            continue
        chapter = str(question["chapter"])
        question_type = str(question["type"])
        prefix = next(
            (
                chapter_prefix
                for blueprint in MOCK_BLUEPRINT.values()
                for chapter_prefix, _ in blueprint
                if chapter.startswith(chapter_prefix)
            ),
            None,
        )
        if prefix and question_type in MOCK_BLUEPRINT:
            pools.setdefault((prefix, question_type), []).append(question)

    for pool in pools.values():
        pool.sort(
            key=lambda item: (
                not bool(item.get("mockPapers")),
                not bool(item.get("machineExam")),
                hashlib.sha1(str(item["id"]).encode("utf-8")).hexdigest(),
            )
        )

    papers: dict[str, dict[str, list[dict[str, object]]]] = {
        f"全章模拟卷 {index:02d}": {"single": [], "multiple": []}
        for index in range(1, paper_count + 1)
    }
    for question_type, blueprint in MOCK_BLUEPRINT.items():
        for chapter_prefix, per_paper in blueprint:
            pool = pools.get((chapter_prefix, question_type), [])
            required = per_paper * paper_count
            if len(pool) < required:
                raise ValueError(
                    f"Not enough {question_type} questions for {chapter_prefix}: {len(pool)} < {required}"
                )
            for paper_index, paper_name in enumerate(papers):
                start = paper_index * per_paper
                papers[paper_name][question_type].extend(pool[start : start + per_paper])

    for question in questions:
        question["mockPapers"] = []
        question["mockOrder"] = {}

    paper_report: dict[str, object] = {}
    for paper_name, sections in papers.items():
        ordered: list[dict[str, object]] = []
        for question_type in ("single", "multiple"):
            section = sorted(
                sections[question_type],
                key=lambda item: hashlib.sha1(
                    f"{paper_name}|{item['id']}".encode("utf-8")
                ).hexdigest(),
            )
            ordered.extend(section)
        chapter_counts = Counter()
        for order, question in enumerate(ordered, start=1):
            question["mockPapers"] = [paper_name]
            question["mockOrder"] = {paper_name: order}
            chapter_counts[str(question["chapter"]).split(" ", 1)[0]] += 1
        paper_report[paper_name] = {
            "total": len(ordered),
            "single": len(sections["single"]),
            "multiple": len(sections["multiple"]),
            "chapters": dict(chapter_counts),
        }
    return paper_report


def serialize(groups: Iterable[MergedQuestion]) -> tuple[list[dict[str, object]], dict[str, object]]:
    output: list[dict[str, object]] = []
    conflicts: list[dict[str, object]] = []
    duplicate_groups = 0
    raw_count = 0

    for index, group in enumerate(groups, start=1):
        raw_count += len(group.candidates)
        if len(group.candidates) > 1:
            duplicate_groups += 1
        representative = max(group.candidates, key=quality)
        answer, other_answers = choose_answer(group)
        chapters = [candidate.chapter for candidate in group.candidates if candidate.chapter != "未分类"]
        chapter = Counter(chapters).most_common(1)[0][0] if chapters else "未分类"
        option_values = {normalize_spaces(value) for value in representative.options.values()}
        if answer and len(answer) > 1:
            qtype = "multiple"
        elif len(representative.options) == 2 and option_values <= {"正确", "错误", "对", "错", "√", "×"}:
            qtype = "true_false"
        elif answer:
            qtype = "single"
        else:
            qtype = representative.question_type
        sources = sorted({candidate.source for candidate in group.candidates})
        mock_candidates = [
            candidate
            for candidate in group.candidates
            if re.fullmatch(r"马原考试题\d+\.txt", candidate.source)
        ]
        mock_papers = sorted({candidate.source.removesuffix(".txt") for candidate in mock_candidates})
        mock_order = {
            paper: min(
                candidate.source_index
                for candidate in mock_candidates
                if candidate.source.removesuffix(".txt") == paper
            )
            for paper in mock_papers
        }
        machine_exam = any("机考试题" in candidate.source for candidate in group.candidates)
        digest = hashlib.sha1(representative.key.encode("utf-8")).hexdigest()[:12]
        invalid_answer = bool(answer and (set(answer) - set(representative.options)))
        item = {
            "id": f"my-{digest}",
            "number": index,
            "type": qtype,
            "chapter": chapter,
            "stem": representative.stem,
            "options": representative.options,
            "answer": answer,
            "explanation": build_explanation(
                representative.stem,
                answer,
                representative.options,
                chapter,
                qtype,
            ),
            "sources": sources,
            "machineExam": machine_exam,
            "mockPapers": mock_papers,
            "mockOrder": mock_order,
            "duplicateCount": len(group.candidates),
            "needsReview": bool(other_answers) or not answer or invalid_answer,
        }
        output.append(item)
        if other_answers:
            conflicts.append(
                {
                    "id": item["id"],
                    "stem": item["stem"],
                    "selected": answer,
                    "otherAnswers": other_answers,
                    "sources": [
                        {"source": candidate.source, "answer": candidate.answer}
                        for candidate in group.candidates
                        if candidate.answer
                    ],
                }
            )

    report = {
        "rawCandidates": raw_count,
        "uniqueQuestions": len(output),
        "duplicatesRemoved": raw_count - len(output),
        "duplicateGroups": duplicate_groups,
        "withAnswer": sum(1 for item in output if item["answer"]),
        "withoutAnswer": sum(1 for item in output if not item["answer"]),
        "answerConflicts": len(conflicts),
        "conflicts": conflicts,
    }
    return output, report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    paths = sorted(
        path
        for path in args.input_dir.glob("*.txt")
        if path.name not in {"summary.json"} and path.stat().st_size > 100
    )
    all_candidates: list[Candidate] = []
    source_counts: dict[str, int] = {}
    for path in paths:
        parsed = parse_source(path)
        source_counts[path.name] = len(parsed)
        all_candidates.extend(parsed)

    groups = dedupe(all_candidates)
    questions, report = serialize(groups)
    report["mockPapers"] = rebuild_mock_papers(questions)
    report["sourceCounts"] = source_counts

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(questions, ensure_ascii=False, indent=2), encoding="utf-8")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "conflicts"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
