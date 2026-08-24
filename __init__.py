"""
Comfyui-wwdm-tool 插件包

功能：
    - wwdm-audio：音频可视化裁剪（WWDMAudioCrop 节点）
"""
from .wwdm_audio import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# 前端扩展目录（波形可视化交互）
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
