# SynthID local experiment — 2026-09-10

Model: `Qwen/Qwen2.5-0.5B-Instruct` at `7ae557604adf67be50417f59c2c2f167def9a775`. 10 paired samples; CPU; seeds 100 onward.

Public test key only. Mean g-values are uncalibrated scores, not probabilities. No conclusions about Claude, Gemini, or the quantised WebLLM model. Rejected or truncated rewrites are never counted as successful cleaning.

| Sample | Marked | Unmarked | Wrong key | Basic  | With style | Rewritten | Accepted |
| ------ | ------ | -------- | --------- | ------ | ---------- | --------- | -------- |
| 1      | 0.5668 | 0.4943   | 0.5095    | 0.5668 | 0.5545     | 0.5396    | False    |
| 2      | 0.5707 | 0.4835   | 0.4930    | 0.5707 | 0.5545     | 0.4923    | False    |
| 3      | 0.5784 | 0.5175   | 0.5042    | 0.5784 | 0.5784     | 0.5110    | False    |
| 4      | 0.5606 | 0.4964   | 0.4967    | 0.5606 | 0.5606     | 0.5068    | False    |
| 5      | 0.6069 | 0.4944   | 0.4975    | 0.6069 | 0.6037     | 0.5085    | False    |
| 6      | 0.5717 | 0.5035   | 0.4937    | 0.5717 | 0.5545     | 0.5259    | False    |
| 7      | 0.5872 | 0.5694   | 0.4961    | 0.5872 | 0.5858     | 0.5805    | False    |
| 8      | 0.5968 | 0.5130   | 0.5055    | 0.5968 | 0.5940     | 0.4937    | False    |
| 9      | 0.5387 | 0.4993   | 0.5031    | 0.5387 | 0.5305     | 0.5061    | False    |
| 10     | 0.5967 | 0.4845   | 0.4814    | 0.5967 | 0.5967     | 0.5233    | False    |

The JSON includes generated texts, per-attempt scores, scored-token counts and every content-check rejection. Ten samples cannot establish a detector threshold or a false-positive rate.

Sources: [Transformers](https://huggingface.co/docs/transformers/v4.56.2/en/internal/generation_utils), [SynthID reference](https://github.com/google-deepmind/synthid-text).

## Observed limits

Basic cleaning left all ten scores unchanged. Style cleaning changed some
scores modestly. None of the ten rewrite attempts (at most two generations
per sample) cleared the content gates; four of the twenty generated candidates
also reached the output limit. Rejection includes heuristic name checks and
formatting changes, so it is not itself proof of factual hallucination.

A separate real-browser smoke check accepted a short two-sentence rewrite
with WebLLM. That check validates integration, not quality on this corpus or
SynthID removal. The small model remains optional and rejected outputs are
withheld.

Raw evidence: [texts, token counts, scores and rejections](synthid-lab-2026-09-10.json).
Command: `uv run --locked scripts/synthid-lab/run.py`. CPU, macOS arm64, Node 24.19.0.
