import socket
import unittest

from experiments.mcp_actions.demo import reserve_loopback_port


class PortReservationTest(unittest.TestCase):
    def test_cannot_shadow_an_existing_wildcard_listener(self):
        with socket.socket() as existing:
            existing.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            existing.bind(("0.0.0.0", 0))
            existing.listen()
            with (
                self.assertRaises(OSError),
                reserve_loopback_port(existing.getsockname()[1]),
            ):
                self.fail("The existing service must retain loopback traffic.")

    def test_socket_stays_exclusively_reserved_until_transferred_to_the_server(self):
        with reserve_loopback_port(0) as listener, socket.socket() as contender:
            self.assertEqual(listener.getsockname()[0], "127.0.0.1")
            with self.assertRaises(OSError):
                contender.bind(listener.getsockname())


if __name__ == "__main__":
    unittest.main()
