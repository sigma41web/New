[용어·장르 장치 검사 — 결정적 검사]
{{terminology_checks}}

[회차 원문 — 문단 id 포함]
{{chapter_text}}

[출력 스키마 — 이 JSON 필드를 반환한다]
{"judge_score": 72, "dimension_scores": {"reader_fantasy": 4, "device_correctness": 4, "vocabulary_register": 4, "taboo_restraint": 5}, "drift_flags": [], "issues": [{"kind": "forbidden_development|terminology_violation|western_novel_drift|repetitive_arc|payoff_without_setup|other", "claim": "한국어 지적", "severity": "minor|major|blocking", "confidence": 0.8, "quote": "원문 그대로의 짧은 인용"}]}
- judge_score: 0~100
- dimension_scores.reader_fantasy: 1~5
- dimension_scores.device_correctness: 1~5
- dimension_scores.vocabulary_register: 1~5
- dimension_scores.taboo_restraint: 1~5
- issues[].confidence: 0~1
- judge_score는 0~100점, dimension_scores는 항목마다 1~5점이다(높을수록 좋다).
- drift_flags에는 장르 이탈을 짧은 꼬리표로만 적고, 없으면 빈 배열이다.
- kind는 위에 적힌 값 가운데 하나를 쓰고, 맞는 값이 없을 때만 "other"를 쓴다.
- quote는 원고의 한 문장이나 한 구절을 문단 표시([p3]) 없이 글자 그대로 옮긴다.