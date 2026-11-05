"""Apply the rewritten @guide texts (scratch mappings) to the lesson bundles and their .cpp twins.

Only the @guide value of each named line changes; @tts, @bug and @layout on the same line are untouched.
Usage: python apply_guides.py <mapping-dir>
Mapping files: map_<bundle-stem>.json  -> {"<line>": "<new guide>"}; map_errors.json -> {"<bundle.json>:<line>": ...}
"""
import json
import pathlib
import re
import sys

LESSONS = pathlib.Path(__file__).resolve().parent.parent.parent / "examples" / "lessons"
GUIDE = re.compile(r"(@guide)(.*?)(?=@tts|@layout|@bug|$)")


def replace_guide(line, new):
    if "@guide" not in line:
        raise ValueError("no @guide on this line: " + line.strip())
    return GUIDE.sub(lambda m: m.group(1) + " " + new + " ", line, count=1)


def bundles():
    for d in sorted(p for p in LESSONS.iterdir() if p.is_dir()):
        js = list(d.glob("*.json"))
        if len(js) == 1:
            yield d, js[0]


def main(mapdir):
    mapdir = pathlib.Path(mapdir)
    errors = json.loads((mapdir / "map_errors.json").read_text(encoding="utf-8"))
    per_file = {}
    for mp in mapdir.glob("map_*.json"):
        if mp.name == "map_errors.json":
            continue
        stem = mp.stem[len("map_"):]
        per_file[stem] = json.loads(mp.read_text(encoding="utf-8"))
    for key, val in errors.items():
        fname, line = key.rsplit(":", 1)
        per_file.setdefault(pathlib.Path(fname).stem, {})[line] = val

    done = 0
    for d, js in bundles():
        stem = js.stem
        if stem not in per_file:
            continue
        b = json.loads(js.read_text(encoding="utf-8"))
        lines = b["source_code"].split("\n")
        for ln, new in per_file[stem].items():
            i = int(ln) - 1
            lines[i] = replace_guide(lines[i], new)
            done += 1
        b["source_code"] = "\n".join(lines)
        js.write_text(json.dumps(b, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        cpp = d / b["fullname_to_render"]
        if cpp.exists():
            cl = cpp.read_text(encoding="utf-8").split("\n")
            for ln, new in per_file[stem].items():
                i = int(ln) - 1
                if i < len(cl) and "@guide" in cl[i]:
                    cl[i] = replace_guide(cl[i], new)
            cpp.write_text("\n".join(cl), encoding="utf-8")
        print("updated", d.name, "/", js.name, "lines", sorted(per_file[stem], key=int))
    print("guide lines rewritten:", done)


if __name__ == "__main__":
    main(sys.argv[1])
