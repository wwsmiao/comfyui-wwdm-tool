"""
wwdm-audio 音频工具包
包含: WWDMAudioCrop（音频可视化裁剪节点）
"""
from .audio_crop import WWDMAudioCrop
from . import server_routes  # 注册 /wwdm/audio/* 路由（analyze / waveform / ping）

NODE_CLASS_MAPPINGS = {
    "WWDMAudioCrop": WWDMAudioCrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WWDMAudioCrop": "WWDM Audio Crop",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WWDMAudioCrop"]
