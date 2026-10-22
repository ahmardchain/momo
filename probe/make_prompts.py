"""Generate the fixed, versioned prompt set (200 prompts). Deterministic: no randomness."""
import json, hashlib, pathlib
CATS = {
 "arith": [f"Compute {a} * {b} + {a+b}. Answer with only the number." for a, b in [(i*7+3, i*13+5) for i in range(40)]],
 "facts": [f"In one sentence, what is the chemical symbol and atomic number of element number {n}?" for n in range(1, 41)],
 "code": [f"Write a Python one-liner that returns the {k}-th Fibonacci number using a loop-free expression. Only code." if k%2 else f"Write a Python function that checks whether {k} is a prime number. Only code." for k in range(3, 43)],
 "reason": [f"A train leaves at {h}:00 and travels {d} km at {s} km/h. At what time does it arrive? Explain briefly." for h, d, s in [(6+i%12, 60+i*15, 40+i*5) for i in range(40)]],
 "long_tail": [f"Translate to French, then to German: 'The {w} quietly crossed the ancient bridge at dawn.'" for w in ["fox","merchant","astronomer","goat","courier","monk","engineer","child","sailor","baker","owl","poet","soldier","weaver","miner","nurse","pilot","farmer","scribe","dancer","hunter","judge","tailor","smith","clerk","cook","guard","healer","herald","jester","knight","lawyer","mason","nomad","painter","priest","rider","singer","thief","wizard"]],
}
prompts = [{"id": f"{c}-{i:03d}", "cat": c, "prompt": p} for c, ps in CATS.items() for i, p in enumerate(ps)]
assert len(prompts) == 200
out = pathlib.Path(__file__).with_name("prompts.json")
data = json.dumps(prompts, indent=1, ensure_ascii=False)
out.write_text(data)
print(len(prompts), "prompts; sha256", hashlib.sha256(data.encode()).hexdigest())
