"""
服务端路由：为前端提供波形数据接口

POST /wwdm/audio/waveform
    body: {"audio_id": "<前端生成的唯一ID>", "width": 1200}
    -> 前端 JS 在把音频传给节点前，先将音频临时文件上传到 input 目录，
       再把文件路径（base64）作为参数传给本接口，服务端解码后渲染波形 PNG 返回。
"""

import base64
import io

import numpy as np
import torch
from PIL import Image

from .audio_crop import render_waveform_image

try:
    import server

    _routes = server.PromptServer.instance.routes
except Exception:
    _routes = None


def _decode_audio_payload(payload):
    """从请求体解析出 waveform 与 sample_rate"""
    # 支持的格式1: {"waveform_b64": ..., "sample_rate": ...} （波形 f32 原始字节）
    if isinstance(payload, dict):
        if payload.get("waveform_b64"):
            raw = base64.b64decode(payload["waveform_b64"])
            sr = int(payload.get("sample_rate", 44100))
            arr = np.frombuffer(raw, dtype=np.float32)
            # 尝试按声道数还原：先按单声道展平，由前端附带 shape
            shape = payload.get("shape")
            if shape:
                arr = arr.reshape([int(x) for x in shape])
            else:
                # 无 shape 信息时按 (1, 1, N) 处理
                arr = arr.reshape(1, 1, -1)
            return torch.from_numpy(arr), sr
        # 支持的格式2: 直接传 {"waveform": [...], "sample_rate": ...}
        if payload.get("waveform") is not None:
            wf = np.asarray(payload["waveform"], dtype=np.float32)
            sr = int(payload.get("sample_rate", 44100))
            if wf.ndim == 1:
                wf = wf[None, None, :]
            return torch.from_numpy(wf), sr
    return None, None


def _register_routes():
    if _routes is None:
        return

    @_routes.post("/wwdm/audio/waveform")
    async def wwdm_audio_waveform(request):
        try:
            payload = await request.json()
        except Exception:
            payload = None

        waveform, sample_rate = _decode_audio_payload(payload)
        if waveform is None:
            import aiohttp
            from aiohttp import web
            return web.json_response({"error": "invalid payload"}, status=400)

        width = int(payload.get("width", 1200)) if isinstance(payload, dict) else 1200
        width = max(200, min(width, 2400))
        height = int(payload.get("height", 240)) if isinstance(payload, dict) else 240
        height = max(80, min(height, 800))

        arr = render_waveform_image(waveform, sample_rate, width=width, height=height)
        if arr is None:
            import aiohttp
            from aiohttp import web
            return web.json_response({"error": "render failed"}, status=500)

        img = Image.fromarray((arr * 255).astype(np.uint8), mode="RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png = buf.getvalue()

        import aiohttp
        from aiohttp import web
        return web.Response(body=png, content_type="image/png")

    # 健康检查
    @_routes.get("/wwdm/audio/ping")
    async def wwdm_audio_ping(request):
        import aiohttp
        from aiohttp import web
        return web.json_response({"ok": True, "plugin": "Comfyui-wwdm-tool"})


try:
    _register_routes()
except Exception as e:
    import logging
    logging.getLogger("wwdm.audio").warning("WWDMAudioCrop 自定义路由注册失败（不影响节点功能）: %s", e)
