[인물 말투 카드 — 이번 회차 등장인물]
{{voice_cards}}

[호칭·말높이 기준 — 설계(PLANNED), 인물 → 상대]
{{address_matrix}}

[말높이·호칭 요약 — 정사, 회차 시작 시점]
{{register_digests}}

[말높이 검사 보고 — 결정적 검사]
{{register_check_report}}

[회차 원문 — 문단 id 포함]
{{chapter_text}}

[출력 스키마 — 이 JSON 필드를 반환한다]
{"judge_score": 72, "dimension_scores": {"distinguishability": 4, "verbal_habits": 4, "register_naturalness": 4, "register_consistency": 4}, "drift_flags": [], "issues": [{"kind": "register_error|address_term_error|voice_drift|character_inconsistency|other", "claim": "한국어 지적", "severity": "minor|major|blocking", "confidence": 0.8, "quote": "원문 그대로의 짧은 인용"}]}
- judge_score: 0~100
- dimension_scores.distinguishability: 1~5
- dimension_scores.verbal_habits: 1~5
- dimension_scores.register_naturalness: 1~5
- dimension_scores.register_consistency: 1~5
- issues[].confidence: 0~1
- judge_score는 0~100점, dimension_scores는 항목마다 1~5점이다(높을수록 좋다).
- drift_flags에는 말투 이탈을 짧은 꼬리표로만 적고, 없으면 빈 배열이다.
- kind는 위에 적힌 값 가운데 하나를 쓰고, 맞는 값이 없을 때만 "other"를 쓴다.
- quote는 원고의 한 문장이나 한 구절을 문단 표시([p3]) 없이 글자 그대로 옮긴다.