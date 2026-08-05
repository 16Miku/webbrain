import unittest

from deepseek_vision.routing import build_routing_ids, greedy_routing_palette


class RoutingTests(unittest.TestCase):
    def test_text_ids_are_preserved(self):
        ids = [10, 11, 12, 13, 14, 15]
        mask = [False, True, True, False, True, False]
        routed = build_routing_ids(ids, mask, [101, 202])
        self.assertEqual(routed, [10, 101, 202, 13, 101, 15])
        self.assertEqual([routed[i] for i in (0, 3, 5)], [10, 13, 15])

    def test_palette_restarts_per_row(self):
        routed = build_routing_ids(
            [[1, 2, 3], [4, 5, 6]],
            [[False, True, True], [True, False, True]],
            [20, 21],
        )
        self.assertEqual(routed, [[1, 20, 21], [20, 5, 21]])

    def test_greedy_palette_is_deterministic(self):
        routes = [[0, 1], [0, 1], [2, 3], [4, 5]]
        self.assertEqual(greedy_routing_palette(routes, 3), [0, 2, 3])


if __name__ == "__main__":
    unittest.main()
