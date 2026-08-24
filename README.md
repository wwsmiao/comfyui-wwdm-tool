# Comfyui-wwdm-tool

WWDM 工具集（ComfyUI 自定义节点插件）

## 当前包含

### 🎵 WWDMAudioCrop — 音频可视化裁剪节点

对输入的 `AUDIO` 音频进行**可视化裁剪**，支持三种交互方式：

| 方式 | 操作 | 说明 |
|------|------|------|
| **1. 进度条** | 拖动 `slider_start` / `slider_end` 两个百分比滑块 | 0~100% 选择保留区间，节点画布内同步显示波形选区与游标 |
| **2. 起止时间** | 直接填写 `start_time` / `end_time`（秒） | 精确到 0.01s |
| **3. 开始+秒数** | 填写 `start_time` + `duration`（秒） | 自动从开始时间往后裁剪指定秒数 |

三种方式**可自由组合**，优先级规则：

- 填了 `start_time`（>0）→ 以它为准；否则用 `slider_start` 百分比换算
- 填了 `end_time`（>0）→ 以它为准；否则用 `slider_end` 百分比换算
- 填了 `duration`（>0）→ 强制覆盖区间长度（`end = start + duration`）

#### 输入

| 参数 | 类型 | 说明 |
|------|------|------|
| `audio` | AUDIO | 输入音频（兼容 ComfyUI 原生 `Load Audio` / VHS 视频音频输出） |
| `slider_start` | FLOAT (0-100, slider) | 进度条起始百分比 |
| `slider_end` | FLOAT (0-100, slider) | 进度条结束百分比 |
| `start_time` | FLOAT (秒) | 开始时间 |
| `end_time` | FLOAT (秒) | 结束时间 |
| `duration` | FLOAT (秒) | 裁剪时长（方式三） |

#### 输出

| 输出 | 类型 | 说明 |
|------|------|------|
| `audio` | AUDIO | 裁剪后的音频 |
| `start` | FLOAT | 实际开始时间（秒） |
| `end` | FLOAT | 实际结束时间（秒） |
| `duration` | FLOAT | 实际裁剪时长（秒） |
| `preview` | IMAGE | 原始音频波形预览图（RGBA） |

#### 前端可视化

节点面板内自带**波形画布**：

- 🟢 绿色波形 = 音频振幅（峰值）
- 🟩 半透明绿色区域 = 当前选区（保留部分）
- 🟡 黄色游标 = 开始 / 结束位置，可**直接拖拽**
- 波形上**拖拽** = 平移选区；**两端游标** = 调整边界
- 拖动/输入任意方式，画布实时同步

#### 使用示例

```
Load Audio → WWDMAudioCrop → Save Audio (Advanced)
              │  ├ slider_start: 20
              │  ├ slider_end: 80      （方式1：保留中间 60%）
              │  └ ...
              └→ Preview Audio
```

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
│   └── server_routes.py     # 波形数据 API 路由（/wwdm/audio/waveform）
└── web/
    └── js/
        └── wwdm_audio_crop.js  # 前端波形可视化 + 拖拽交互
```
