import gc
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import tracemalloc
import unittest
from index import build_index, sample_candidates


def row(bot='Atlas', action='eat', result='Blocked: "eat" recently failed. Try something else.'):
    return {'bot': bot, 'timestamp': '2026-06-12T01:02:03Z', 'system': 'system', 'context': 'context', 'decision': {'thought': 'food', 'action': action, 'params': {}}, 'result': result, 'success': True}


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.archive = self.root / 'archive'
        self.archive.mkdir()
        self.source = self.archive / 'data.jsonl'
        self.manifest = self.archive / 'manifest.json'
        self.output = self.root / 'index.sqlite'

    def tearDown(self): self.tmp.cleanup()

    def fixture(self, data):
        self.source.write_bytes(data)
        item = {'source_relpath': 'logs/trajectories/session.jsonl', 'archive_relpath': 'data.jsonl', 'source_kind': 'trajectory_jsonl', 'sha256': hashlib.sha256(data).hexdigest(), 'captured_bytes': len(data), 'source_size_at_open': len(data), 'complete_line_cutoff': len(data), 'status': 'complete'}
        self.manifest.write_text(json.dumps({'schema_version': 1, 'complete': True, 'captured_at_utc': '2026-09-12T00:00:00Z', 'source_root': '/example', 'files': [item]}))

    def sample_db(self, rows):
        with sqlite3.connect(self.output) as db:
            db.execute('CREATE TABLE records(id,source_path,line_no,session_id,bot,timestamp,action,family,context_hash,action_key,revised_status)')
            db.executemany('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)', rows)

    def sample_row(self, i, family='food_resources'):
        return (f'id-{i}', 'session.jsonl', i + 1, f'session-{i}', f'bot-{i}',
                '2026-06-12T01:02:03Z', 'eat', family, f'context-{i}', f'action-{i}', 'unknown')

    def test_reconciles_and_preserves_source(self):
        data = json.dumps(row()).encode() + b'\nnot-json\n{}\n\n'
        self.fixture(data)
        summary = build_index(self.manifest, self.output)
        self.assertEqual((summary['source_lines'], summary['records'], summary['excluded']), (4, 1, 3))
        with sqlite3.connect(self.output) as db:
            self.assertEqual(db.execute('select original_success,revised_status from records').fetchone(), (1, 'blocked'))
        self.assertEqual(self.source.read_bytes(), data)

    def test_corrupt_archive_does_not_finalize(self):
        self.fixture(json.dumps(row()).encode() + b'\n')
        self.source.write_bytes(b'corrupt\n')
        with self.assertRaises(ValueError): build_index(self.manifest, self.output)
        self.assertFalse(self.output.exists())

    def test_existing_output_not_replaced(self):
        self.fixture(json.dumps(row()).encode()+b'\n')
        self.output.write_bytes(b'preserve')
        with self.assertRaises(FileExistsError): build_index(self.manifest, self.output)
        self.assertEqual(self.output.read_bytes(), b'preserve')

    def test_traversal_rejected(self):
        self.fixture(b'')
        doc = json.loads(self.manifest.read_text()); doc['files'][0]['archive_relpath'] = '../escape'
        self.manifest.write_text(json.dumps(doc))
        with self.assertRaises(ValueError): build_index(self.manifest, self.output)

    def test_symlink_rejected(self):
        self.fixture(b'')
        other = self.root/'other'; other.write_bytes(b'')
        self.source.unlink(); self.source.symlink_to(other)
        with self.assertRaises(ValueError): build_index(self.manifest, self.output)

    def test_duplicate_manifest_path_rejected(self):
        self.fixture(b'')
        doc = json.loads(self.manifest.read_text()); doc['files'] *= 2
        self.manifest.write_text(json.dumps(doc))
        with self.assertRaises(ValueError): build_index(self.manifest, self.output)

    def test_oversize_is_one_exclusion(self):
        self.fixture(b'x'*500+b'\n'+json.dumps(row()).encode()+b'\n')
        summary=build_index(self.manifest,self.output,max_line_bytes=400)
        self.assertEqual((summary['source_lines'],summary['records'],summary['excluded']), (2,1,1))

    def test_ambiguous_json_is_excluded(self):
        duplicate=json.dumps(row()).replace('"success": true','"success": false, "success": true')
        overflow=json.dumps(row()).replace('"params": {}','"params": {"x": 1e999}')
        self.fixture((duplicate+'\n'+overflow+'\n').encode())
        summary=build_index(self.manifest,self.output)
        self.assertEqual(summary['exclusions_by_reason'],{'invalid_json':2})

    def test_output_inside_archive_rejected(self):
        self.fixture(b'')
        with self.assertRaises(ValueError):build_index(self.manifest,self.archive/'new.sqlite')

    def test_stable_ids_and_sampling(self):
        self.fixture(b''.join(json.dumps({**row(bot=b),'context':'role '+b}).encode()+b'\n' for b in ['Atlas','Flora','Mason']))
        build_index(self.manifest, self.output)
        other=self.root/'other.sqlite'; build_index(self.manifest,other)
        a=sample_candidates(self.output,2,'fixed'); b=sample_candidates(other,2,'fixed')
        self.assertEqual(a,b)
        self.assertEqual(len(a),2)
        self.assertTrue(all(x['quality']=='observed' and x['split']=='development_candidate' for x in a))

    def test_sampler_collapses_exact_input_action_outcome_repeats(self):
        data=json.dumps(row()).encode()+b'\n'
        self.fixture(data*5)
        build_index(self.manifest,self.output)
        self.assertEqual(len(sample_candidates(self.output,5,'fixed')),1)

    def test_boolean_source_size_at_open_is_rejected(self):
        self.fixture(json.dumps(row()).encode()+b'\n')
        doc = json.loads(self.manifest.read_text())
        doc['files'][0]['source_size_at_open'] = True
        self.manifest.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            build_index(self.manifest, self.output)

    def test_boolean_trajectory_cutoff_is_rejected(self):
        self.fixture(b'')
        doc = json.loads(self.manifest.read_text())
        doc['files'][0]['complete_line_cutoff'] = False
        self.manifest.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            build_index(self.manifest, self.output)

    def test_context_hash_keeps_distinct_system_context_pairs(self):
        first = {**row(), 'system': 'a\n', 'context': 'b'}
        second = {**row(), 'system': 'a', 'context': '\nb'}
        self.fixture(json.dumps(first).encode()+b'\n'+json.dumps(second).encode()+b'\n')
        build_index(self.manifest, self.output)
        self.assertEqual(len(sample_candidates(self.output, 10, 'fixed')), 2)

    def test_boolean_schema_version_is_rejected(self):
        self.fixture(json.dumps(row()).encode()+b'\n')
        doc = json.loads(self.manifest.read_text())
        doc['schema_version'] = True
        self.manifest.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            build_index(self.manifest, self.output)

    def test_sampler_represents_all_families_before_repeating_one(self):
        families = ['navigation', 'food_resources', 'shared_resources',
                    'inventory_crafting', 'multi_step', 'other_recovery']
        rows = [self.sample_row(i, family) for i, family in enumerate(families)]
        rows.extend(self.sample_row(100 + i, 'food_resources') for i in range(12))
        self.sample_db(rows)
        selected = sample_candidates(self.output, len(families), 'fixed')
        self.assertEqual(selected, sample_candidates(self.output, len(families), 'fixed'))
        self.assertEqual({item['family'] for item in selected}, set(families))

    def test_sampler_limit_has_a_fixed_upper_bound(self):
        self.sample_db([])
        with self.assertRaises(ValueError):
            sample_candidates(self.output, 10_001, 'fixed')

    def test_sampler_python_memory_is_bounded_by_limit(self):
        self.sample_db(self.sample_row(i) for i in range(10_000))
        gc.collect()
        tracemalloc.start()
        selected = sample_candidates(self.output, 1, 'fixed')
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        self.assertEqual(len(selected), 1)
        self.assertLess(peak, 3_000_000)

if __name__ == '__main__': unittest.main()
