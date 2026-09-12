"""Stream a verified legacy archive into a reproducible, private SQLite index."""
import argparse
import collections
import datetime
import hashlib
import heapq
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import tempfile

from label_rules import LABEL_VERSION, classify_legacy

MAX_LINE_BYTES = 4 * 1024 * 1024


def reject_constant(value):
    raise ValueError('Nonfinite JSON constant')


def decode(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    def number(value):
        result = float(value)
        if not math.isfinite(result): raise ValueError('Nonfinite JSON number')
        return result
    return json.loads(data, parse_constant=reject_constant, object_pairs_hook=pairs, parse_float=number)


def safe_file(root, rel):
    if not isinstance(rel, str) or not rel or '\\' in rel or ':' in rel:
        raise ValueError('Invalid archive path')
    parts = PurePosixPath(rel)
    if parts.is_absolute() or any(p in ('..', '.', '') for p in rel.split('/')):
        raise ValueError('Archive path escapes root')
    target = root
    for part in parts.parts:
        target = target / part
        if target.is_symlink():
            raise ValueError('Archive symlink is not allowed')
    if not target.is_file():
        raise ValueError('Missing archive file')
    return target


def load_manifest(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('Manifest symlink is not allowed')
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Oversized manifest')
    doc = decode(path.read_bytes())
    if not isinstance(doc, dict) or doc.get('schema_version') != 1 or doc.get('complete') is not True:
        raise ValueError('Require complete version-1 archive')
    if not isinstance(doc.get('files'), list):
        raise ValueError('Missing file records')
    seen = set()
    for entry in doc['files']:
        if not isinstance(entry, dict): raise ValueError('Invalid file record')
        rel = entry.get('archive_relpath')
        target = safe_file(path.parent, rel)
        if rel in seen: raise ValueError('Duplicate archive path')
        seen.add(rel)
        digest, size = entry.get('sha256'), entry.get('captured_bytes')
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('Invalid hash')
        if type(size) is not int or size < 0 or target.stat().st_size != size:
            raise ValueError('Invalid archive size')
        if entry.get('status') not in ('complete', 'complete_prefix'):
            raise ValueError('Invalid capture status')
        if not isinstance(entry.get('source_relpath'), str) or not isinstance(entry.get('source_kind'), str):
            raise ValueError('Missing source identity')
        if entry['source_kind'] == 'trajectory_jsonl' and entry.get('complete_line_cutoff') != size:
            raise ValueError('Invalid trajectory cutoff')
    return doc


def valid_row(row):
    if not isinstance(row, dict): return False
    for key in ('bot', 'timestamp', 'system', 'context', 'result'):
        if not isinstance(row.get(key), str): return False
    if not row['bot'] or type(row.get('success')) is not bool: return False
    decision = row.get('decision')
    if not isinstance(decision, dict) or not isinstance(decision.get('action'), str): return False
    if not isinstance(decision.get('params', {}), dict): return False
    try:
        stamp = datetime.datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00'))
        if stamp.tzinfo is None: return False
    except ValueError: return False
    return True


def family(action, reason):
    if reason == 'navigation_timeout' or action in ('go_to', 'explore', 'flee'): return 'navigation'
    if action in ('eat', 'gather_wood', 'hunt', 'go_fishing'): return 'food_resources'
    if action in ('deposit_stash', 'withdraw_stash', 'give_item'): return 'shared_resources'
    if action in ('craft', 'craft_gear', 'mine_block', 'place_block', 'smelt_ores'): return 'inventory_crafting'
    if action in ('invoke_skill', 'build_house', 'build_farm', 'strip_mine'): return 'multi_step'
    return 'other_recovery'


def bounded_lines(handle, max_bytes, digest):
    line_no = 0
    while True:
        data = handle.readline(max_bytes + 1)
        if not data: break
        line_no += 1; digest.update(data)
        if len(data) > max_bytes:
            while not data.endswith(b'\n'):
                data = handle.readline(65536)
                if not data: break
                digest.update(data)
            yield line_no, None, 'line_too_large'
        elif not data.endswith(b'\n'):
            yield line_no, None, 'incomplete_tail'
        elif not data.strip():
            yield line_no, None, 'blank_line'
        else:
            yield line_no, data, None


def build_index(manifest_path, output_path, max_line_bytes=MAX_LINE_BYTES):
    manifest_path, output_path = Path(manifest_path).absolute(), Path(output_path).absolute()
    if max_line_bytes < 1: raise ValueError('Positive line limit required')
    if output_path.exists() or output_path.is_symlink(): raise FileExistsError(output_path)
    if output_path.resolve().is_relative_to(manifest_path.parent.resolve()):
        raise ValueError('Index must be outside the immutable archive')
    manifest = load_manifest(manifest_path)
    manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    fd, scratch = tempfile.mkstemp(prefix='.dataset-index-', dir=output_path.parent)
    os.close(fd)
    db = sqlite3.connect(scratch)
    counts = collections.Counter(source_lines=0, records=0, excluded=0, files=0)
    try:
        db.executescript('''
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE sources(archive_path TEXT PRIMARY KEY,source_path TEXT,sha256 TEXT,bytes INTEGER,kind TEXT,status TEXT);
            CREATE TABLE records(id TEXT PRIMARY KEY,source_path TEXT,source_sha256 TEXT,line_no INTEGER,
                session_id TEXT,bot TEXT,timestamp TEXT,action TEXT,action_key TEXT,context_hash TEXT,
                original_success INTEGER,revised_status TEXT,reason_code TEXT,label_version TEXT,
                evidence_kind TEXT,review_required INTEGER,family TEXT,quality TEXT);
            CREATE TABLE exclusions(source_path TEXT,line_no INTEGER,reason TEXT);
        ''')
        for entry in manifest['files']:
            target = safe_file(manifest_path.parent, entry['archive_relpath'])
            digest = hashlib.sha256()
            flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
            with os.fdopen(os.open(target, flags), 'rb') as handle:
                before = os.fstat(handle.fileno())
                if not stat.S_ISREG(before.st_mode): raise ValueError('Non-regular archive source')
                if entry['source_kind'] != 'trajectory_jsonl':
                    for chunk in iter(lambda: handle.read(1024*1024), b''): digest.update(chunk)
                else:
                    for line_no, raw, error in bounded_lines(handle, max_line_bytes, digest):
                        counts['source_lines'] += 1
                        row = None
                        if error is None:
                            try: row = decode(raw)
                            except (ValueError, UnicodeError, RecursionError): error = 'invalid_json'
                            if error is None and not valid_row(row): error = 'invalid_schema'
                        if error is None:
                            label = classify_legacy(row)
                            action = row['decision']['action']
                            action_key = hashlib.sha256(json.dumps([action,row['decision'].get('params',{})],sort_keys=True).encode()).hexdigest()
                            context_hash = hashlib.sha256((row['system']+'\n'+row['context']).encode()).hexdigest()
                            record_id = f"{entry['sha256']}:{line_no}"
                            cursor = db.execute('INSERT OR IGNORE INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                                record_id,entry['source_relpath'],entry['sha256'],line_no,
                                Path(entry['source_relpath']).stem,row['bot'],row['timestamp'],action,action_key,context_hash,
                                int(row['success']),label['revised_status'],label['reason_code'],LABEL_VERSION,
                                label['evidence_kind'],1,family(action,label['reason_code']),'observed'))
                            if cursor.rowcount: counts['records'] += 1
                            else: error = 'duplicate_content'
                        if error is not None:
                            counts['excluded'] += 1
                            db.execute('INSERT INTO exclusions VALUES (?,?,?)',(entry['source_relpath'],line_no,error))
                        if counts['source_lines'] % 10000 == 0: db.commit()
                after = os.fstat(handle.fileno())
                if (before.st_size,before.st_mtime_ns,before.st_ino) != (after.st_size,after.st_mtime_ns,after.st_ino):
                    raise ValueError('Archive changed while indexing')
                if after.st_size != entry['captured_bytes'] or digest.hexdigest() != entry['sha256']:
                    raise ValueError('Archive hash/size mismatch')
            db.execute('INSERT INTO sources VALUES (?,?,?,?,?,?)',(entry['archive_relpath'],entry['source_relpath'],entry['sha256'],entry['captured_bytes'],entry['source_kind'],entry['status']))
            counts['files'] += 1
        if counts['source_lines'] != counts['records'] + counts['excluded']:
            raise ValueError('Unreconciled source lines')
        if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != manifest_hash:
            raise ValueError('Manifest changed')
        summary = dict(counts)
        summary['label_version'] = LABEL_VERSION
        summary['manifest_sha256'] = manifest_hash
        summary['status_cross_tab'] = [dict(zip(('original_success','revised_status','count'), row)) for row in db.execute('SELECT original_success,revised_status,count(*) FROM records GROUP BY original_success,revised_status ORDER BY 1,2')]
        summary['exclusions_by_reason'] = dict(db.execute('SELECT reason,count(*) FROM exclusions GROUP BY reason'))
        db.execute('INSERT INTO metadata VALUES (?,?)',('summary',json.dumps(summary,sort_keys=True)))
        db.execute('CREATE INDEX records_sampling ON records(family,bot,timestamp)')
        db.commit(); db.close()
        with open(scratch,'rb') as handle: os.fsync(handle.fileno())
        os.link(scratch,output_path)  # exclusive finalization: never replace another index
        return summary
    finally:
        db.close()
        Path(scratch).unlink(missing_ok=True)


def sample_candidates(index_path, limit=300, seed='dataset-v1'):
    if not 1 <= limit <= 10000: raise ValueError('Candidate limit must be 1..10000')
    heaps = collections.defaultdict(list)
    uri = Path(index_path).absolute().as_uri()+'?mode=ro'
    with sqlite3.connect(uri,uri=True) as db:
        rows = db.execute('SELECT id,source_path,line_no,session_id,bot,timestamp,action,family,context_hash,action_key,revised_status FROM records')
        for row in rows:
            key = row[7],row[4],row[5][:7]
            rank = int.from_bytes(hashlib.sha256((seed+'\0'+row[0]).encode()).digest(),'big')
            heap = heaps[key]
            item = (-rank,row)
            if len(heap)<limit: heapq.heappush(heap,item)
            elif item>heap[0]: heapq.heapreplace(heap,item)
    pools = {key:[r for _,r in sorted(items,reverse=True)] for key,items in heaps.items()}
    selected=[]; seen=set(); groups=set()
    # First diversify sessions within each family; then fill remaining slots.
    for diverse in (True,False):
        positions = {key:0 for key in pools}
        while len(selected)<limit:
            progressed=False
            for key in sorted(pools):
                while positions[key]<len(pools[key]):
                    row=pools[key][positions[key]]; positions[key]+=1
                    signature=(row[8],row[9],row[10])
                    group=(row[3],row[7])
                    if signature in seen or (diverse and group in groups): continue
                    seen.add(signature);groups.add(group);progressed=True
                    selected.append({'record_id':row[0],'source_relpath':row[1],'line_no':row[2],
                        'session_id':row[3],'bot':row[4],'timestamp':row[5],'action':row[6],
                        'family':row[7],'revised_status':row[10],'quality':'observed',
                        'split':'development_candidate','window_start_line':max(1,row[2]-3),'window_end_line':row[2]+3,
                        'window_note':'Unreviewed line window; filter by bot and inspect continuation. Not a verified episode.'})
                    break
                if len(selected)>=limit: break
            if not progressed: break
    return selected


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    build=commands.add_parser('build');build.add_argument('--manifest',type=Path,required=True);build.add_argument('--output',type=Path,required=True)
    sample=commands.add_parser('sample');sample.add_argument('--index',type=Path,required=True);sample.add_argument('--output',type=Path,required=True);sample.add_argument('--limit',type=int,default=300);sample.add_argument('--seed',default='dataset-v1')
    args=parser.parse_args()
    if args.command=='build': print(json.dumps(build_index(args.manifest,args.output),indent=2))
    else:
        selected=sample_candidates(args.index,args.limit,args.seed)
        with args.output.open('x') as handle: json.dump({'schema_version':1,'seed':args.seed,'candidates':selected},handle,indent=2)
        print(json.dumps({'candidates':len(selected),'quality':'observed','split':'development_candidate'}))


if __name__=='__main__': main()
