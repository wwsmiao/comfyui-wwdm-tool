/**
 * WWDMAudioCrop —— 音频可视化裁剪节点前端（v4，节点内上传）
 *
 * 设计参考 Goohai-MiniMax-H3_Integration 插件的参考音频功能：
 *   - 节点面板内直接上传音频（点击 / 拖拽），无需连接 AUDIO 输入
 *   - 上传后立即用 Web Audio 纯前端解码并绘制波形（不依赖执行）
 *   - 播放用 <audio> 直接播放 input 目录文件（可任意位置起播）
 *   - 剪辑式交互：开始/结束手柄、播放按钮、时间输入、时长联动
 *
 * 数据流：
 *   上传 → /upload/image 保存到 input → 文件名存 hidden widget audio_file
 *        → fetch(/view?type=input) → decodeAudioData → 前端计算峰值 → 画波形
 *   执行 → 后端读 input 文件裁剪 → 返回 AUDIO + UI 消息（波形/URL）
 *   兼容：连接了外部 AUDIO 输入时，执行后 onExecuted 也会载入波形
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_TYPE = "WWDMAudioCrop";

// 插件版本号（每次更新递增；显示在波形画布左上角，便于确认是否最新版）
const WWDM_VERSION = "v4.0.0";

function normalizeUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  return api.apiURL(url.replace(/^\/+/, ""));
}
function fmtTime(t) {
  if (!isFinite(t) || t < 0) return "0.00";
  return t.toFixed(2);
}
function fmtDuration(d) {
  const s = Math.max(0, Number(d) || 0);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + (s - m * 60).toFixed(3).padStart(6, "0");
}
function makeFileUrl(name) {
  if (!name) return "";
  const parts = String(name).replaceAll("\\", "/").split("/").filter(Boolean);
  const filename = parts.pop() || "";
  const params = new URLSearchParams({ filename, type: "input", subfolder: parts.join("/") });
  const path = "/view?" + params.toString();
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

// =====================================================================
// WaveCanvas —— 波形画布（双手柄 + 播放头 + 缩放平移）
// =====================================================================
class WaveCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;

    this.peaks = null;
    this.sampleRate = 44100;
    this.duration = 0;

    this.viewStart = 0;
    this.viewEnd = 0;
    this.selStart = 0;
    this.selEnd = 0;
    this.playhead = -1;

    this.dragging = null;
    this.dragStartX = 0;
    this.dragStartView = 0;
    this.dragStartSel = null;

    this.audio = null;
    this.playing = false;
    this.playRaf = null;

    this._bound = {
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
    };
    this._bind();
  }

  // ---------------------------------------------------------- 数据
  setData(peaks, sampleRate, duration) {
    this.peaks = Float32Array.from(peaks || []);
    this.sampleRate = sampleRate || 44100;
    this.duration = duration || (this.peaks.length ? this.peaks.length : 0);
    if (this.duration > 0 && this.viewEnd <= this.viewStart) {
      this.viewStart = 0;
      this.viewEnd = this.duration;
      if (this.selEnd <= this.selStart) this.selEnd = this.duration;
    }
    this.render();
    if (this.opts.onSelection) this.opts.onSelection();
  }
  get hasData() {
    return !!this.peaks && this.peaks.length > 0 && this.duration > 0;
  }

  // ---------------------------------------------------------- 选区
  setSelection(s, e, silent) {
    const dur = this.duration || 1;
    this.selStart = Math.max(0, Math.min(s, dur));
    this.selEnd = Math.max(this.selStart, Math.min(e, dur));
    this.render();
    if (!silent && this.opts.onSelection) this.opts.onSelection();
  }
  get selection() {
    return { start: this.selStart, end: this.selEnd };
  }
  setDuration(d, silent) {
    const dur = this.duration || 1;
    const end = Math.min(this.selStart + Math.max(0, d), dur);
    this.setSelection(this.selStart, end, silent);
  }
  setPlayhead(t) {
    this.playhead = t;
    this.render();
    if (this.opts.onPlayhead) this.opts.onPlayhead();
  }

  // ---------------------------------------------------------- 视图
  fitAll() {
    this.viewStart = 0;
    this.viewEnd = this.duration || 1;
    this.render();
  }
  fitSelection() {
    if (!this.hasData) return;
    let pad = (this.selEnd - this.selStart) * 0.15;
    if (pad <= 0) pad = this.duration * 0.05 || 1;
    this.viewStart = Math.max(0, this.selStart - pad);
    this.viewEnd = Math.min(this.duration, this.selEnd + pad);
    this.render();
  }
  _xToTime(x) {
    const w = this.canvas.clientWidth || this.canvas.width;
    if (w <= 0) return 0;
    return this.viewStart + (x / w) * (this.viewEnd - this.viewStart);
  }
  _timeToX(t) {
    const w = this.canvas.clientWidth || this.canvas.width;
    if (w <= 0) return 0;
    return ((t - this.viewStart) / Math.max(1e-6, this.viewEnd - this.viewStart)) * w;
  }
  zoomBy(factor, centerX) {
    if (!this.hasData) return;
    const w = this.canvas.clientWidth || this.canvas.width;
    const c = this._xToTime(centerX || w / 2);
    let span = (this.viewEnd - this.viewStart) / factor;
    span = Math.max(0.05, Math.min(span, this.duration || 1));
    this.viewStart = Math.max(0, c - span / 2);
    this.viewEnd = Math.min(this.duration, c + span / 2);
    if (this.viewEnd - this.viewStart < span * 0.99) {
      this.viewStart = Math.max(0, this.viewEnd - span);
    }
    this.render();
  }
  panBy(dxPx) {
    if (!this.hasData) return;
    const w = this.canvas.clientWidth || this.canvas.width;
    const dt = (-dxPx / w) * (this.viewEnd - this.viewStart);
    const span = this.viewEnd - this.viewStart;
    let s = this.viewStart + dt;
    s = Math.max(0, Math.min(s, Math.max(0, this.duration - span)));
    this.viewStart = s;
    this.viewEnd = s + span;
    this.render();
  }

  // ---------------------------------------------------------- 播放
  playRange(from, to, url) {
    if (!url || !this.hasData) return;
    this.stop();
    this.audio = new Audio(url);
    this.audio.currentTime = Math.max(0, Math.min(from, this.duration));
    this.audioEndTime = Math.max(from, Math.min(to, this.duration));
    this.playing = true;
    this.audio.play().catch(() => {});
    this._playLoop();
  }
  playSelection(url) {
    if (!url || !this.hasData) return;
    let from = this.selStart;
    if (this.playhead >= this.selStart && this.playhead <= this.selEnd) {
      from = this.playhead;
    }
    this.playRange(from, this.selEnd, url);
  }
  stop() {
    this.playing = false;
    if (this.playRaf) cancelAnimationFrame(this.playRaf);
    this.playRaf = null;
    if (this.audio) {
      try {
        this.audio.pause();
        this.audio.removeAttribute("src");
      } catch (e) {}
      this.audio = null;
    }
    this.render();
  }
  _playLoop() {
    if (!this.audio || !this.playing) return;
    if (this.audio.currentTime >= this.audioEndTime) {
      this.setPlayhead(this.audioEndTime);
      this.stop();
      return;
    }
    this.setPlayhead(this.audio.currentTime);
    this.playRaf = requestAnimationFrame(() => this._playLoop());
  }

  // ---------------------------------------------------------- 事件
  _bind() {
    const c = this.canvas;
    const rect = () => c.getBoundingClientRect();

    c.addEventListener("mousedown", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      const w = c.clientWidth || c.width;
      const edgePx = Math.max(8, w * 0.01);
      const sx = this._timeToX(this.selStart);
      const ex = this._timeToX(this.selEnd);
      const isSel = t >= this.selStart && t <= this.selEnd;

      if (e.button === 1) {
        e.preventDefault();
        this.dragging = "view";
        this.dragStartX = e.clientX;
        this.dragStartView = this.viewStart;
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;

      if (Math.abs(x - sx) <= edgePx && isSel) {
        this.dragging = "left";
      } else if (Math.abs(x - ex) <= edgePx && isSel) {
        this.dragging = "right";
      } else if (isSel) {
        this.dragging = "sel";
        this.dragStartSel = { s: this.selStart, e: this.selEnd };
      } else {
        this.setPlayhead(Math.max(0, Math.min(t, this.duration)));
        this.dragging = "view";
        this.dragStartX = e.clientX;
        this.dragStartView = this.viewStart;
      }
      this.dragStartX = e.clientX;
      c.setPointerCapture && c.setPointerCapture(e.pointerId);
      document.addEventListener("mousemove", this._bound.move);
      document.addEventListener("mouseup", this._bound.up);
    });

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = rect();
      const x = e.clientX - r.left;
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      this.zoomBy(factor, x);
    }, { passive: false });

    c.addEventListener("dblclick", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      if (t >= this.selStart && t <= this.selEnd) {
        this.fitSelection();
      } else {
        this.fitAll();
      }
    });
  }

  _onMove(e) {
    if (!this.dragging) return;
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = this._xToTime(x);
    const w = c.clientWidth || c.width;
    const dt = ((e.clientX - this.dragStartX) / Math.max(1, w)) * (this.viewEnd - this.viewStart);
    const dur = this.duration || 1;
    const minGap = 0.01;

    if (this.dragging === "left") {
      this.selStart = Math.max(0, Math.min(t, this.selEnd - minGap));
    } else if (this.dragging === "right") {
      this.selEnd = Math.min(dur, Math.max(t, this.selStart + minGap));
    } else if (this.dragging === "sel") {
      let s = this.dragStartSel.s + dt;
      let en = this.dragStartSel.e + dt;
      if (s < 0) { en -= s; s = 0; }
      if (en > dur) { s -= en - dur; en = dur; }
      this.selStart = s;
      this.selEnd = en;
    } else if (this.dragging === "view") {
      this.viewStart = Math.max(0, Math.min(this.dragStartView - dt, Math.max(0, dur - (this.viewEnd - this.viewStart))));
      this.viewEnd = this.viewStart + (this.viewEnd - this.viewStart);
    }
    this.render();
    if (this.opts.onSelection) this.opts.onSelection();
  }

  _onUp() {
    this.dragging = null;
    this.canvas.style.cursor = "";
    document.removeEventListener("mousemove", this._bound.move);
    document.removeEventListener("mouseup", this._bound.up);
  }

  // ---------------------------------------------------------- 渲染
  render() {
    const c = this.canvas;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 320;
    const h = c.clientHeight || 140;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#0e1420";
    ctx.fillRect(0, 0, w, h);

    // 版本标记
    ctx.fillStyle = "rgba(120, 160, 220, 0.55)";
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.fillText("wwdm " + WWDM_VERSION, 4, h - 5);

    if (!this.hasData) {
      ctx.fillStyle = "#55607a";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("请在上方上传音频文件", w / 2, h / 2);
      return;
    }

    const t0 = this.viewStart;
    const t1 = this.viewEnd;
    const span = Math.max(1e-6, t1 - t0);
    const n = this.peaks.length;
    const center = h / 2;
    const sx = this._timeToX(this.selStart);
    const ex = this._timeToX(this.selEnd);

    // 选区背景
    ctx.fillStyle = "rgba(70, 200, 120, 0.18)";
    ctx.fillRect(sx, 0, Math.max(0, ex - sx), h);

    // 波形
    ctx.beginPath();
    for (let px = 0; px <= w; px += 1) {
      const t = t0 + (px / w) * span;
      const idx = Math.floor((t / Math.max(1e-6, this.duration)) * n);
      const peak = this.peaks[Math.max(0, Math.min(n - 1, idx))] || 0;
      const amp = Math.pow(Math.min(1, peak * (this.opts.gain || 2.2)), 0.7);
      const y0 = center - amp * (center - 6);
      const y1 = center + amp * (center - 6);
      ctx.moveTo(px, y0);
      ctx.lineTo(px, y1);
    }
    ctx.strokeStyle = "#59d28b";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 中线
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(0, center);
    ctx.lineTo(w, center);
    ctx.stroke();

    // 时间刻度
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    let step = 5;
    while (span / step > 240) step *= 2;
    while (span / step < 60) step /= 2;
    step = Math.max(1, Math.floor(step));
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = this._timeToX(t);
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(fmtTime(t), x + 2, 12);
    }

    // 播放头
    if (this.playhead >= 0) {
      const px = this._timeToX(this.playhead);
      ctx.strokeStyle = "rgba(255,170,60,0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this._drawHandle(sx, "#ffd54a");
    this._drawHandle(ex, "#ff6b6b");

    if (ex - sx > 40) {
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(fmtTime(this.selEnd - this.selStart) + "s", (sx + ex) / 2, 14);
    }
  }

  _drawHandle(x, color) {
    const ctx = this.ctx;
    const h = this.canvas.clientHeight || this.canvas.height;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, 8, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0e1420";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  destroy() {
    this.stop();
    document.removeEventListener("mousemove", this._bound.move);
    document.removeEventListener("mouseup", this._bound.up);
  }
}

// =====================================================================
// 前端解码工具（Goohai 同款：fetch -> decodeAudioData -> 峰值）
// =====================================================================
async function decodeAudioBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("音频解码失败: HTTP " + response.status);
  const bytes = await response.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("浏览器不支持 Web Audio");
  const ctx = new AC();
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
}

function bufferToPeaks(buffer, numBuckets) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const total = buffer.length;
  const peaks = new Float32Array(numBuckets);
  if (total === 0) return peaks;
  for (let b = 0; b < numBuckets; b++) {
    const start = Math.floor((b / numBuckets) * total);
    const end = Math.max(start + 1, Math.floor(((b + 1) / numBuckets) * total));
    let max = 0;
    const stride = Math.max(1, Math.floor((end - start) / 64));
    for (let s = start; s < end; s += stride) {
      for (const data of channels) {
        const v = Math.abs(data[s] || 0);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  return peaks;
}

// =====================================================================
// 节点注册
// =====================================================================
app.registerExtension({
  name: "wwdm.AudioCrop",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      // ---------- 上传区 ----------
      const uploadZone = $el("div", {
        style: {
          width: "100%",
          border: "1px dashed #2c5368",
          borderRadius: "6px",
          background: "#101b26",
          color: "#08b4ed",
          fontSize: "12px",
          textAlign: "center",
          padding: "10px 8px",
          cursor: "pointer",
          boxSizing: "border-box",
          transition: "border-color .12s, background .12s",
        },
        textContent: "📂 点击或拖拽上传音频",
      });
      uploadZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = "#0aa4d6";
        uploadZone.style.background = "#142633";
      });
      uploadZone.addEventListener("dragleave", () => {
        uploadZone.style.borderColor = "#2c5368";
        uploadZone.style.background = "#101b26";
      });
      uploadZone.addEventListener("drop", (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = "#2c5368";
        uploadZone.style.background = "#101b26";
        const file = e.dataTransfer?.files?.[0];
        if (file) this._wwdmUpload(file);
      });
      uploadZone.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.mp4";
        inp.onchange = () => {
          if (inp.files?.[0]) this._wwdmUpload(inp.files[0]);
        };
        inp.click();
      });
      this.wwdmUploadZone = uploadZone;
      this.wwdmFileName = $el("div", {
        style: {
          fontSize: "11px",
          color: "#7f94a3",
          marginTop: "4px",
          textAlign: "center",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      });

      // ---------- 波形画布 ----------
      this.wwdmCanvas = $el("canvas", {
        style: {
          width: "100%",
          height: "150px",
          display: "block",
          borderRadius: "4px",
          background: "#0e1420",
          cursor: "crosshair",
          marginTop: "6px",
        },
      });
      this.wwdmWc = new WaveCanvas(this.wwdmCanvas, {
        gain: 2.2,
        onSelection: () => this._wwdmSyncWidgets(),
      });

      // ---------- 时间输入行 ----------
      const mkInput = (label, ref) => {
        const inp = $el("input", {
          type: "number",
          step: "0.01",
          min: "0",
          style: {
            width: "100%",
            background: "#0f1622",
            color: "#dde",
            border: "1px solid #2c3a4d",
            borderRadius: "4px",
            padding: "5px 7px",
            fontSize: "12px",
            boxSizing: "border-box",
          },
        });
        const lab = $el("label", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "3px",
            fontSize: "11px",
            color: "#8fa0b8",
            flex: 1,
          },
        });
        lab.append(document.createTextNode(label), inp);
        this[ref] = inp;
        return lab;
      };
      const inputRow = $el("div", { style: { display: "flex", gap: "8px", marginTop: "6px" } });
      inputRow.append(
        mkInput("开始时间 (s)", "wwdmInpStart"),
        mkInput("结束时间 (s)", "wwdmInpEnd"),
        mkInput("选取时长 (s)", "wwdmInpDur")
      );

      // ---------- 按钮行 ----------
      const btnStyle = (bg) => ({
        background: bg,
        color: "#fff",
        border: "none",
        borderRadius: "5px",
        padding: "7px 16px",
        fontSize: "12px",
        cursor: "pointer",
        fontWeight: 600,
      });
      this.wwdmBtnPlay = $el("button", { textContent: "▶ 播放", style: btnStyle("#2e7d54") });
      this.wwdmBtnPlay.style.flex = "1";
      const hint = $el("div", {
        style: { fontSize: "10px", color: "#5c6a82", flex: "2", lineHeight: "16px", textAlign: "right" },
        textContent: "滚轮缩放 · 空白拖动平移 · 单击设播放头 · 双击适配",
      });
      const btnRow = $el("div", { style: { display: "flex", gap: "8px", marginTop: "6px", alignItems: "center" } });
      btnRow.append(this.wwdmBtnPlay, hint);

      const wrap = $el("div", { style: { width: "100%", padding: "2px 0" } });
      wrap.append(uploadZone, this.wwdmFileName, this.wwdmCanvas, inputRow, btnRow);
      this.wwdmUiEl = wrap;

      if (this.addDOMWidget) {
        this.wwdmWidget = this.addDOMWidget("wwdm_ui", "wwdm_ui", wrap, { serialize: false });
      } else {
        const container = this.el || this.nodeEl || this.constructor?.nodeEl;
        if (container) container.appendChild(wrap);
      }

      // ---------- 输入框事件 ----------
      this._wwdmGuard = false;
      this.wwdmInpStart.addEventListener("input", () => {
        if (this._wwdmGuard || !this.wwdmWc.hasData) return;
        const v = parseFloat(this.wwdmInpStart.value);
        if (isFinite(v) && v >= 0) {
          const dur = this.wwdmWc.duration;
          const s = Math.min(v, dur);
          const e = Math.max(s + 0.01, this.wwdmWc.selEnd);
          this.wwdmWc.setSelection(s, e);
        }
      });
      this.wwdmInpEnd.addEventListener("input", () => {
        if (this._wwdmGuard || !this.wwdmWc.hasData) return;
        const v = parseFloat(this.wwdmInpEnd.value);
        if (isFinite(v) && v >= 0) {
          const e = Math.min(v, this.wwdmWc.duration);
          const s = Math.min(e - 0.01, this.wwdmWc.selStart);
          this.wwdmWc.setSelection(s, e);
        }
      });
      this.wwdmInpDur.addEventListener("input", () => {
        if (this._wwdmGuard || !this.wwdmWc.hasData) return;
        const v = parseFloat(this.wwdmInpDur.value);
        if (isFinite(v) && v >= 0) {
          this.wwdmWc.setDuration(v);
        }
      });

      // ---------- 播放按钮 ----------
      this.wwdmBtnPlay.addEventListener("click", () => {
        if (!this.wwdmAudioUrl && !this._wwdmCurrentName) {
          alert("请先上传音频文件");
          return;
        }
        if (!this.wwdmWc.hasData) {
          alert("波形尚未加载，请稍候或重新上传");
          return;
        }
        if (this.wwdmWc.playing) {
          this.wwdmWc.stop();
          this.wwdmBtnPlay.textContent = "▶ 播放";
        } else {
          this.wwdmWc.playSelection(this.wwdmAudioUrl || makeFileUrl(this._wwdmCurrentName));
          this.wwdmBtnPlay.textContent = "⏹ 停止";
        }
      });

      // ---------- 上传处理 ----------
      this._wwdmUpload = async (file) => {
        if (!file) return;
        this.wwdmUploadZone.textContent = "⏳ 上传中…";
        try {
          const body = new FormData();
          body.append("image", file, file.name);
          body.append("type", "input");
          const response = await api.fetchApi("/upload/image", { method: "POST", body });
          if (!response.ok) throw new Error("上传失败: HTTP " + response.status);
          const result = await response.json();
          const name = [result.subfolder, result.name].filter(Boolean).join("/");
          this._wwdmCurrentName = name;
          this.wwdmFileName.textContent = "已上传: " + name;
          this.wwdmUploadZone.textContent = "📂 点击或拖拽重新上传";
          // 写入隐藏 widget
          const wf = this.widgets?.find((x) => x.name === "audio_file");
          if (wf) wf.value = name;
          this.wwdmAudioUrl = makeFileUrl(name);
          // 前端解码画波形（立即显示，无需执行）
          await this._wwdmLoadFromUrl(makeFileUrl(name), name);
        } catch (err) {
          console.error("[wwdm] 上传失败", err);
          this.wwdmUploadZone.textContent = "❌ 上传失败，点击重试";
          this.wwdmFileName.textContent = String(err.message || err);
        }
      };

      this._wwdmLoadFromUrl = async (url, name) => {
        try {
          this.wwdmCanvas.style.opacity = "0.45";
          const buffer = await decodeAudioBuffer(url);
          const peaks = bufferToPeaks(buffer, 1200);
          const duration = buffer.duration || (buffer.length / (buffer.sampleRate || 44100));
          this.wwdmWc.setData(peaks, buffer.sampleRate || 44100, duration);
          this.wwdmWc.setSelection(0, duration);
          this.wwdmCanvas.style.opacity = "1";
          this._wwdmSyncWidgets();
        } catch (err) {
          console.error("[wwdm] 波形解码失败", err);
          this.wwdmCanvas.style.opacity = "1";
          this.wwdmFileName.textContent = "❌ 波形解码失败: " + String(err.message || err);
        }
      };

      // 恢复已保存的音频文件（工作流加载后）
      const wf = this.widgets?.find((x) => x.name === "audio_file");
      if (wf?.value) {
        const name = String(wf.value);
        this._wwdmCurrentName = name;
        this.wwdmFileName.textContent = "已加载: " + name;
        this.wwdmAudioUrl = makeFileUrl(name);
        this._wwdmLoadFromUrl(makeFileUrl(name), name);
      }

      return r;
    };

    // ---------- 选区 → 节点参数 + 输入框 同步 ----------
    nodeType.prototype._wwdmSyncWidgets = function () {
      if (this._wwdmGuard) return;
      this._wwdmGuard = true;
      try {
        const { start, end } = this.wwdmWc.selection;
        const dur = end - start;
        const w = (name) => this.widgets?.find((x) => x.name === name);
        const ws = w("start_time"), we = w("end_time"), wd = w("duration");
        if (ws) ws.value = start;
        if (we) we.value = end;
        if (wd) wd.value = dur;
        if (this.wwdmInpStart) this.wwdmInpStart.value = fmtTime(start);
        if (this.wwdmInpEnd) this.wwdmInpEnd.value = fmtTime(end);
        if (this.wwdmInpDur) this.wwdmInpDur.value = fmtTime(dur);
      } finally {
        this._wwdmGuard = false;
      }
    };

    // ---------- 节点参数变化 → 波形 ----------
    const onWidgetChanged = nodeType.prototype.onWidgetChanged;
    nodeType.prototype.onWidgetChanged = function (widget, value) {
      const r = onWidgetChanged?.apply(this, arguments);
      if (this._wwdmGuard || !this.wwdmWc?.hasData) return r;
      if (widget?.name === "start_time") {
        const v = parseFloat(value);
        if (isFinite(v) && v >= 0) {
          const e = Math.max(v + 0.01, this.wwdmWc.selEnd);
          this.wwdmWc.setSelection(v, e);
        }
      } else if (widget?.name === "end_time") {
        const v = parseFloat(value);
        if (isFinite(v) && v >= 0) {
          const s = Math.min(v - 0.01, this.wwdmWc.selStart);
          this.wwdmWc.setSelection(s, v);
        }
      } else if (widget?.name === "duration") {
        const v = parseFloat(value);
        if (isFinite(v) && v >= 0) this.wwdmWc.setDuration(v);
      }
      return r;
    };

    // ---------- 执行结果 ----------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      if (message?.wwdm_waveform) {
        const wf = message.wwdm_waveform;
        this.wwdmWc.setData(wf.peaks, wf.sample_rate, wf.duration);
        if (message.wwdm_audio_url) this.wwdmAudioUrl = message.wwdm_audio_url;
        this._wwdmSyncWidgets();
      }
      return r;
    };

    // ---------- 序列化保留波形 ----------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      if (info?.wwdm_waveform) {
        this.wwdmWc.setData(info.wwdm_waveform.peaks, info.wwdm_waveform.sample_rate, info.wwdm_waveform.duration);
      }
      return r;
    };
  },
});

// 全局样式
app.registerExtension({
  name: "wwdm.AudioCrop.style",
  setup() {
    const style = document.createElement("style");
    style.textContent = `
      .wwdm-widget button:hover { filter: brightness(1.15); }
      .wwdm-widget input:focus { outline: 1px solid #2f6fb3; }
    `;
    document.head.appendChild(style);
  },
});
