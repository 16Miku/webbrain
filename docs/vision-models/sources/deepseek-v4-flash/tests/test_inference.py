import unittest

from deepseek_vision.inference import (
    ASSISTANT,
    BOS,
    EOS,
    USER,
    build_vision_prompt,
)


class FakeTokenizer:
    eos_token_id = 99

    def __init__(self):
        self.special = {BOS: 1, USER: 2, ASSISTANT: 3, EOS: 4}

    def encode(self, value, add_special_tokens=False):
        if value in self.special:
            return [self.special[value]]
        if value == "</think>":
            return [5, 6]
        return [10 + index for index, _ in enumerate(value.split())]


class VisionPromptTests(unittest.TestCase):
    def test_prompt_matches_training_protocol(self):
        result = build_vision_prompt(
            tokenizer=FakeTokenizer(),
            question="what is shown",
            image_tokens=2,
            max_sequence_length=32,
            max_new_tokens=8,
        )

        self.assertEqual(result.input_ids, [1, 2, 0, 0, 10, 11, 12, 3, 5, 6])
        self.assertEqual(
            result.image_mask,
            [False, False, True, True, False, False, False, False, False, False],
        )
        self.assertEqual(result.eos_token_ids, (4, 99))

    def test_long_question_is_truncated_to_reserved_generation_budget(self):
        result = build_vision_prompt(
            tokenizer=FakeTokenizer(),
            question="one two three four five six",
            image_tokens=2,
            max_sequence_length=12,
            max_new_tokens=3,
        )

        self.assertEqual(len(result.input_ids), 9)
        self.assertEqual(result.input_ids[4:5], [10])

    def test_empty_prompt_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "prompt cannot be empty"):
            build_vision_prompt(
                tokenizer=FakeTokenizer(),
                question=" ",
                image_tokens=2,
                max_sequence_length=32,
                max_new_tokens=8,
            )


if __name__ == "__main__":
    unittest.main()
