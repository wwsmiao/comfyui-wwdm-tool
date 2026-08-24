# Comfyui-wwdm-tool

> 📦 仓库: https://github.com/wwsmiao/comfyui-wwdm-tool

WWDM 工具集（ComfyUI 自定义节点插件）

## 当前包含

### 🎵 WWDMAudioCrop — 音频可视化裁剪节点

对输入的 `AUDIO` 音频进行**可视化截取**，交互方式与专业音频剪辑软件一致：

- 🟢 **波形画布**：节点面板内直接显示完整音频波形
- 🟡 **开始手柄**（黄）/ 🔴 **结束手柄**（红）：直接拖动选择裁剪区间
- ▶ **播放按钮**：从选区播放，到选区结束自动停止，播放时显示橙色进度游标
- ⏱ **时间输入行**：开始时间 / 结束时间 / 选取时长（手动输入，精确到 0.01s）
- ⚡ **时长联动**：设置选取时长后，结束手柄自动跳转到「开始时间 + 时长」的位置
- 🔍 **缩放平移**：滚轮缩放、空白处拖动平移、双击适配选区

#### 输入

| 参数 | 类型 | 说明 |
|------|------|------|
| `audio` | AUDIO | 输入音频（兼容 ComfyUI 原生 `Load Audio` / VHS 视频音频输出） |
| `start_time` | FLOAT (秒) | 开始时间（0 = 从头开始） |
| `end_time` | FLOAT (秒) | 结束时间（0 = 音频末尾） |
| `duration` | FLOAT (秒) | 选取时长（>0 时强制 `end = start + duration`） |

> 波形上的手柄拖动、时间输入框、节点参数三者**实时双向同步**，任何方式修改都会联动其他两者。

#### 输出

| 输出 | 类型 | 说明 |
|------|------|------|
| `audio` | AUDIO | 裁剪后的音频 |
| `start` | FLOAT | 实际开始时间（秒） |
| `end` | FLOAT | 实际结束时间（秒） |
| `duration` | FLOAT | 实际裁剪时长（秒） |
| `preview` | IMAGE | 原始音频波形预览图（RGB） |

#### 使用示例

```
Load Audio → WWDMAudioCrop → Save Audio (Advanced)
              │  ├ start_time: 2.0
              │  ├ end_time: 5.0        （或 duration: 3.0 自动联动）
              │  └ ...
              └→ Preview Audio
```

也可以在节点面板里直接拖动波形上的黄色/红色手柄来选择区间，播放试听满意后执行即可。

## 安装

1. 将 `Comfyui-wwdm-tool` 放到 `ComfyUI/custom_nodes/` 目录
2. 重启 ComfyUI（或点击 Manager 的 "Restart"）
3. 在节点菜单搜索：`WWDMAudioCrop`（分类 `wwdm-tool/audio`）

## 兼容性

- ✅ 老式 API（`INPUT_TYPES` + `NODE_CLASS_MAPPINGS`），兼容新旧 ComfyUI
- ✅ 音频格式 `{"waveform": tensor[B,C,L], "sample_rate": int}`，兼容原生 Audio 节点与 VHS
- ✅ 纯 Python 标准库 + torch + numpy + PIL 实现，无额外依赖

## 目录结构

```
Comfyui-wwdm-tool/
├── __init__.py              # 插件入口（注册节点 + WEB_DIRECTORY）
├── wwdm_audio/
│   ├── __init__.py          # 音频工具包
│   ├── audio_crop.py        # WWDMAudioCrop 节点 + 波形渲染
│   └── server_routes.py     # 服务端路由（/wwdm/audio/analyze、waveform、ping）
└── web/
    └── js/
        └── wwdm_audio_crop.js  # 前端波形画布 + 双手柄 + 播放 + 时间输入交互
```
