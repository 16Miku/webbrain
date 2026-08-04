import tempfile
import unittest
from pathlib import Path

from scripts.fetch_cauldron import (
    example_fingerprint,
    load_config_checkpoint,
    save_config_checkpoint,
)


class ExampleFingerprintTests(unittest.TestCase):
    def test_normalizes_whitespace(self):
        compact = example_fingerprint("image-sha", "What is this?", "A cat")
        spaced = example_fingerprint("image-sha", " What  is\nthis? ", "A\tcat ")
        self.assertEqual(compact, spaced)

    def test_includes_image_and_answer(self):
        baseline = example_fingerprint("image-a", "What is this?", "A cat")
        self.assertNotEqual(baseline, example_fingerprint("image-b", "What is this?", "A cat"))
        self.assertNotEqual(baseline, example_fingerprint("image-a", "What is this?", "A dog"))


class ConfigCheckpointTests(unittest.TestCase):
    def test_round_trips_examples_and_updates_seen_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            checkpoint_dir = output / "config-checkpoints"
            checkpoint_dir.mkdir()
            image_dir = output / "images"
            image_dir.mkdir()
            (image_dir / "image.png").write_bytes(b"image")
            examples = [
                {
                    "id": "docvqa-0",
                    "image": "images/image.png",
                    "question": "Question",
                    "answer": "Answer",
                    "source": "docvqa",
                    "cauldron_config": "docvqa",
                    "split": "train",
                    "fingerprint": "fingerprint",
                }
            ]
            stats = {"examples": 1, "rows_seen": 1, "unique_images": 1}
            save_config_checkpoint(
                checkpoint_dir=checkpoint_dir,
                config_index=2,
                config_name="docvqa",
                quota=1,
                dataset_id="dataset",
                dataset_revision="revision",
                seed=3,
                shuffle_buffer=512,
                examples=examples,
                stats=stats,
            )
            seen: set[str] = set()
            loaded = load_config_checkpoint(
                checkpoint_dir=checkpoint_dir,
                config_index=2,
                config_name="docvqa",
                quota=1,
                dataset_id="dataset",
                dataset_revision="revision",
                seed=3,
                shuffle_buffer=512,
                output_dir=output,
                seen_example_keys=seen,
            )
            self.assertEqual(loaded, (examples, stats))
            self.assertEqual(seen, {"fingerprint"})

    def test_rejects_checkpoint_from_another_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            checkpoint_dir = output / "config-checkpoints"
            checkpoint_dir.mkdir()
            image_dir = output / "images"
            image_dir.mkdir()
            (image_dir / "image.png").write_bytes(b"image")
            examples = [
                {
                    "image": "images/image.png",
                    "cauldron_config": "docvqa",
                    "split": "train",
                    "fingerprint": "fingerprint",
                }
            ]
            save_config_checkpoint(
                checkpoint_dir=checkpoint_dir,
                config_index=0,
                config_name="docvqa",
                quota=1,
                dataset_id="dataset",
                dataset_revision="old-revision",
                seed=3,
                shuffle_buffer=512,
                examples=examples,
                stats={"examples": 1},
            )
            with self.assertRaisesRegex(RuntimeError, "dataset_revision"):
                load_config_checkpoint(
                    checkpoint_dir=checkpoint_dir,
                    config_index=0,
                    config_name="docvqa",
                    quota=1,
                    dataset_id="dataset",
                    dataset_revision="new-revision",
                    seed=3,
                    shuffle_buffer=512,
                    output_dir=output,
                    seen_example_keys=set(),
                )


if __name__ == "__main__":
    unittest.main()
