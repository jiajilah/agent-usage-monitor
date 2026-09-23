#!/usr/bin/env python3
"""Read Antigravity (Gemini) token usage out of its per-conversation SQLite databases.

Antigravity keeps each conversation in ~/.gemini/antigravity/conversations/<id>.db. The `steps`
table stores one protobuf blob per step; a step that made a model call carries a usage block whose
fields were identified by cross-checking against the parallel `gen_metadata` table:

    (1,1)  unix seconds for the step
    (9,2)  input tokens        (9,5)  cached input tokens
    (9,3)  output tokens       (9,9)  thinking tokens   (9,10) response tokens  [9+10 == 3]
    (19,)  model name

Older conversations (*.pb files) are encrypted and carry no readable usage.
Emits the same bucket rows the JS collector uses, as JSON on stdout.
"""
import json, os, sqlite3, sys, glob, time

BUCKET_MS = 10 * 60 * 1000


def read_varint(b, i):
    shift = result = 0
    while True:
        x = b[i]
        i += 1
        result |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return result, i


def parse(b, depth=0):
    """Minimal protobuf wire-format walk: yields (path, value) for scalars and strings."""
    out = []
    i = 0
    while i < len(b):
        try:
            key, i = read_varint(b, i)
            field, wire = key >> 3, key & 7
            if wire == 0:
                v, i = read_varint(b, i)
                out.append((field, v))
            elif wire == 1:
                out.append((field, int.from_bytes(b[i:i + 8], 'little')))
                i += 8
            elif wire == 2:
                n, i = read_varint(b, i)
                chunk = b[i:i + n]
                i += n
                try:
                    text = chunk.decode('utf-8')
                    printable = all(32 <= ord(c) < 127 for c in text)
                except Exception:
                    printable = False
                if printable:
                    out.append((field, text))
                elif depth < 4 and chunk:
                    out.append((field, parse(chunk, depth + 1)))
            elif wire == 5:
                out.append((field, int.from_bytes(b[i:i + 4], 'little')))
                i += 4
            else:
                return out
        except Exception:
            return out
    return out


def flatten(items, path=()):
    for field, value in items:
        cur = path + (field,)
        if isinstance(value, list):
            yield from flatten(value, cur)
        else:
            yield cur, value


def project_map(root):
    """conversation id -> workspace folder name, from the summaries database."""
    out = {}
    db = os.path.join(root, 'conversation_summaries.db')
    if not os.path.exists(db):
        return out
    try:
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        for cid, uris in con.execute('select conversation_id, workspace_uris from conversation_summaries'):
            try:
                paths = json.loads(uris or '[]')
            except Exception:
                paths = []
            if paths:
                out[cid] = os.path.basename(paths[0].rstrip('/')) or paths[0]
        con.close()
    except Exception:
        pass
    return out


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.gemini/antigravity')
    lookback_days = float(sys.argv[2]) if len(sys.argv) > 2 else 90
    cutoff_ms = (time.time() - lookback_days * 86400) * 1000
    projects = project_map(root)
    buckets = {}

    for db_path in glob.glob(os.path.join(root, 'conversations', '*.db')):
        cid = os.path.splitext(os.path.basename(db_path))[0]
        project = projects.get(cid, 'unknown')
        try:
            con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            rows = con.execute('select idx, metadata from steps where metadata is not null order by idx').fetchall()
            # Model names live in the parallel gen_metadata blobs. Its idx counts model calls while
            # steps.idx counts every step, so the two line up by order, not by index. Match on the
            # input-token count (which both record) and fall back to position.
            gen_models, gen_by_input = [], {}
            try:
                for _gidx, blob in con.execute('select idx, data from gen_metadata where data is not null order by idx'):
                    gflat = dict(flatten(parse(blob)))
                    name = gflat.get((1, 19))
                    if not isinstance(name, str) or not name:
                        name = None
                    gen_models.append(name)
                    tokens = gflat.get((1, 17, 2, 2))
                    if name and isinstance(tokens, int):
                        gen_by_input[tokens] = name
            except Exception:
                pass
            con.close()
        except Exception:
            continue
        call_number = 0
        for step_idx, meta in rows:
            if not meta:
                continue
            flat = dict(flatten(parse(meta)))
            usage = {k[1]: v for k, v in flat.items() if len(k) == 2 and k[0] == 9 and isinstance(v, int)}
            if not usage or not usage.get(2):
                continue
            seconds = flat.get((1, 1))
            if not isinstance(seconds, int) or seconds < 1_000_000_000:
                continue
            ts = seconds * 1000
            if ts < cutoff_ms:
                continue
            model = flat.get((19,))
            if not isinstance(model, str) or not model:
                model = gen_by_input.get(usage.get(2))
            if not model and call_number < len(gen_models):
                model = gen_models[call_number]
            call_number += 1
            if not isinstance(model, str) or not model:
                model = 'unknown'
            start = int(ts // BUCKET_MS) * BUCKET_MS
            key = (start, model, project)
            row = buckets.setdefault(key, [start, model, project, 0, 0, 0, 0, 0, 0])
            row[3] += usage.get(2, 0)          # input
            row[4] += usage.get(5, 0)          # cached input
            row[6] += usage.get(3, 0)          # output
            row[7] += usage.get(9, 0)          # thinking
            row[8] += 1

    json.dump({'buckets': list(buckets.values())}, sys.stdout)


if __name__ == '__main__':
    main()
