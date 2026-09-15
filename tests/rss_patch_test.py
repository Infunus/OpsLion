import difflib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from patch_we_mp_rss import apply_patch, apply_patches


class UpstreamPatchTests(unittest.TestCase):
    def test_all_patches_are_checked_before_any_file_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'apis').mkdir()
            (root / 'web_ui').mkdir()
            (root / 'web_ui/package.json').write_text('{}')
            patches = []
            for name, content in (('mps', 'original\n'), ('auth', 'user change\n')):
                (root / f'apis/{name}.py').write_text(content)
                patch = root / f'{name}.patch'
                patch.write_text(''.join(difflib.unified_diff(['original\n'], ['fixed\n'], fromfile=f'a/apis/{name}.py', tofile=f'b/apis/{name}.py')))
                patches.append(patch)
            with self.assertRaisesRegex(ValueError, '不兼容'):
                apply_patches(root, patches)
            self.assertEqual((root / 'apis/mps.py').read_text(), 'original\n')
            self.assertEqual((root / 'apis/auth.py').read_text(), 'user change\n')

    def test_patch_is_idempotent_and_conflicts_leave_files_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'apis').mkdir()
            (root / 'web_ui').mkdir()
            target = root / 'apis/mps.py'
            target.write_text('original\n')
            (root / 'web_ui/package.json').write_text('{}')
            patch = root / 'change.patch'
            patch.write_text(''.join(difflib.unified_diff(['original\n'], ['fixed\n'],
                                                          fromfile='a/apis/mps.py', tofile='b/apis/mps.py')))
            self.assertTrue(apply_patch(root, patch))
            self.assertEqual(target.read_text(), 'fixed\n')
            self.assertFalse(apply_patch(root, patch))
            target.write_text('user change\n')
            with self.assertRaisesRegex(ValueError, '不兼容'):
                apply_patch(root, patch)
            self.assertEqual(target.read_text(), 'user change\n')


if __name__ == '__main__':
    unittest.main()
