import unittest

from deepseek_vision.training import resume_step_from_checkpoint


class ResumeCheckpointTests(unittest.TestCase):
    def test_reads_optimizer_step_from_checkpoint_name(self):
        self.assertEqual(
            resume_step_from_checkpoint("runs/projector-step-000600.safetensors"),
            600,
        )

    def test_rejects_ambiguous_checkpoint_name(self):
        with self.assertRaisesRegex(ValueError, "projector-step"):
            resume_step_from_checkpoint("projector.safetensors")


if __name__ == "__main__":
    unittest.main()
