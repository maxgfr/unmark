# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["torch==2.8.0", "transformers==4.56.2", "numpy==2.2.6"]
# ///
"""Small local SynthID experiment. Scores are measurements, not probabilities."""
import argparse
import json
from pathlib import Path
import subprocess
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, SynthIDTextWatermarkingConfig, SynthIDTextWatermarkLogitsProcessor

ROOT = Path(__file__).resolve().parents[2]
MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
REVISION = "7ae557604adf67be50417f59c2c2f167def9a775"
KEYS = [654, 400, 836, 123, 340, 443, 597, 160, 57]
TOPICS = ["a community garden", "repairing a bicycle", "a library visit", "baking bread", "a coastal walk", "organising a workshop", "a train journey", "learning pottery", "restoring a table", "watching birds"]


def core(text, candidate=None):
    payload = {"text": text}
    if candidate is not None:
        payload["candidate"] = candidate
    reply = subprocess.run(["node", "--experimental-strip-types", str(Path(__file__).with_name("bridge.mjs"))], input=json.dumps(payload), capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(reply.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=10, choices=range(1, 11))
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/synthid-report")
    args = parser.parse_args()
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
    model = AutoModelForCausalLM.from_pretrained(MODEL, revision=REVISION, torch_dtype=torch.float32).eval()
    config = SynthIDTextWatermarkingConfig(keys=KEYS, ngram_len=5, sampling_table_seed=0)

    def detector(keys):
        return SynthIDTextWatermarkLogitsProcessor(ngram_len=5, keys=keys, sampling_table_size=65536, sampling_table_seed=0, context_history_size=1024, device=torch.device("cpu"))

    correct, wrong = detector(KEYS), detector([key + 10000 for key in KEYS])

    def score(text, scorer=correct):
        ids = tokenizer(text, return_tensors="pt", add_special_tokens=False).input_ids
        if ids.shape[1] < 5:
            return {"mean_g": None, "tokens": ids.shape[1], "scored_tokens": 0}
        mask = scorer.compute_context_repetition_mask(ids).bool()
        mask &= scorer.compute_eos_token_mask(ids, tokenizer.eos_token_id)[:, 4:].bool()
        values = scorer.compute_g_values(ids).float()
        count = int(mask.sum())
        return {"mean_g": float(values[mask].mean()) if count else None, "tokens": ids.shape[1], "scored_tokens": count}

    def generate(prompt, seed, marked=False, limit=320):
        torch.manual_seed(seed)
        inputs = tokenizer.apply_chat_template([{"role": "user", "content": prompt}], tokenize=True, add_generation_prompt=True, return_tensors="pt")
        kwargs = {"watermarking_config": config} if marked else {}
        with torch.inference_mode():
            output = model.generate(inputs, attention_mask=torch.ones_like(inputs), do_sample=True, temperature=0.7, top_p=0.95, max_new_tokens=limit, pad_token_id=tokenizer.eos_token_id, **kwargs)
        continuation = output[0, inputs.shape[1]:]
        return tokenizer.decode(continuation, skip_special_tokens=True), len(continuation) >= limit

    rows = []
    for index, topic in enumerate(TOPICS[:args.samples]):
        prompt = f"Write a detailed 220-word practical account of {topic}. Use ordinary prose, no headings or bullet lists."
        source, _ = generate(prompt, 100 + index, True)
        control, _ = generate(prompt, 100 + index, False)
        cleaned = core(source)
        original = cleaned["plain"]
        brief = core(original)
        aimed = brief["prompt"]
        attempts = []
        for attempt in range(2):
            candidate, truncated = generate(aimed, 1000 + index * 2 + attempt, limit=512)
            verdict = core(original, candidate)["verdict"]
            attempts.append({"text": candidate, "truncated": truncated, "verdict": verdict, "score": score(candidate)})
            if verdict["ok"] and not truncated:
                break
            aimed = brief["prompt"] + "\n\nPREVIOUS CANDIDATE:\n" + candidate + "\n\nCORRECT THESE FAILURES:\n" + json.dumps(verdict["failures"])
        accepted = attempts[-1]["verdict"]["ok"] and not attempts[-1]["truncated"]
        row = {"sample": index + 1, "topic": topic, "seed": 100 + index, "source": source, "unmarked": control,
               "scores": {"marked": score(source), "unmarked": score(control), "wrong_key": score(source, wrong), "basic": score(cleaned["basic"]), "plain": score(original)},
               "rewrite_accepted": accepted, "attempts": attempts}
        rows.append(row)
        print(f"{index + 1}/{args.samples}: marked={row['scores']['marked']['mean_g']} accepted={accepted}", flush=True)
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "report.json").write_text(json.dumps({"model": MODEL, "revision": REVISION, "keys": KEYS, "torch": torch.__version__, "device": "cpu", "rows": rows}, indent=2) + "\n")
    lines = ["# SynthID local experiment", "", f"Model: `{MODEL}` at `{REVISION}`. {len(rows)} paired samples; CPU; seeds 100 onward.", "", "Public test key only. Mean g-values are uncalibrated scores, not probabilities. No conclusions about Claude, Gemini, or the quantised WebLLM model. Rejected or truncated rewrites are never counted as successful cleaning.", "", "| Sample | Marked | Unmarked | Wrong key | Basic | With style | Rewritten | Accepted |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in rows:
        scores = [row["scores"][key]["mean_g"] for key in ["marked", "unmarked", "wrong_key", "basic", "plain"]] + [row["attempts"][-1]["score"]["mean_g"]]
        lines.append(f"| {row['sample']} | " + " | ".join("n/a" if v is None else f"{v:.4f}" for v in scores) + f" | {row['rewrite_accepted']} |")
    lines.extend(["", "The JSON includes generated texts, per-attempt scores, scored-token counts and every content-check rejection. Ten samples cannot establish a detector threshold or a false-positive rate.", "", "Sources: [Transformers](https://huggingface.co/docs/transformers/v4.56.2/en/internal/generation_utils), [SynthID reference](https://github.com/google-deepmind/synthid-text)."])
    (args.output / "report.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
