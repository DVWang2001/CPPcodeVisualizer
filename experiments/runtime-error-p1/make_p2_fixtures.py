"""Turn results-20261123/log-p2fix.txt (suite-p2fix.sh on lab-david) into the jest fixture
gdbgui/src/js/tests/fixtures/runtimeRuns.json. Every value is copied from the log unchanged; runs longer than 300 steps
keep the first and last 60 steps as [index, step] pairs (the test helper rebuilds a sparse steps array of nSteps)."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
LOG = os.path.join(HERE, "results-20261123", "log-p2fix.txt")
OUT = os.path.join(REPO, "gdbgui", "src", "js", "tests", "fixtures", "runtimeRuns.json")
runs, done = {}, None
for line in open(LOG, encoding="utf-8"):
    if line.startswith("P2FIX "):
        d = json.loads(line[6:])
        runs[d["id"]] = {k: d[k] for k in ["src", "stdin", "ok", "exit", "runtimeErrors", "stdout", "functions", "decls", "classes", "nSteps", "steps"]}
        if d.get("modelError"):
            sys.exit("model error in %s: %s" % (d["id"], d["modelError"]))
    elif line.startswith("P2FIXDONE "):
        done = int(line.split()[1])
if done is None or done != len(runs):
    sys.exit("log incomplete: P2FIXDONE=%r, runs=%d" % (done, len(runs)))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps({"_source": "experiments/runtime-error-p1/results-20261123/log-p2fix.txt (lab-david, P1 engine)", "runs": runs}, ensure_ascii=False, indent=0))
    f.write("\n")
print("wrote", OUT, len(runs), "runs", os.path.getsize(OUT), "bytes")
