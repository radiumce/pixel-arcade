import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('arcade_server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class LobbyMetadataTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_root, self.old_roms = server.ROOT, server.ROMS_DIR
        server.ROOT = Path(self.temp.name)
        server.ROMS_DIR = server.ROOT / 'roms'
        server.ROMS_DIR.mkdir()
        (server.ROMS_DIR / 'game.nes').write_bytes(b'NES\x1a')
        server._lobby_rooms.clear()

    def tearDown(self):
        server.ROOT, server.ROMS_DIR = self.old_root, self.old_roms
        self.temp.cleanup()

    def test_guest_can_follow_game_but_cannot_change_it(self):
        room = server.lobby_create()
        payload = {'hostToken': room['hostToken'], 'rom': {'url': '/roms/game.nes', 'name': 'Game'},
                   'streamSessionId': 'test-session'}
        with self.assertRaises(PermissionError):
            server.lobby_configure(room['code'], {**payload, 'hostToken': ''})
        self.assertIsNone(server.lobby_get(room['code'])['rom'])
        public = server.lobby_configure(room['code'], payload)
        self.assertNotIn('hostToken', public)
        self.assertNotIn('hostToken', server.lobby_get(room['code']))
        self.assertEqual(public['rom']['url'], '/roms/game.nes')
        server.lobby_configure(room['code'], {'hostToken': room['hostToken'], 'reset': True})
        self.assertIsNone(server.lobby_get(room['code'])['rom'])

    def test_stream_geometry_and_game_id_reach_standalone_guest(self):
        room = server.lobby_create()
        payload = {'hostToken': room['hostToken'], 'rom': {'url': '/roms/game.nes'},
                   'streamSessionId': 'ready', 'aspect': 8 / 7, 'gameId': 12345}
        public = server.lobby_configure(room['code'], payload)
        self.assertEqual(public['aspect'], 8 / 7)
        self.assertEqual(public['gameId'], 12345)
        for change in ({'aspect': 0}, {'aspect': float('nan')}, {'gameId': 0}, {'gameId': 2147483647}):
            with self.assertRaises(ValueError):
                server.lobby_configure(room['code'], {**payload, **change})
        self.assertEqual(server.lobby_get(room['code'])['gameId'], 12345)

    def test_removed_mode_cannot_create_a_room(self):
        with self.assertRaises(ValueError):
            server.lobby_create('sync')

    def test_only_saved_roms_and_ready_stream_rooms_are_published(self):
        room = server.lobby_create('stream')
        for url in ('https://example.com/game.nes', '/roms/missing.nes', '/roms/../server.py', '/roms/game.nes?bad=1'):
            with self.assertRaises(ValueError):
                server.lobby_configure(room['code'], {'hostToken': room['hostToken'],
                    'rom': {'url': url}, 'streamSessionId': 'test-session'})
        with self.assertRaises(ValueError):
            server.lobby_configure(room['code'], {'hostToken': room['hostToken'], 'rom': {'url': '/roms/game.nes'}})
        self.assertIsNone(server.lobby_get(room['code'])['rom'])

    def test_host_reset_restores_room_after_server_restart(self):
        room = server.lobby_create('stream')
        code, token = room['code'], room['hostToken']
        server._lobby_rooms.clear()
        restored = server.lobby_configure(code, {'hostToken': token, 'reset': True})
        self.assertEqual(restored['code'], code)
        self.assertIsNone(restored['streamSessionId'])
        configured = server.lobby_configure(code, {
            'hostToken': token,
            'rom': {'url': '/roms/game.nes', 'name': 'Game'},
            'streamSessionId': 'recovered-session',
        })
        self.assertEqual(configured['streamSessionId'], 'recovered-session')

    def test_netplay_upstream_switches_port_when_default_port_is_hijacked(self):
        old_port = server.NETPLAY_PORT
        old_active = server._active_netplay_port
        old_checked = server._netplay_checked_at
        spawned_ports = []

        def fake_is_in_use(port):
            return port == 3000

        def fake_healthy(port, timeout=1.5):
            return port in spawned_ports

        def fake_spawn(port):
            spawned_ports.append(port)
            return True

        old_in_use = server._is_port_in_use
        old_is_healthy = server._is_netplay_healthy
        old_spawn = server._spawn_netplay_upstream
        try:
            server.NETPLAY_PORT = 3000
            server._active_netplay_port = 3000
            server._netplay_checked_at = 0.0
            server._is_port_in_use = fake_is_in_use
            server._is_netplay_healthy = fake_healthy
            server._spawn_netplay_upstream = fake_spawn

            chosen = server._ensure_netplay_upstream(force=True)
            self.assertNotEqual(chosen, 3000)
            self.assertEqual(spawned_ports, [chosen])
            self.assertEqual(server._active_netplay_port, chosen)
        finally:
            server.NETPLAY_PORT = old_port
            server._active_netplay_port = old_active
            server._netplay_checked_at = old_checked
            server._is_port_in_use = old_in_use
            server._is_netplay_healthy = old_is_healthy
            server._spawn_netplay_upstream = old_spawn

    def test_proxy_http_does_not_duplicate_socketio_polling_post(self):
        import io
        calls = []

        class FakeResponse:
            status = 200
            headers = {'Content-Type': 'text/html'}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self):
                return b'ok'

        class FakeOpener:
            def open(self, req, timeout=30):
                calls.append((req.get_method(), req.full_url, req.data))
                return FakeResponse()

        dummy = server.Handler.__new__(server.Handler)
        dummy.command = 'POST'
        dummy.path = '/socket.io/?EIO=4&transport=polling&sid=test'
        dummy.headers = {'Content-Length': '2', 'Content-Type': 'text/plain;charset=UTF-8'}
        dummy.client_address = ('127.0.0.1', 54321)
        dummy.rfile = io.BytesIO(b'40')
        dummy.wfile = io.BytesIO()
        sent_status = []
        dummy.send_response = lambda code: sent_status.append(code)
        dummy.send_header = lambda k, v: None
        dummy.end_headers = lambda: None

        old_opener = server._UPSTREAM_OPENER
        old_ensure = server._ensure_netplay_upstream
        ensure_Calls = []
        try:
            server._UPSTREAM_OPENER = FakeOpener()
            server._ensure_netplay_upstream = lambda force=False: (ensure_Calls.append(force) or 3000)
            dummy._proxy_http()
        finally:
            server._UPSTREAM_OPENER = old_opener
            server._ensure_netplay_upstream = old_ensure

        self.assertEqual(len(calls), 1)
        self.assertEqual(ensure_Calls, [False])
        self.assertEqual(sent_status, [200])
        self.assertEqual(dummy.wfile.getvalue(), b'ok')


if __name__ == '__main__':
    unittest.main()
