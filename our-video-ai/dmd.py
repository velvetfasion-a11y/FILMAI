import torch
from diffusers import FlowMatchEulerDiscreteScheduler

class DMDScheduler(FlowMatchEulerDiscreteScheduler):
    """Few-step DMD sampler: predict x0 at each timestep, re-noise to the next one."""
    dmd_steps = [1000, 757, 522]
    def set_timesteps(self, num_inference_steps=None, device=None, **kw):
        self.timesteps = torch.tensor(self.dmd_steps, dtype=torch.float32, device=device)
        self.num_inference_steps = len(self.dmd_steps)
        self._i = 0
        self._gen = kw.get("generator")
    def step(self, model_output, timestep, sample, return_dict=False, generator=None, **kw):
        s = float(timestep) / 1000.0
        x0 = sample.float() - s * model_output.float()
        self._i += 1
        if self._i < len(self.dmd_steps):
            sn = self.dmd_steps[self._i] / 1000.0
            noise = torch.randn(x0.shape, generator=generator, dtype=torch.float32).to(x0.device)
            out = (1 - sn) * x0 + sn * noise
        else:
            out = x0
        out = out.to(sample.dtype)
        return (out,) if not return_dict else type("O", (), {"prev_sample": out})()
