from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


SECTIONS = ("【考点】", "【原理】", "【选项分析】", "【结论】")
GENERIC_TITLES = {
    "马克思主义的创立与发展",
    "唯物论与唯物辩证法",
    "实践与认识",
    "唯物史观",
    "资本主义经济制度的本质",
    "资本主义的发展及趋势",
    "社会主义的发展规律",
    "共产主义理想",
    "马克思主义基本原理的综合运用",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("questions", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    usable = [
        question
        for question in questions
        if question.get("answer")
        and not question.get("needsReview")
        and question["answer"][0] in question.get("options", {})
    ]

    missing_sections: list[str] = []
    missing_option_analysis: list[str] = []
    generic: list[str] = []
    short: list[str] = []
    explanations = Counter()

    for question in usable:
        explanation = question.get("explanation", "")
        explanations[explanation] += 1
        if not all(section in explanation for section in SECTIONS):
            missing_sections.append(question["id"])
        if not all(f"{letter}项" in explanation for letter in question.get("options", {})):
            missing_option_analysis.append(question["id"])
        title = explanation.split("\n", 1)[0].removeprefix("【考点】")
        if title in GENERIC_TITLES:
            generic.append(question["id"])
        if len(explanation) < 180:
            short.append(question["id"])

    repeated = {
        explanation: count
        for explanation, count in explanations.items()
        if count > 1
    }
    report = {
        "usableQuestions": len(usable),
        "structuredExplanations": len(usable) - len(missing_sections),
        "missingSections": missing_sections,
        "missingOptionAnalysis": missing_option_analysis,
        "genericConceptCount": len(generic),
        "genericConceptRate": round(len(generic) / len(usable), 4) if usable else 0,
        "shortExplanationIds": short,
        "uniqueExplanations": len(explanations),
        "repeatedExplanationGroups": len(repeated),
        "maximumRepeat": max(explanations.values(), default=0),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if missing_sections or missing_option_analysis or report["genericConceptRate"] > 0.05:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
