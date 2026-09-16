from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("questions", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    option_counts = Counter(len(item.get("options", {})) for item in questions)
    type_counts = Counter(item.get("type") for item in questions)
    chapter_counts = Counter(item.get("chapter") for item in questions)
    invalid_answers = []
    short_stems = []
    suspicious_options = []

    for item in questions:
        option_letters = set(item.get("options", {}))
        answer_letters = set(item.get("answer") or "")
        if answer_letters - option_letters:
            invalid_answers.append(item["id"])
        if len(item.get("stem", "")) < 8:
            short_stems.append({"id": item["id"], "stem": item.get("stem", "")})
        for letter, text in item.get("options", {}).items():
            if len(text) < 1 or len(text) > 500:
                suspicious_options.append(
                    {"id": item["id"], "letter": letter, "length": len(text), "text": text[:120]}
                )

    report = {
        "total": len(questions),
        "optionCounts": dict(sorted(option_counts.items())),
        "typeCounts": dict(type_counts),
        "uncategorized": chapter_counts.get("未分类", 0),
        "invalidAnswers": invalid_answers,
        "shortStems": short_stems,
        "suspiciousOptions": suspicious_options,
        "topChapters": chapter_counts.most_common(20),
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in {"shortStems", "suspiciousOptions", "topChapters"}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
