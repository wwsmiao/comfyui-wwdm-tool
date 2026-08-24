"""
WWDMAudioCrop 节点 —— 音频可视化裁剪

功能：
    对输入的 audio 音频进行可视化裁剪，支持三种方式：
      1. 进度条（百分比）方式：slider_start / slider_end 以百分比形式拖动选择范围
      2. 直接输入起止时间（秒）：start_time / end_time
      3. 选择开始时间 + 裁剪秒数：start_time + duration

    三者可自由组合，最终以「秒」为统一口径计算裁剪区间：
      - 显式填了 start_time 优先使用 start_time（秒）
      - 否则使用 slider_start（百分比）换算
      - 显式填了 end_time 优先使用 end_time（秒）
      - 否则使用 slider_end（百分比）换算
      - 显式填了 duration 时，用 duration 覆盖区间长度（end = start + duration）

输出：
    audio    - 裁剪后的音频（AUDIO，兼容 VHS / ComfyUI 原生音频格式）
    start    - 实际裁剪开始时间（秒）
    end      - 实际裁剪结束时间（秒）
    duration - 实际裁剪时长（秒）
    preview  - 原始音频波形预览图（IMAGE，用于可视化展示；无法访问时输出 None）
"""

import math
import numpy as np
import torch
import folder_paths
from PIL import Image

try:
    from comfy_api.latest import ComfyExtension, IO
    from typing_extensions import override

    _HAS_NEW_API = True
except Exception:
    _HAS_NEW_API = False

try:
    import comfy.utils
except Exception:
    comfy = None


# =====================================================================
# 波形预览渲染（纯 numpy/PIL 实现，无额外依赖）
# =====================================================================
def render_waveform_image(waveform, sample_rate, width=900, height=220):
    """
    将音频波形渲染为 RGBA 预览图（numpy HWC float32，值域 0..1）。
    waveform: torch.Tensor [B, C, L] 或 numpy [C, L]
    """
    try:
        if torch is not None and isinstance(waveform, torch.Tensor):
            wav = waveform.detach().float().cpu().numpy()
        else:
            wav = np.asarray(waveform, dtype=np.float32)
        if wav.ndim == 3:
            wav = wav[0]
        if wav.ndim != 2:
            return None
        # 混音为单声道
        mono = np.mean(wav, axis=0).astype(np.float32)
        n = mono.shape[0]
        if n == 0:
            return None

        # 每个像素柱取区间内峰值，压缩为可视化轮廓
        samples_per_px = max(1, n / width)
        peaks = np.empty(width, dtype=np.float32)
        for i in range(width):
            s = int(i * samples_per_px)
            e = min(n, int((i + 1) * samples_per_px) + 1)
            seg = mono[s:e]
            if seg.size == 0:
                peaks[i] = 0.0
            else:
                peaks[i] = np.abs(seg).max()
        peaks = np.clip(peaks, 0.0, 1.0)

        # 峰值到高度的映射（轻微 gamma 提升小音量可见度）
        amp = np.power(peaks, 0.7)
        h = height
        center = h // 2
        img = np.zeros((h, width, 4), dtype=np.uint8)
        # 背景：深色半透明
        img[..., 0] = 18
        img[..., 1] = 22
        img[..., 2] = 32
        img[..., 3] = 180

        for x in range(width):
            a = amp[x]
            half = max(1, int(round(a * (center - 4))))
            y0 = center - half
            y1 = center + half
            img[y0:y1, x, 0] = 88
            img[y0:y1, x, 1] = 196
            img[y0:y1, x, 2] = 255
            img[y0:y1, x, 3] = 255
            # 中线
            img[center, x, 0] = 60
            img[center, x, 1] = 80
            img[center, x, 2] = 120
            img[center, x, 3] = 200

        return img.astype(np.float32) / 255.0
    except Exception:
        return None


def _waveform_to_thumbnail_bytes(waveform, sample_rate, width=900, height=220):
    """把波形渲染成 PNG bytes（用于自定义路由返回给前端）"""
    arr = render_waveform_image(waveform, sample_rate, width, height)
    if arr is None:
        return None
    img = Image.fromarray((arr * 255).astype(np.uint8), mode="RGBA")
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# =====================================================================
# 节点定义
# =====================================================================
class WWDMAudioCrop:
    """音频可视化裁剪节点"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                # 方式一：进度条（百分比 0-100），拖动选择区间
                "slider_start": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.1, "display": "slider"},
                ),
                "slider_end": (
                    "FLOAT",
                    {"default": 100.0, "min": 0.0, "max": 100.0, "step": 0.1, "display": "slider"},
                ),
                # 方式二：直接输入开始/结束时间（秒）
                "start_time": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01},
                ),
                "end_time": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01},
                ),
                # 方式三：开始时间 + 裁剪秒数
                "duration": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.01},
                ),
            },
            "optional": {},
        }

    RETURN_TYPES = ("AUDIO", "FLOAT", "FLOAT", "FLOAT", "IMAGE")
    RETURN_NAMES = ("audio", "start", "end", "duration", "preview")
    FUNCTION = "crop"
    CATEGORY = "wwdm-tool/audio"
    DESCRIPTION = "对音频进行可视化裁剪：支持进度条百分比、直接输入起止时间、开始时间+秒数三种方式"

    @classmethod
    def IS_CHANGED(cls, audio, **kwargs):
        # audio 变化时强制重算
        try:
            wf = audio["waveform"]
            return float(wf.shape[-1]), int(wf.dtype == torch.float16)
        except Exception:
            return float("nan")

    def crop(self, audio, slider_start, slider_end, start_time, end_time, duration):
        if audio is None:
            raise ValueError("WWDMAudioCrop: 输入 audio 为空，请先连接音频")

        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        total_samples = waveform.shape[-1]
        total_sec = total_samples / float(sample_rate) if sample_rate > 0 else 0.0

        if total_samples == 0:
            raise ValueError("WWDMAudioCrop: 输入音频长度为 0")

        # ---- 统一换算为采样点（避免浮点误差） ----
        # 开始时间
        if start_time and start_time > 0:
            s = float(start_time)
        else:
            s = total_sec * (float(slider_start) / 100.0)
        s = max(0.0, min(s, total_sec))

        # 结束时间：显式 end_time > 0 优先，否则用 slider_end，再被 duration 覆盖
        if end_time and end_time > 0:
            e = float(end_time)
        else:
            e = total_sec * (float(slider_end) / 100.0)

        if duration and duration > 0:
            e = s + float(duration)

        e = max(s, min(e, total_sec))

        if s >= e and not (s == e == 0.0):
            raise ValueError(
                f"WWDMAudioCrop: 裁剪区间无效 (start={s:.3f}s >= end={e:.3f}s)，"
                f"音频总时长 {total_sec:.3f}s"
            )

        # ---- 采样点裁剪 ----
        # 按采样点计算区间，保证进度条与秒数两种方式结果一致且无浮点误差
        start_frame = min(total_samples, int(round(s * sample_rate)))
        if end_time and end_time > 0:
            end_frame = min(total_samples, int(round(e * sample_rate)))
        elif duration and duration > 0:
            end_frame = min(total_samples, start_frame + int(round(float(duration) * sample_rate)))
        else:
            end_frame = min(total_samples, int(round(e * sample_rate)))
        end_frame = max(start_frame, end_frame)
        if start_frame >= end_frame:
            raise ValueError("WWDMAudioCrop: 裁剪后音频长度为 0，请检查裁剪区间")

        # 实际裁剪的秒数（用于返回）
        s = start_frame / float(sample_rate)
        e = end_frame / float(sample_rate)

        cropped = {"waveform": waveform[..., start_frame:end_frame].clone(), "sample_rate": sample_rate}

        # ---- 预览图 ----
        preview = None
        try:
            img = render_waveform_image(waveform, sample_rate)
            if img is not None:
                preview = torch.from_numpy(img)[None, ...]  # [1,H,W,4]
        except Exception:
            preview = None

        return (cropped, s, e, e - s, preview)


# =====================================================================
# 可选：新式 ComfyExtension 注册（若环境支持）
# =====================================================================
if _HAS_NEW_API:

    class WWDMAudioCropExt(ComfyExtension):
        @override
        async def get_node_list(self):
            return [WWDMAudioCrop]

    async def comfy_entrypoint():
        return WWDMAudioCropExt()
