import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('arcade_server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class RomManagementTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_root, self.old_roms, self.old_bios = server.ROOT, server.ROMS_DIR, server.BIOS_DIR
        server.ROOT = Path(self.temp.name)
        server.ROMS_DIR = server.ROOT / 'roms'
        server.BIOS_DIR = server.ROMS_DIR / 'bios'
        server.ROMS_DIR.mkdir()
        server._lobby_rooms.clear()

    def tearDown(self):
        server.ROOT, server.ROMS_DIR, server.BIOS_DIR = self.old_root, self.old_roms, self.old_bios
        self.temp.cleanup()

    def test_delete_rom_success(self):
        test_file = server.ROMS_DIR / 'game.nes'
        test_file.write_bytes(b'NES\x1aTestContent')
        self.assertTrue(test_file.exists())

        res = server.delete_rom('game.nes')
        self.assertTrue(res['ok'])
        self.assertEqual(res['name'], 'game.nes')
        self.assertFalse(test_file.exists())

    def test_delete_rom_with_url_prefix(self):
        test_file = server.ROMS_DIR / 'game2.nes'
        test_file.write_bytes(b'NES\x1aTestContent')
        self.assertTrue(test_file.exists())

        res = server.delete_rom('/roms/game2.nes')
        self.assertTrue(res['ok'])
        self.assertEqual(res['name'], 'game2.nes')
        self.assertFalse(test_file.exists())

    def test_delete_rom_not_found(self):
        with self.assertRaises(FileNotFoundError):
            server.delete_rom('nonexistent.nes')

    def test_delete_rom_invalid_names(self):
        # Empty
        with self.assertRaises(ValueError):
            server.delete_rom('')

        # Directory traversal / invalid names
        for bad_name in ('../server.py', 'foo/bar.nes', '..\\server.py', '.hidden.nes'):
            with self.assertRaises(ValueError):
                server.delete_rom(bad_name)

        # Disallowed file types (cannot delete README.txt or server code)
        (server.ROMS_DIR / 'README.txt').write_text('info')
        with self.assertRaises(ValueError):
            server.delete_rom('README.txt')
        self.assertTrue((server.ROMS_DIR / 'README.txt').exists())

    def test_delete_rom_cleans_lobby_reference(self):
        test_file = server.ROMS_DIR / 'lobby-game.nes'
        test_file.write_bytes(b'NES\x1aTest')

        room = server.lobby_create('stream')
        server.lobby_configure(
            room['code'],
            {
                'hostToken': room['hostToken'],
                'rom': {'url': '/roms/lobby-game.nes', 'name': 'lobby-game.nes'},
                'streamSessionId': 'session-xyz',
            },
        )
        self.assertIsNotNone(server.lobby_get(room['code'])['rom'])
        self.assertEqual(server.lobby_get(room['code'])['streamSessionId'], 'session-xyz')

        server.delete_rom('lobby-game.nes')
        room_after = server.lobby_get(room['code'])
        self.assertIsNone(room_after['rom'])
        self.assertIsNone(room_after['streamSessionId'])

    def test_rename_rom_success_and_extension_preserved(self):
        test_file = server.ROMS_DIR / 'old_game.nes'
        test_file.write_bytes(b'NES\x1aTestContent')
        res = server.rename_rom('old_game.nes', '魂斗罗1')
        self.assertTrue(res['ok'])
        self.assertEqual(res['oldName'], 'old_game.nes')
        self.assertEqual(res['name'], '魂斗罗1.nes')
        self.assertFalse(test_file.exists())
        self.assertTrue((server.ROMS_DIR / '魂斗罗1.nes').exists())

    def test_rename_rom_conflict_and_invalid(self):
        (server.ROMS_DIR / 'a.nes').write_bytes(b'NES\x1aA')
        (server.ROMS_DIR / 'b.nes').write_bytes(b'NES\x1aB')
        with self.assertRaises(ValueError):
            server.rename_rom('a.nes', 'b.nes')
        with self.assertRaises(ValueError):
            server.rename_rom('a.nes', '../evil.nes')
        with self.assertRaises(FileNotFoundError):
            server.rename_rom('missing.nes', 'new.nes')

    def test_rename_rom_updates_lobby_reference(self):
        (server.ROMS_DIR / 'orig.nes').write_bytes(b'NES\x1aTest')
        room = server.lobby_create('stream')
        server.lobby_configure(
            room['code'],
            {
                'hostToken': room['hostToken'],
                'rom': {'url': '/roms/orig.nes', 'name': 'orig.nes'},
                'streamSessionId': 'session-xyz',
            },
        )
        server.rename_rom('orig.nes', 'renamed_game')
        room_after = server.lobby_get(room['code'])
        self.assertEqual(room_after['rom']['name'], 'renamed_game.nes')
        self.assertEqual(room_after['rom']['url'], '/roms/renamed_game.nes')
        self.assertEqual(room_after['rom']['platform'], 'nes')

    def test_fbneo_zip_is_validated_and_keeps_original_name(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('game.bin', b'0123456789abcdef')
        self.assertEqual(server.safe_filename('sf2.zip'), 'sf2.zip')
        server.validate_rom('sf2.zip', data.getvalue())
        (server.ROMS_DIR / 'sf2.zip').write_bytes(data.getvalue())
        self.assertEqual(server.list_roms()[0]['name'], 'sf2.zip')
        with self.assertRaisesRegex(ValueError, '不能重命名'):
            server.rename_rom('sf2.zip', 'street-fighter')

    def test_invalid_or_empty_arcade_zip_is_rejected(self):
        for data in (b'not a zip file!', b''):
            with self.assertRaises(ValueError):
                server.validate_rom('game.zip', data)
        empty = io.BytesIO()
        with zipfile.ZipFile(empty, 'w'):
            pass
        with self.assertRaisesRegex(ValueError, '没有游戏文件'):
            server.validate_rom('game.zip', empty.getvalue())

    def test_arcade_bios_can_be_deleted_safely(self):
        server.BIOS_DIR.mkdir()
        bios = server.BIOS_DIR / 'neogeo.zip'
        bios.write_bytes(b'test bios')
        self.assertEqual(server.delete_bios('neogeo.zip'), {'ok': True, 'name': 'neogeo.zip'})
        self.assertFalse(bios.exists())
        with self.assertRaises(FileNotFoundError):
            server.delete_bios('neogeo.zip')
        with self.assertRaises(ValueError):
            server.delete_bios('../server.py')
        with self.assertRaises(ValueError):
            server.delete_bios('game.zip')

    def test_static_path_allowlist_blocks_sensitive_files(self):
        for rel in (
            'css/common.css',
            'js/app.js',
            'vendor/socket.io.min.js',
            'roms/game.nes',
            'roms/魂斗罗.nes',
            'roms/bios/neogeo.zip',
            'roms/README.txt',
            'roms/.hidden.nes',
            '.git/HEAD',
            '.env',
            'server.py',
            'server.log',
            'ice-servers.json',
        ):
            p = server.ROOT / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'test')

        for path in (
            '/',
            '/index.html',
            '/local.html',
            '/online.html',
            '/online-stream.html',
            '/gamepad-test.html',
            '/css/common.css',
            '/js/app.js',
            '/vendor/socket.io.min.js',
            '/roms/game.nes',
            '/roms/%E9%AD%82%E6%96%97%E7%BD%97.nes',
            '/roms/bios/neogeo.zip',
        ):
            self.assertTrue(server._is_allowed_static_path(path), f'should allow {path}')

        for path in (
            '/.git/HEAD',
            '/.env',
            '/server.py',
            '/server.log',
            '/ice-servers.json',
            '/roms/README.txt',
            '/roms/.hidden.nes',
            '/js/../server.py',
            '/roms/',
            '/css/',
            '/favicon.ico',
        ):
            self.assertFalse(server._is_allowed_static_path(path), f'should block {path}')


if __name__ == '__main__':
    unittest.main()
