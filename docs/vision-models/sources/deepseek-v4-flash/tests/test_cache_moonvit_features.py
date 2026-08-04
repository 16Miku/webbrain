import unittest

from scripts.cache_moonvit_features import fit_image_to_token_budget


class FakeImageProcessor:
    def __init__(self):
        self.media_proc_cfg = {"merge_kernel_size": 2, "in_patch_limit": 0}

    def get_resize_config(self, _media):
        patch_limit = self.media_proc_cfg["in_patch_limit"]
        return {"num_tokens": 513 if patch_limit >= 1888 else 486}


class TokenBudgetTests(unittest.TestCase):
    def test_binary_search_accounts_for_padding_cliff(self):
        processor = FakeImageProcessor()
        output_tokens = fit_image_to_token_budget(processor, object(), 512)
        self.assertEqual(output_tokens, 486)
        self.assertEqual(processor.media_proc_cfg["in_patch_limit"], 1887)


if __name__ == "__main__":
    unittest.main()
