/**
 * WWDMAudioCrop 节点前端扩展
 *
 * 可视化音频裁剪：
 *   1. 进度条方式：slider_start / slider_end 两个百分比滑块，拖动选择裁剪区间
 *   2. 起止时间方式：start_time / end_time 直接输入秒数
 *   3. 开始时间 + 秒数方式：start_time + duration
 *
 * 交互：
 *   - 节点面板内绘制音频波形图（绿色），叠加半透明选区（选区 = 保留区域）
 *   - 在波形图上拖动可同步更新 slider_start / slider_end 百分比
 *   - 波形图上方有两条可拖动游标（开始/结束），拖动实时同步各输入
 *   - 输入框手动改值时，游标与选区同步移动
 */

import { app } from "../../../scripts/app.js";

const NODE_TYPE = "WWDMAudioCrop";

// 颜色配置
const COLORS = {
    bg: "rgba(18,22,32,0.92)",
    wave: "#58c4ff",
    waveDim: "rgba(88,196,255,0.28)",
    center: "rgba(70,90,130,0.6)",
    select: "rgba(56,255,170,0.22)",
    selectBorder: "rgba(56,255,170,0.85)",
    cursor: "#ffd166",
    cursorHandle: "#ffb703",
    text: "#cfd8e3",
    textDim: "#7a8699",
    grid: "rgba(255,255,255,0.05)",
};

// 简易工具函数
function fmtTime(sec) {
    if (sec == null || !isFinite(sec)) return "0.00s";
    return sec.toFixed(2) + "s";
}

function parseNum(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : NaN;
}

app.registerExtension({
    name: "WWDM.AudioCrop",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_TYPE) return;

        // ---------- 节点创建：添加可视化控件 ----------
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);

            // 波形画布
            this._wwdmCanvas = document.createElement("canvas");
            this._wwdmCanvas.style.width = "100%";
            this._wwdmCanvas.style.height = "150px";
            this._wwdmCanvas.style.display = "block";
            this._wwdmCanvas.style.background = COLORS.bg;
            this._wwdmCanvas.style.borderRadius = "6px";
            this._wwdmCanvas.style.cursor = "crosshair";
            this._wwdmCanvas.style.marginTop = "4px";
            this._wwdmCanvas.style.touchAction = "none";

            // 信息标签（总时长 / 选区时长）
            this._wwdmInfo = document.createElement("div");
            this._wwdmInfo.style.cssText =
                "font-size:11px;color:" + COLORS.textDim + ";margin:2px 0 4px 0;user-select:none;";
            this._wwdmInfo.textContent = "未加载音频";

            // 放入节点 DOM
            const container = this.addDOMWidget
                ? this.addDOMWidget("wwdm_waveform", "waveform", this._wwdmCanvas, {
                      serialize: false,
                      hideOnZoom: false,
                  })
                : null;
            if (container) {
                container.computeSize = function () {
                    return [this.parent?.computeSize?.(this) ?? 260, 150];
                };
            }
            this._wwdmCanvas.dataset.wwdmWidget = "1";

            // 画布事件：拖拽选择区间
            this._wwdmDragging = null; // {mode:'start'|'end'|'range', startX:..}
            const self = this;

            const getWave = () => self._wwdmWave; // 当前波形数据（Float32Array 或 null）
            const getDur = () => self._wwdmDuration || 0; // 总时长秒

            const pxToSec = (px) => {
                const rect = self._wwdmCanvas.getBoundingClientRect();
                if (!rect.width) return 0;
                const ratio = (px - rect.left) / rect.width;
                return Math.max(0, Math.min(1, ratio)) * getDur();
            };

            const setSlider = (which, sec) => {
                const dur = getDur();
                if (!dur) return;
                const pct = (sec / dur) * 100;
                const w = self.widgets?.find((x) => x.name === which);
                if (w) {
                    w.value = Math.max(0, Math.min(100, pct));
                    w.callback?.(w.value);
                }
            };

            // 统一读取当前裁剪参数（秒）
            const readParams = () => {
                const gv = (n) => {
                    const w = self.widgets?.find((x) => x.name === n);
                    return w ? parseNum(w.value) : NaN;
                };
                const dur = getDur();
                let s = gv("start_time");
                if (!(s > 0)) s = (gv("slider_start") / 100) * dur;
                let e = gv("end_time");
                if (!(e > 0)) e = (gv("slider_end") / 100) * dur;
                const d = gv("duration");
                if (d > 0) e = s + d;
                s = Math.max(0, Math.min(s, dur));
                e = Math.max(s, Math.min(e, dur));
                return { s, e, dur };
            };

            // 画布重绘
            const draw = () => {
                const c = self._wwdmCanvas;
                if (!c) return;
                const dpr = window.devicePixelRatio || 1;
                const w = c.clientWidth || 260;
                const h = c.clientHeight || 150;
                if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
                    c.width = Math.floor(w * dpr);
                    c.height = Math.floor(h * dpr);
                }
                const ctx = c.getContext("2d");
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.clearRect(0, 0, w, h);

                // 背景
                ctx.fillStyle = COLORS.bg;
                ctx.fillRect(0, 0, w, h);

                const { s, e, dur } = readParams();
                const wave = getWave();

                // 波形绘制
                const centerY = h / 2;
                const ampMax = (h / 2) - 6;
                if (wave && wave.length) {
                    const n = wave.length;
                    for (let x = 0; x < w; x++) {
                        const i0 = Math.floor((x / w) * n);
                        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
                        let peak = 0;
                        for (let i = i0; i < i1 && i < n; i++) peak = Math.max(peak, wave[i]);
                        const a = Math.pow(Math.min(1, peak), 0.7) * ampMax;
                        if (a > 0.5) {
                            ctx.fillStyle = COLORS.waveDim;
                            ctx.fillRect(x, centerY - a, 1, a * 2);
                        }
                    }
                } else {
                    ctx.fillStyle = COLORS.textDim;
                    ctx.font = "11px sans-serif";
                    ctx.textAlign = "center";
                    ctx.fillText("未加载音频波形", w / 2, centerY);
                }

                // 中线
                ctx.fillStyle = COLORS.center;
                ctx.fillRect(0, centerY, w, 1);

                // 选区（保留区域）
                if (dur > 0) {
                    const x0 = (s / dur) * w;
                    const x1 = (e / dur) * w;
                    ctx.fillStyle = COLORS.select;
                    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
                    ctx.fillStyle = COLORS.selectBorder;
                    ctx.fillRect(x0, 0, 1, h);
                    ctx.fillRect(x1 - 1, 0, 1, h);

                    // 游标
                    const drawCursor = (x) => {
                        ctx.fillStyle = COLORS.cursor;
                        ctx.fillRect(x - 2, 0, 4, h);
                        ctx.fillStyle = COLORS.cursorHandle;
                        ctx.beginPath();
                        ctx.moveTo(x - 5, 0);
                        ctx.lineTo(x + 5, 0);
                        ctx.lineTo(x, 8);
                        ctx.closePath();
                        ctx.fill();
                        ctx.beginPath();
                        ctx.moveTo(x - 5, h);
                        ctx.lineTo(x + 5, h);
                        ctx.lineTo(x, h - 8);
                        ctx.closePath();
                        ctx.fill();
                    };
                    drawCursor(x0);
                    drawCursor(x1);

                    // 时间标注
                    ctx.font = "10px monospace";
                    ctx.textAlign = "left";
                    ctx.fillStyle = COLORS.text;
                    ctx.fillText(fmtTime(s), x0 + 3, 12);
                    ctx.textAlign = "right";
                    ctx.fillText(fmtTime(e), x1 - 3, h - 6);
                }

                // 信息
                if (self._wwdmInfo) {
                    const sel = Math.max(0, e - s);
                    self._wwdmInfo.textContent =
                        "总时长 " + fmtTime(dur) + " ｜ 选区 " + fmtTime(sel) +
                        " ｜ start " + fmtTime(s) + " ～ end " + fmtTime(e);
                }
            };
            self._wwdmDraw = draw;

            // 鼠标/触摸交互
            const onDown = (ev) => {
                if (!getDur()) return;
                ev.preventDefault();
                const rect = self._wwdmCanvas.getBoundingClientRect();
                const x = (ev.clientX ?? ev.touches?.[0]?.clientX) - rect.left;
                const { s, e, dur } = readParams();
                const w = rect.width;
                const xs = (s / dur) * w;
                const xe = (e / dur) * w;
                let mode = null;
                if (Math.abs(x - xs) < 8) mode = "start";
                else if (Math.abs(x - xe) < 8) mode = "end";
                else mode = "range";
                self._wwdmDragging = { mode, startX: x, startS: s, startE: e, width: w };
                self._wwdmCanvas.style.cursor = mode === "range" ? "grabbing" : "ew-resize";
            };
            const onMove = (ev) => {
                if (!self._wwdmDragging) return;
                ev.preventDefault();
                const rect = self._wwdmCanvas.getBoundingClientRect();
                const x = (ev.clientX ?? ev.touches?.[0]?.clientX) - rect.left;
                const d = self._wwdmDragging;
                const dur = getDur();
                const w = rect.width || d.width;
                const dx = ((x - d.startX) / w) * dur;
                let ns = d.startS;
                let ne = d.startE;
                if (d.mode === "start") {
                    ns = Math.max(0, Math.min(ne - 0.05, d.startS + dx));
                } else if (d.mode === "end") {
                    ne = Math.min(dur, Math.max(ns + 0.05, d.startE + dx));
                } else {
                    ns = Math.max(0, Math.min(dur, d.startS + dx));
                    ne = Math.min(dur, d.startE + dx);
                    if (ne < ns) { const t = ns; ns = ne; ne = t; }
                }
                // 同步滑块（百分比）→ 触发 widget callback → 输入框同步
                setSlider("slider_start", ns);
                setSlider("slider_end", ne);
                draw();
            };
            const onUp = () => {
                self._wwdmDragging = null;
                self._wwdmCanvas.style.cursor = "crosshair";
            };
            self._wwdmCanvas.addEventListener("mousedown", onDown);
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            self._wwdmCanvas.addEventListener("touchstart", onDown, { passive: false });
            self._wwdmCanvas.addEventListener("touchmove", onMove, { passive: false });
            self._wwdmCanvas.addEventListener("touchend", onUp);

            // 输入框变化 → 重绘（选区/游标同步）
            const refreshFromWidgets = () => draw();
            for (const name of ["slider_start", "slider_end", "start_time", "end_time", "duration"]) {
                const w = this.widgets?.find((x) => x.name === name);
                if (w) {
                    const orig = w.callback;
                    w.callback = function () {
                        const r = orig?.apply(this, arguments);
                        refreshFromWidgets();
                        return r;
                    };
                }
            }

            // 重新布局时重绘
            this.onResize?.(refreshFromWidgets);

            return r;
        };

        // ---------- 波形数据加载：从后端取原始音频波形 ----------
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted?.apply(this, arguments);
            // 后端在 result 里附带波形缩略数据时使用
            if (message?.wwdm_waveform) {
                this._wwdmWave = message.wwdm_waveform; // Float32Array 归一化峰值
                this._wwdmDuration = message.wwdm_duration || 0;
                if (this._wwdmInfo) {
                    this._wwdmInfo.textContent = "波形已更新 ｜ 总时长 " + fmtTime(this._wwdmDuration);
                }
                this._wwdmDraw?.();
            }
            return r;
        };
    },

    // ---------- 前端路由：节点需要波形数据时，请求自定义 API ----------
    async setup() {
        // 提供全局方法供节点使用（如未来扩展）
        window.__wwdmAudio = {
            async fetchWaveform(waveformB64, sampleRate, shape, width = 1200) {
                try {
                    const resp = await fetch("/wwdm/audio/waveform", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            waveform_b64: waveformB64,
                            sample_rate: sampleRate,
                            shape,
                            width,
                        }),
                    });
                    if (!resp.ok) return null;
                    const blob = await resp.blob();
                    return URL.createObjectURL(blob);
                } catch (e) {
                    console.error("[WWDM AudioCrop] waveform fetch failed", e);
                    return null;
                }
            },
        };
    },
});
