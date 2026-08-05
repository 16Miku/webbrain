import unittest

from deepseek_vision.projector import projector_parameter_count


class ProjectorCountTests(unittest.TestCase):
    def test_exact_baseline_count(self):
        self.assertEqual(projector_parameter_count(), 40_119_040)


if __name__ == "__main__":
    unittest.main()
