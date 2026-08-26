"""
WWDMAudioCrop 服务端路由（v2）

提供：
    POST /wwdm/audio/analyze   上传音频文件 → 返回 {peaks, sample_rate, duration, max, audio_url}
                                波形数据（1200 桶峰值）+ 可直接播放的 /view URL，
                                供前端在节点未执行/无波形消息时也能即时加载波形并播放。
    POST /wwdm/audio/waveform  上传音频 → 返回波形 PNG（可选，保留）
    GET  /wwdm/audio/files     列出 input 目录音频文件（根目录 + 一层子目录）
    GET  /wwdm/audio/resolve   解析音频源（相对/绝对路径/视频文件）→ 时长 + 可播放 URL
    GET  /wwdm/audio/ping      健康检查
"""

import io
import logging
import os
import re

import numpy as np
from PIL import Image

from .audio_crop import (
    build_view_url,
    compute_peaks,
    load_audio_file,
    render_waveform_image,
    save_wav,
)

log = logging.getLogger("wwdm.audio")

try:
    from server import PromptServer

    _routes = PromptServer.instance.routes
    _has_server = True
except Exception as _server_import_err:
    log.debug("PromptServer 不可用（%s），路由将在 ComfyUI 环境中注册", _server_import_err)
    _routes = None
    _has_server = False

try:
    import aiohttp
    from aiohttp import web
except Exception:
    aiohttp = None
    web = None


# ---------------------------------------------------------------- 工具
async def _decode_request_bytes(request):
    """从 multipart 或 raw body 读取音频字节"""
    try:
        reader = request.multipart()
        while True:
            part = await reader.next()
            if part is None:
                break
            data = await part.read()
            if data and len(data) > 44:  # 跳过空部分/极小分片
                return part.name or "", data
        return "", None
    except Exception:
        pass
    try:
        data = await request.read()
        return "", data or None
    except Exception:
        return "", None


def _sanitize_filename(name):
    name = os.path.basename(str(name or "audio"))
    name = re.sub(r"[^A-Za-z0-9._\u4e00-\u9fff-]", "_", name)
    return name or "audio.wav"


def _safe_json(data, status=200):
    return web.json_response(data, status=status)


# ---------------------------------------------------------------- 路由
def _register_routes():
    if _routes is None or web is None:
        return

    @_routes.post("/wwdm/audio/analyze")
    async def wwdm_audio_analyze(request):
        filename, data = await _decode_request_bytes(request)
        if not data:
            return _safe_json({"error": "未收到音频数据"}, 400)

        # 保存为临时文件再解码（PyAV 需要文件路径）
        tmp = None
        try:
            import tempfile

            ext = os.path.splitext(_sanitize_filename(filename))[1] or ".mp3"
            fd, tmp = tempfile.mkstemp(suffix=ext)
            os.close(fd)
            with open(tmp, "wb") as f:
                f.write(data)
            waveform, sr = load_audio_file(tmp)
        except Exception as exc:
            log.warning("analyze 解码失败: %s", exc)
            return _safe_json({"error": f"音频解码失败: {exc}"}, 422)
        finally:
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass

        # 计算峰值（1200 桶，供前端渲染）
        mono = waveform.mean(dim=0).float().cpu().numpy()
        peaks = compute_peaks(mono, 1200).tolist()
        duration = waveform.shape[1] / float(sr)
        maxv = float(np.max(np.abs(mono))) if mono.size else 0.0

        # 保存为 wav（前端可直接播放 + 后续裁剪保存用）
        import random
        import time

        try:
            out_dir = os.path.join(os.environ.get("COMFYUI_OUTPUT_DIR", ""), "wwdm_audio_crop") or None
            if not out_dir:
                import folder_paths

                out_dir = os.path.join(folder_paths.get_output_directory(), "wwdm_audio_crop")
            os.makedirs(out_dir, exist_ok=True)
            fn = f"audio_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.wav"
            path = os.path.join(out_dir, fn)
            save_wav(waveform.unsqueeze(0), sr, path)
            audio_url = build_view_url("wwdm_audio_crop/" + fn, type_="output")
        except Exception as exc:
            log.warning("analyze 保存 wav 失败: %s", exc)
            audio_url = None

        return _safe_json(
            {
                "ok": True,
                "peaks": peaks,
                "sample_rate": sr,
                "duration": duration,
                "max": maxv,
                "audio_url": audio_url,
                "filename": filename or None,
            }
        )

    @_routes.post("/wwdm/audio/waveform")
    async def wwdm_audio_waveform(request):
        filename, data = await _decode_request_bytes(request)
        if not data:
            return _safe_json({"error": "未收到音频数据"}, 400)

        import tempfile

        tmp = None
        try:
            ext = os.path.splitext(_sanitize_filename(filename))[1] or ".mp3"
            fd, tmp = tempfile.mkstemp(suffix=ext)
            os.close(fd)
            with open(tmp, "wb") as f:
                f.write(data)
            waveform, sr = load_audio_file(tmp)
        except Exception as exc:
            return _safe_json({"error": f"音频解码失败: {exc}"}, 422)
        finally:
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass

        arr = render_waveform_image(waveform.unsqueeze(0), sr, width=1200, height=240)
        if arr is None:
            return _safe_json({"error": "波形渲染失败"}, 500)
        img = Image.fromarray((arr * 255).astype(np.uint8), mode="RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return web.Response(body=buf.getvalue(), content_type="image/png")

    @_routes.get("/wwdm/audio/ping")
    async def wwdm_audio_ping(request):
        return _safe_json({"ok": True, "plugin": "Comfyui-wwdm-tool", "v": 4})

    @_routes.get("/wwdm/audio/files")
    async def wwdm_audio_files(request):
        """列出 input 目录已有的音频文件（根目录 + 一层子目录），供前端下拉切换"""
        try:
            import folder_paths

            inp = folder_paths.get_input_directory()
        except Exception:
            return _safe_json({"files": []})
        exts = {
            ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".mp4",
            ".wma", ".aiff", ".aif", ".opus", ".webm", ".wmv", ".mov", ".m4b", ".amr", ".ape", ".dsf", ".dff", ".wv", ".tta", ".tak", ".mpc", ".ape", ".flv", ".mkv", ".m4v", ".3gp", ".3g2", ".mts", ".m2ts", ".ts", ".mxf", ".avi", ".w64", ".caf", ".au", ".snd", ".oga", ".spx", ".wma", ".aiff", ".aif", ".aifc", ".flac", ".m4a", ".mp4", ".ogg", ".opus", ".wav", ".webm", ".mp3"
        }
        files = []
        try:
            for root, dirs, fnames in os.walk(inp):
                depth = root[len(inp):].count(os.sep)
                if depth >= 1:
                    dirs[:] = []  # 只列根目录 + 一层子目录
                for fn in sorted(fnames):
                    if os.path.splitext(fn)[1].lower() in exts:
                        rel = os.path.relpath(os.path.join(root, fn), inp).replace("\\", "/")
                        files.append(rel)
        except Exception as exc:
            log.warning("列出音频文件失败: %s", exc)
        files.sort(key=str.lower)
        return _safe_json({"files": files})

    @_routes.get("/wwdm/audio/resolve")
    async def wwdm_audio_resolve(request):
        """解析音频源（文件名/相对路径/绝对路径/视频文件）→ 时长 + 可播放 URL。

        用于前端预加载：上游节点（LoadAudio 或任意 AUDIO/视频输出节点）的
        widget 值可能是 input 相对路径（含 subfolder）、绝对路径、或视频文件。
        统一经 folder_paths.get_annotated_filepath 定位，PyAV 解码拿时长，
        并把音频转码保存为 wav 返回可播放 URL（视频文件也可直接播放）。
        """
        import time
        import random

        name = (request.query.get("name") or "").strip()
        if not name:
            return _safe_json({"error": "缺少 name 参数"}, 400)
        try:
            import folder_paths

            path = folder_paths.get_annotated_filepath(name)
        except Exception as exc:
            log.warning("resolve 定位文件失败 %r: %s", name, exc)
            return _safe_json({"error": f"无法定位文件: {exc}"}, 404)
        if not os.path.isfile(path):
            return _safe_json({"error": f"文件不存在: {path}"}, 404)
        try:
            waveform, sr = load_audio_file(path)
        except Exception as exc:
            log.warning("resolve 解码失败 %r: %s", name, exc)
            return _safe_json({"error": f"音频解码失败: {exc}"}, 422)
        duration = waveform.shape[1] / float(sr)
        # 转码保存为 wav，保证可播放（视频文件浏览器 <audio> 也可播，双保险）
        audio_url = None
        try:
            out_dir = os.path.join(folder_paths.get_output_directory(), "wwdm_audio_crop")
            os.makedirs(out_dir, exist_ok=True)
            fn = f"resolved_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.wav"
            save_wav(waveform.unsqueeze(0), sr, os.path.join(out_dir, fn))
            audio_url = build_view_url("wwdm_audio_crop/" + fn, type_="output")
        except Exception as exc:
            log.warning("resolve 保存 wav 失败: %s", exc)
        return _safe_json(
            {
                "ok": True,
                "name": name,
                "path": path,
                "duration": duration,
                "sample_rate": sr,
                "audio_url": audio_url,
            }
        )


try:
    _register_routes()
except Exception as exc:
    log.warning("WWDMAudioCrop 路由注册失败（不影响节点功能）: %s", exc)
