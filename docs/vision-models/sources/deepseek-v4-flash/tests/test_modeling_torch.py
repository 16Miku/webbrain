import importlib.util
import unittest

HAS_TRAINING_STACK = all(
    importlib.util.find_spec(package) is not None for package in ("torch", "transformers")
)


@unittest.skipUnless(HAS_TRAINING_STACK, "requires torch and a DeepSeek V4 Transformers build")
class RoutingAwareModelTests(unittest.TestCase):
    def test_fp32_rmsnorm_hook_preserves_bfloat16_activations(self):
        import torch
        from transformers.models.deepseek_v4.modeling_deepseek_v4 import DeepseekV4RMSNorm

        from deepseek_vision.modeling import _preserve_rmsnorm_input_dtype

        norm = DeepseekV4RMSNorm(16)
        norm.register_forward_hook(_preserve_rmsnorm_input_dtype)
        output = norm(torch.randn(2, 4, 16, dtype=torch.bfloat16))

        self.assertEqual(output.dtype, torch.bfloat16)

    def test_text_parity_and_input_gradient(self):
        import torch
        from transformers import DeepseekV4Config, DeepseekV4ForCausalLM

        from deepseek_vision.modeling import install_routing_aware_core

        torch.manual_seed(7)
        config = DeepseekV4Config(
            vocab_size=64,
            hidden_size=64,
            moe_intermediate_size=32,
            num_hidden_layers=1,
            num_attention_heads=4,
            num_key_value_heads=1,
            head_dim=16,
            q_lora_rank=16,
            o_groups=4,
            o_lora_rank=16,
            index_n_heads=4,
            index_head_dim=8,
            index_topk=8,
            num_experts_per_tok=2,
            n_routed_experts=8,
            n_shared_experts=1,
            max_position_embeddings=128,
            layer_types=["heavily_compressed_attention"],
            compress_rates={
                "compressed_sparse_attention": 4,
                "heavily_compressed_attention": 4,
            },
            hc_mult=2,
            mlp_layer_types=["hash_moe"],
            sliding_window=16,
            num_nextn_predict_layers=0,
        )
        model = DeepseekV4ForCausalLM(config).eval()
        for module in model.modules():
            if module.__class__.__name__ == "DeepseekV4HashRouter":
                module.tid2eid[:, 0] = 0
                module.tid2eid[:, 1] = 1

        input_ids = torch.tensor([[2, 3, 4, 5]])
        with torch.no_grad():
            baseline = model(input_ids=input_ids).logits
        install_routing_aware_core(model)
        embeddings = model.get_input_embeddings()(input_ids).detach().requires_grad_(True)
        result = model(input_ids=input_ids, inputs_embeds=embeddings)

        self.assertEqual((result.logits.detach() - baseline).abs().max().item(), 0.0)
        result.logits.float().square().mean().backward()
        self.assertIsNotNone(embeddings.grad)
        self.assertTrue(torch.isfinite(embeddings.grad).all())


if __name__ == "__main__":
    unittest.main()
