#!/usr/bin/env python3
import json, os, glob, sys, time

def format_tokens(n):
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n//1_000}k"
    return str(n)

def main():
    if len(sys.argv) < 2:
        sys.exit(0)

    project_key = sys.argv[1]
    project_dir = os.path.join(os.path.expanduser("~/.claude/projects"), project_key)
    cache_file = os.path.join(project_dir, "token-totals-cache.json")

    if os.path.exists(cache_file):
        try:
            age = time.time() - os.path.getmtime(cache_file)
            if age < 300:
                with open(cache_file) as f:
                    print(format_tokens(json.load(f)["total"]))
                return
        except Exception:
            pass

    total = 0
    for path in glob.glob(os.path.join(project_dir, "*.jsonl")):
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        if obj.get("type") == "assistant":
                            u = obj.get("message", {}).get("usage", {})
                            total += u.get("input_tokens", 0)
                            total += u.get("output_tokens", 0)
                            total += u.get("cache_creation_input_tokens", 0)
                            total += u.get("cache_read_input_tokens", 0)
                    except Exception:
                        pass
        except Exception:
            pass

    try:
        with open(cache_file, "w") as f:
            json.dump({"total": total, "computedAt": int(time.time())}, f)
    except Exception:
        pass

    print(format_tokens(total))

if __name__ == "__main__":
    main()
