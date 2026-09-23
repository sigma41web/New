[지식 입장 — 인물별로 아는 것·잘못 믿는 것, 회차 시작 시점 정사]
{{knowledge_stances}}

[지식 가드 — 이번 회차에 이 인물들이 몰라야 하는 것]
{{knowledge_guard_list}}

[독자에게 아직 밝히면 안 되는 비밀 — PLANNED, 공개 가능 회차 표시]
{{reader_secrets}}

[회차 원문 — 문단 id 포함]
{{chapter_text}}

[출력 스키마 — 이 JSON 필드를 반환한다]
{"issues": [{"kind": "knowledge_leak|knowledge_ignorance|reader_knowledge_violation", "severity": "minor|major|blocking", "quote": "원문 그대로의 짧은 인용", "claim": "한국어 지적", "confidence": 0.8}]}
- issues[].confidence: 0~1
- kind: knowledge_leak(모르는 것을 앎), knowledge_ignorance(아는 것을 무시함), reader_knowledge_violation(독자에게 이른 비밀).
- quote는 원고의 한 문장이나 한 구절을 문단 표시([p3]) 없이 글자 그대로 옮긴다.