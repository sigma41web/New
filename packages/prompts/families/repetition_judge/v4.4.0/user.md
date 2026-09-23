[반복 검사 보고 — 결정적 검사]
{{repetition_report}}

[앞선 회차 — 승인된 원고의 도입과 마무리]
{{recent_chapters}}

[회차 원문 — 문단 id 포함]
{{chapter_text}}

[출력 스키마 — 이 JSON 필드를 반환한다]
{"issues": [{"kind": "repeated_scene|repeated_paragraph|repetitive_arc|repetitive_sentence_openings|other", "severity": "minor|major|blocking", "claim": "한국어 지적", "quote": "원문 그대로의 짧은 인용", "earlier_chapter": 3, "confidence": 0.8}]}
- issues[].confidence: 0~1
- kind는 위에 적힌 값 가운데 하나를 쓰고, 맞는 값이 없을 때만 "other"를 쓴다.
- quote는 원고의 한 문장이나 한 구절을 문단 표시([p3]) 없이 글자 그대로 옮긴다.