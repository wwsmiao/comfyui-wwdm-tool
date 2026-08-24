"""
WWDMAudioCrop 节点 —— 音频可视化裁剪（v2）

功能：
    对输入的 audio 音频进行可视化裁剪，支持三种方式：
      1. 进度条（百分比）方式：slider_start / slider_end 以百分比形式拖动选择范围
      2. 直接输入起止时间（秒）：start_time / end_time
      3. 选择开始时间 + 裁剪秒数：start_time + duration

    前端交互（v2）：
      - 节点面板：即时波形显示 + 播放按钮（播放选区）+ 裁剪按钮（打开弹窗）
      - 裁剪弹窗「音频截取」：全波形 + 每5秒时间刻度 + 起止/时长输入 +
        播放按钮 + 滚轮缩放 / 中键平移 / 点击选区播放 / 拖动选区

    优先级规则（统一按采样点计算，无浮点误差）：
      - 填了 start_time(>0) 优先于 slider_start
      - 填了 end_time(>0) 优先于 slider_end
      - 填了 duration(>0) 强制覆盖区间长度（end = start + duration）

输出：
    audio    - 裁剪后的音频（AUDIO）
    start    - 实际裁剪开始时间（秒）
    end      - 实际裁剪结束时间（秒）
    duration - 实际裁剪时长（秒）
    preview  - 原始音频波形预览图（IMAGE，RGB）
    附加 UI 消息：{wwdm_crop_url, wwdm_crop_duration}（裁剪结果可播放 URL）
"""

import os
import random
import time

import numpy as np
import torch
import folder_paths
from PIL import Image

try:
    import av
except Exception:
    av = None

try:
    from comfy_api.latest import ComfyExtension, IO
    from typing_extensions import override

    _HAS_NEW_API = True
except Exception:
    _HAS_NEW_API = False


# =====================================================================
# 音频工具
# =====================================================================
def load_audio_file(filepath):
    """解码音频文件 → (waveform [C, L] float32, sample_rate)"""
    if av is None:
        raise RuntimeError("PyAV 不可用，无法解码音频文件")
    with av.open(filepath) as af:
        if not af.streams.audio:
            raise ValueError("文件中没有音频流: " + filepath)
        stream = af.streams.audio[0]
        sr = stream.codec_context.sample_rate
        n_ch = stream.channels
        frames = []
        length = 0
        for frame in af.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != n_ch:
                buf = buf.view(-1, n_ch).t()
            frames.append(buf)
            length += buf.shape[1]
        if not frames:
            raise ValueError("未能解码音频帧: " + filepath)
        wav = torch.cat(frames, dim=1)
        if wav.dtype == torch.int16:
            wav = wav.float() / 32768.0
        elif wav.dtype == torch.int32:
            wav = wav.float() / 2147483648.0
        elif not wav.dtype.is_floating_point:
            wav = wav.float()
        return wav, sr


def compute_peaks(mono, num_buckets):
    """计算波形峰值桶（每个桶取 |x| 最大值）"""
    mono = np.asarray(mono, dtype=np.float32)
    n = mono.shape[0]
    if n == 0:
        return np.zeros(num_buckets, dtype=np.float32)
    x = np.abs(mono)
    n_pad = ((n + num_buckets - 1) // num_buckets) * num_buckets
    if n_pad != n:
        x = np.concatenate([x, np.zeros(n_pad - n, dtype=np.float32)])
    return x.reshape(num_buckets, -1).max(axis=1)


def save_wav(waveform, sample_rate, path):
    """把 waveform [B,C,L]（或 [C,L]）保存为 wav 文件（标准库 wave 模块，零依赖）"""
    import wave

    wav = waveform.detach().float().cpu().clamp(-1.0, 1.0)
    if wav.ndim == 3:
        wav = wav[0]
    if wav.ndim == 1:
        wav = wav.unsqueeze(0)
    if wav.ndim != 2:
        raise ValueError(f"save_wav: 期望 [B,C,L] 或 [C,L]，实际 ndim={wav.ndim}")
    ch = wav.shape[0]
    data = (wav.numpy().T * 32767.0).astype(np.int16)  # [L, C] interleaved
    if ch == 1:
        data = data[:, 0]  # mono: 1D
    with wave.open(path, "wb") as wf:
        wf.setnchannels(ch)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(data.tobytes())


def build_view_url(annotated_path, type_="input"):
    """把 annotated 路径（如 audio/xxx.mp3）转为 /view 播放 URL"""
    from urllib.parse import quote

    path = annotated_path.replace("\\", "/")
    if "/" in path:
        subfolder, filename = path.rsplit("/", 1)
    else:
        subfolder, filename = "", path
    q = "filename=" + quote(filename)
    if subfolder:
        q += "&subfolder=" + quote(subfolder)
    q += "&type=" + type_
    return "/view?" + q


# =====================================================================
# 波形预览渲染（RGB，纯 numpy/PIL）
# =====================================================================
def render_waveform_image(waveform, sample_rate, width=900, height=220):
    """将音频波形渲染为 RGB 预览图（numpy HWC float32 0..1）"""
    try:
        if torch is not None and isinstance(waveform, torch.Tensor):
            wav = waveform.detach().float().cpu().numpy()
        else:
            wav = np.asarray(waveform, dtype=np.float32)
        if wav.ndim == 3:
            wav = wav[0]
        elif wav.ndim != 2:
            return None
        mono = np.mean(wav, axis=0).astype(np.float32)
        n = mono.shape[0]
        if n == 0:
            return None

        peaks = compute_peaks(mono, width)
        amp = np.power(np.clip(peaks, 0.0, 1.0), 0.7)
        h = height
        center = h // 2

        img = np.zeros((h, width, 3), dtype=np.uint8)
        img[..., 0] = 18
        img[..., 1] = 22
        img[..., 2] = 32

        half = np.maximum(1, (amp * (center - 4)).astype(np.int64))
        for x in range(width):
            y0 = center - half[x]
            y1 = center + half[x]
            img[y0:y1, x, 0] = 88
            img[y0:y1, x, 1] = 196
            img[y0:y1, x, 2] = 255
        img[center, :, 0] = 60
        img[center, :, 1] = 80
        img[center, :, 2] = 120
        return img.astype(np.float32) / 255.0
    except Exception:
        return None


def _waveform_to_thumbnail_bytes(waveform, sample_rate, width=900, height=220):
    arr = render_waveform_image(waveform, sample_rate, width, height)
    if arr is None:
        return None
    img = Image.fromarray((arr * 255).astype(np.uint8), mode="RGB")
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

        # ---- 统一换算为秒 ----
        if start_time and start_time > 0:
            s = float(start_time)
        else:
            s = total_sec * (float(slider_start) / 100.0)
        s = max(0.0, min(s, total_sec))

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

        s = start_frame / float(sample_rate)
        e = end_frame / float(sample_rate)

        cropped = {"waveform": waveform[..., start_frame:end_frame].clone(), "sample_rate": sample_rate}

        # ---- 预览图（RGB）----
        preview = None
        try:
            img = render_waveform_image(waveform, sample_rate)
            if img is not None:
                preview = torch.from_numpy(img)[None, ...]  # [1,H,W,3]
        except Exception:
            preview = None

        # ---- 保存裁剪结果为 wav（供前端播放）----
        crop_url = None
        try:
            out_dir = os.path.join(folder_paths.get_output_directory(), "wwdm_audio_crop")
            os.makedirs(out_dir, exist_ok=True)
            fn = f"audio_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.wav"
            path = os.path.join(out_dir, fn)
            save_wav(cropped["waveform"], sample_rate, path)
            crop_url = build_view_url("wwdm_audio_crop/" + fn, type_="output")
        except Exception as exc:
            import logging

            logging.getLogger("wwdm.audio").warning("裁剪结果保存失败（不影响输出）: %s", exc)

        # ---- 构造 UI 消息（波形数据 + 播放 URL）----
        ui = {}
        try:
            wf3 = waveform
            if wf3.ndim == 2:
                wf3 = wf3.unsqueeze(0)
            mono = wf3[0].mean(dim=0).float().cpu().numpy()
            peaks = compute_peaks(mono, 1200).tolist()
            maxv = float(np.max(np.abs(mono))) if mono.size else 0.0
            ui["wwdm_waveform"] = {
                "peaks": peaks,
                "sample_rate": sample_rate,
                "duration": total_sec,
                "max": maxv,
            }
            if crop_url:
                ui["wwdm_crop_url"] = crop_url
                ui["wwdm_crop_duration"] = e - s
        except Exception as exc:
            import logging

            logging.getLogger("wwdm.audio").warning("波形 UI 数据构造失败: %s", exc)

        # 元组最后一项携带 {'ui': ...}，执行引擎会提取为 executed 消息的 output 字段
        return (cropped, s, e, e - s, preview, {"ui": ui})


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
