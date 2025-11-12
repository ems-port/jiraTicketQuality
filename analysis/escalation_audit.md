# Escalation Logic Audit (convo_quality_550.csv)

_Date:_ 2025-11-11

## Summary

- Total conversations analysed: **571**
- Legacy escalations (≥2 unique agents): **55**
- Handovers (T1 → any agent): **43**
- Tier-handoff escalations (T1 → T2 only): **12**
- Absolute delta (tier − legacy): **−43**
- Relative delta vs legacy: **−78.18 %**
- Disagreements (legacy ≠ tier): **43** tickets — every mismatched ticket was a legacy escalation that no longer counts under the new definition.

## Sample tickets where the logic differs

| Issue key | Legacy | Tier handoff | Path (captured for reporting) | Agent sequence |
| --- | --- | --- | --- | --- |
| CC-39386 | ✅ | ❌ | — | 712020:2d004b64-fe43-43ea-94c6-0a1d558883d4 → 712020:938aebe2-3534-4413-a71d-6c414201de4b |
| CC-39385 | ✅ | ❌ | — | 712020:0f747479-10c0-4ae9-8ae7-7531f3554784 → 712020:ad2872c7-5ae1-47b0-b52a-a68d84012906 |
| CC-39366 | ✅ | ❌ | — | 712020:2d004b64-fe43-43ea-94c6-0a1d558883d4 → 712020:4a1cd5f8-3026-4f9f-9e90-f389b942d0d6 |
| CC-39362 | ✅ | ❌ | — | 712020:2d004b64-fe43-43ea-94c6-0a1d558883d4 → 712020:4a1cd5f8-3026-4f9f-9e90-f389b942d0d6 → 712020:8f5c3870-9bb6-4299-922f-e6f38426666b |
| CC-39357 | ✅ | ❌ | — | 712020:4a1cd5f8-3026-4f9f-9e90-f389b942d0d6 → 712020:8f5c3870-9bb6-4299-922f-e6f38426666b |
| CC-39334 | ✅ | ❌ | — | 712020:3e48ed1c-5151-4a26-8782-c21abcf59de5 → 712020:ffd0ea69-61d6-4cfe-91bb-cb09245bb5f4 |
| CC-39318 | ✅ | ❌ | — | 712020:0f747479-10c0-4ae9-8ae7-7531f3554784 → 712020:ffd0ea69-61d6-4cfe-91bb-cb09245bb5f4 |
| CC-39314 | ✅ | ❌ | — | 712020:0f747479-10c0-4ae9-8ae7-7531f3554784 → 712020:ad2872c7-5ae1-47b0-b52a-a68d84012906 |
| CC-39284 | ✅ | ❌ | — | 712020:0f747479-10c0-4ae9-8ae7-7531f3554784 → 712020:ad2872c7-5ae1-47b0-b52a-a68d84012906 |
| CC-39276 | ✅ | ❌ | — | 712020:4a1cd5f8-3026-4f9f-9e90-f389b942d0d6 → 712020:d0e4092f-b8dc-4f7e-9058-cd8d92b95196 |

_Method:_ `python3` script in repo root parsing `data/convo_quality_550.csv` + `data/port_roles.csv`, de-duping agent sequences, and applying the same Tier handoff logic used in the UI to tally results and surface mismatches.
