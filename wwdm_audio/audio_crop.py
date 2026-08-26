"""
WWDMAudioCrop 节点 —— 音频可视化裁剪（v4，节点内上传）

功能（参考 Goohai-MiniMax-H3 插件的参考音频功能设计）：
    - 节点面板内直接上传音频（点击 / 拖拽），无需连接 AUDIO 输入
    - 前端用 Web Audio 纯前端解码并绘制波形（上传即见波形，不依赖执行）
    - 剪辑式交互：开始/结束手柄、播放按钮、时间输入、时长联动

输入参数：
    audio      - 可选 AUDIO 输入（兼容 dict/对象/tensor 多种结构，视频节点输出也可用）
    audio_file - 节点内上传的音频文件名（input 目录，含 subfolder），隐藏 widget
    start_time - 开始时间（秒）
    end_time   - 结束时间（秒，0 = 音频末尾）
    duration   - 选取时长（秒，>0 时强制 end = start + duration）

输出：
    audio - 裁剪后的音频（AUDIO）

UI 消息（executed 时返回给前端）：
    wwdm_waveform  - {peaks, sample_rate, duration, max} 全音频波形峰值
    wwdm_audio_url - 全音频 wav 播放 URL（前端播放用，可从任意位置起播）
    wwdm_crop_url  - 裁剪结果 wav URL
"""

import os
import random
import re
import time

import numpy as np
import torch
import folder_paths
from PIL import Image

try:
    import av
except Exception:
    av = None


# =====================================================================
# 时间解析（mm:ss 格式）
# =====================================================================
def _parse_time(v, default=0.0):
    """解析 hh:mm:ss.s / mm:ss.s / 纯秒 → float 秒；无效返回 default"""
    if v is None:
        return default
    s = str(v).strip()
    if not s:
        return default
    # 纯秒（数字）
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return float(s)
    # hh:mm:ss(.s)
    m = re.fullmatch(r"(\d{1,3}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?", s)
    if m:
        hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if mm >= 60 or ss >= 60:
            return default
        frac = float("0." + m.group(4)) if m.group(4) else 0.0
        return hh * 3600 + mm * 60 + ss + frac
    # mm:ss(.s)
    m = re.fullmatch(r"(\d{1,3}):(\d{1,2})(?:\.(\d+))?", s)
    if m:
        mm, ss = int(m.group(1)), int(m.group(2))
        if ss >= 60:
            return default
        frac = float("0." + m.group(3)) if m.group(3) else 0.0
        return mm * 60 + ss + frac
    try:
        return float(s)
    except Exception:
        return default


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
    """音频可视化裁剪节点（剪辑式交互：双手柄 + 播放 + 时间输入）"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 开始时间（mm:ss 或秒）
                "start_time": ("STRING", {"default": "00:00", "multiline": False}),
                # 结束时间（mm:ss 或秒，"00:00" = 音频末尾）
                "end_time": ("STRING", {"default": "00:00", "multiline": False}),
                # 选取时长（mm:ss 或秒，>0 时 end = start + duration）
                "duration": ("STRING", {"default": "00:00", "multiline": False}),
            },
            "optional": {
                # 兼容旧工作流：外部 AUDIO 输入（与 audio_file 二选一，优先 audio_file）
                "audio": ("AUDIO",),
                # 节点内上传的音频文件名（input 目录，含 subfolder；前端隐藏 widget）
                "audio_file": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "crop"
    CATEGORY = "wwdm-tool/audio"
    DESCRIPTION = "可视化截取波形音频：开始/结束手柄 + 播放 + 手动输入时间 + 时长联动"

    @classmethod
    def IS_CHANGED(cls, audio=None, audio_file="", **kwargs):
        try:
            key = str(audio_file or "")
            if audio is not None:
                if isinstance(audio, dict):
                    wf = audio.get("waveform")
                else:
                    wf = audio.waveform
                if wf is not None:
                    key += f"#{float(wf.shape[-1])}#{int(wf.dtype == torch.float16)}"
            return key
        except Exception:
            return float("nan")

    def crop(self, start_time="00:00", end_time="00:00", duration="00:00", audio=None, audio_file=""):
        # ---- 音频来源：优先节点内上传的文件，其次外部 AUDIO 输入 ----
        waveform = None
        sample_rate = None
        if audio_file and str(audio_file).strip():
            path = folder_paths.get_annotated_filepath(str(audio_file).strip())
            wav2d, sample_rate = load_audio_file(path)
            waveform = wav2d.unsqueeze(0)  # [C,L] -> [1,C,L]
        elif audio is not None:
            # 兼容多种音频输入结构：
            #   {"waveform": tensor, "sample_rate": int}   LoadAudio / 音频节点
            #   对象属性（.waveform / .sample_rate）          部分视频/音频节点
            #   tensor 本体（[B,C,L] 或 [C,L]）               部分视频节点提取的音频
            if isinstance(audio, dict):
                waveform = audio.get("waveform")
                sample_rate = audio.get("sample_rate")
            elif hasattr(audio, "waveform") and hasattr(audio, "sample_rate"):
                waveform = audio.waveform
                sample_rate = audio.sample_rate
            elif isinstance(audio, torch.Tensor):
                waveform = audio
            else:
                raise ValueError(
                    "WWDMAudioCrop: 无法识别的音频输入类型 %s，请使用 LoadAudio 或上传文件"
                    % type(audio).__name__
                )
            if waveform is None:
                raise ValueError("WWDMAudioCrop: 音频输入缺少 waveform 数据")
            if sample_rate is None:
                sample_rate = 44100
            if waveform.ndim == 2:
                waveform = waveform.unsqueeze(0)  # [C,L] -> [1,C,L]
        else:
            raise ValueError("WWDMAudioCrop: 请在节点内上传音频文件，或连接 AUDIO 输入")

        sample_rate = int(sample_rate)
        total_samples = waveform.shape[-1]
        total_sec = total_samples / float(sample_rate) if sample_rate > 0 else 0.0

        if total_samples == 0:
            raise ValueError("WWDMAudioCrop: 输入音频长度为 0")

        # ---- 解析时间参数（mm:ss 或秒）----
        start_v = _parse_time(start_time)
        end_v = _parse_time(end_time)
        dur_v = _parse_time(duration)

        # ---- 统一换算为秒（全部按采样点计算，无浮点误差）----
        s = max(0.0, min(start_v, total_sec))

        if dur_v and dur_v > 0:
            # 时长联动：结束 = 开始 + 时长
            e = s + dur_v
        elif end_v and end_v > 0:
            e = end_v
        else:
            # 未指定 → 末尾
            e = total_sec
        e = max(s, min(e, total_sec))

        if s >= e:
            raise ValueError(
                f"WWDMAudioCrop: 裁剪区间无效 (start={s:.3f}s >= end={e:.3f}s)，"
                f"音频总时长 {total_sec:.3f}s"
            )

        # ---- 采样点裁剪 ----
        start_frame = min(total_samples, int(round(s * sample_rate)))
        end_frame = min(total_samples, int(round(e * sample_rate)))
        end_frame = max(start_frame + 1, end_frame)
        if start_frame >= end_frame:
            raise ValueError("WWDMAudioCrop: 裁剪后音频长度为 0，请检查裁剪区间")

        s = start_frame / float(sample_rate)
        e = end_frame / float(sample_rate)

        cropped = {"waveform": waveform[..., start_frame:end_frame].clone(), "sample_rate": sample_rate}

        out_dir = os.path.join(folder_paths.get_output_directory(), "wwdm_audio_crop")
        os.makedirs(out_dir, exist_ok=True)

        # ---- 保存全音频 wav（前端播放用）----
        audio_url = None
        try:
            fn = f"full_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.wav"
            save_wav(waveform, sample_rate, os.path.join(out_dir, fn))
            audio_url = build_view_url("wwdm_audio_crop/" + fn, type_="output")
        except Exception as exc:
            import logging

            logging.getLogger("wwdm.audio").warning("全音频保存失败（不影响输出）: %s", exc)

        # ---- 保存裁剪结果 wav ----
        crop_url = None
        try:
            fn = f"crop_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.wav"
            save_wav(cropped["waveform"], sample_rate, os.path.join(out_dir, fn))
            crop_url = build_view_url("wwdm_audio_crop/" + fn, type_="output")
        except Exception as exc:
            import logging

            logging.getLogger("wwdm.audio").warning("裁剪结果保存失败（不影响输出）: %s", exc)

        # ---- 构造 UI 消息（全音频波形 + 播放 URL + 裁剪 URL）----
        # 注意：ComfyUI get_output_from_returns 合并 ui 时要求每个值都是列表
        # （ui = {k: [y for x in uis for y in x[k]] ...}），裸 dict/字符串会被迭代破坏
        ui = {}
        try:
            wf3 = waveform
            if wf3.ndim == 2:
                wf3 = wf3.unsqueeze(0)
            mono = wf3[0].mean(dim=0).float().cpu().numpy()
            peaks = compute_peaks(mono, 1200).tolist()
            maxv = float(np.max(np.abs(mono))) if mono.size else 0.0
            ui["wwdm_waveform"] = [
                {
                    "peaks": peaks,
                    "sample_rate": sample_rate,
                    "duration": total_sec,
                    "max": maxv,
                }
            ]
            if audio_url:
                ui["wwdm_audio_url"] = [audio_url]
            if crop_url:
                ui["wwdm_crop_url"] = [crop_url]
        except Exception as exc:
            import logging

            logging.getLogger("wwdm.audio").warning("波形 UI 数据构造失败: %s", exc)

        # 返回 dict：result 携带裁剪音频输出，ui 携带前端面板数据
        # 注意：必须用 {'result': (...), 'ui': {...}} 结构！
        # 若返回裸元组 + 尾随 {'ui': ...}，get_output_from_returns 会把整个元组
        # 当作单个 result，ui 永远不会被收集（uis 为空 → 不发 executed）
        return {"result": (cropped,), "ui": ui}
