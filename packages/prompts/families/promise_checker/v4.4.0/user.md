[이번 회차의 약속 계획 — PLANNED]
{{chapter_obligations}}

[열린 약속 장부 — 정사, 회수 창 포함]
{{promise_ledger}}

[회차 원문 — 문단 id 포함]
{{chapter_text}}

[출력 스키마 — 이 JSON 필드를 반환한다]
{"touches": [{"promise_id": "약속 id", "planned": "open|advance|pay", "found": true, "quote": "원문 그대로의 짧은 인용"}], "issues": [{"kind": "promise_forgotten|payoff_without_setup|canon_contradiction|other", "severity": "minor|major|blocking", "claim": "한국어 지적", "quote": "원문 그대로의 짧은 인용", "promise_id": "약속 id", "confidence": 0.8}]}
- issues[].confidence: 0~1
- kind는 위에 적힌 값 가운데 하나를 쓰고, 맞는 값이 없을 때만 "other"를 쓴다.
- quote는 원고의 한 문장이나 한 구절을 문단 표시([p3]) 없이 글자 그대로 옮긴다.