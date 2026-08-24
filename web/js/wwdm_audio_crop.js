/**
 * WWDMAudioCrop —— 音频可视化裁剪节点前端（v5）
 *
 * v5 修复与优化（基于用户实测反馈）：
 *   1. 可复用已上传音频：上传区下方增加"已上传音频"下拉框（列出 input 目录音频），可切换
 *   2. 修复手柄拖动：改用 Pointer Events（setPointerCapture 对 pointerId 有效），
 *      扩大手柄命中区；黄/红手柄可自由拖动，选区内按住左键可整体拖动选区
 *   3. 时间格式 mm:ss：开始/结束/时长输入框支持 "mm:ss"（或 "mm:ss.xxx" / 纯秒），
 *      任意一处修改 → 另一处 + 波形手柄同步更新
 *   4. 修复播放：从开始手柄位置起播到结束手柄位置自动停止（可试听截取内容）；
 *      播放中按钮变"⏹ 停止"，再次点击可停止
 *
 * 架构（沿用 v4，参考 Goohai 参考音频功能）：
 *   上传 → /upload/image → 文件名存 hidden widget audio_file → 前端解码画波形 → <audio> 播放
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_TYPE = "WWDMAudioCrop";

// 插件版本号（每次更新递增；显示在波形画布左上角，便于确认是否最新版）
const WWDM_VERSION = "v5.0.0";

function normalizeUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  return api.apiURL(url.replace(/^\/+/, ""));
}

// ---------- 时间格式工具（mm:ss 支持）----------
/** 解析 "mm:ss" / "mm:ss.xxx" / "ss.xxx" / 纯数字秒 → 秒数；解析失败返回 null */
function parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseFloat(s); // 纯秒
  const m = s.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (m) {
    const sec = parseInt(m[2], 10);
    if (sec >= 60) return null;
    const frac = m[3] ? parseFloat("0." + m[3]) : 0;
    return parseInt(m[1], 10) * 60 + sec + frac;
  }
  const f = parseFloat(s);
  return isFinite(f) && f >= 0 ? f : null;
}
/** 秒 → "mm:ss"（含小数保留 2 位） */
function fmtMMSS(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(2);
  const [ssi, ssf] = ss.split(".");
  const pad = (n) => String(n).padStart(2, "0");
  if (ssf && ssf !== "00") return `${pad(m)}:${pad(ssi)}.${ssf}`;
  return `${pad(m)}:${pad(ssi)}`;
}
/** 时长标签用（秒） */
function fmtTime(t) {
  if (!isFinite(t) || t < 0) return "0.00";
  return t.toFixed(2);
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
// 使用 Pointer Events 实现稳定拖动
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

    this.dragging = null; // 'left' | 'right' | 'sel' | 'view'
    this.dragStartX = 0;
    this.dragStartView = 0;
    this.dragStartSel = null;
    this.pointerId = null;

    this.audio = null;
    this.playing = false;
    this.playRaf = null;
    this.audioUrl = null;

    this._bound = {
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
      cancel: (e) => this._onUp(e),
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
  /** 从 from 播放到 to（起点用开始手柄位置，终点用结束手柄位置） */
  playRange(from, to, url) {
    if (!url || !this.hasData) return;
    this.stop();
    this.audioUrl = url;
    const audio = new Audio(url);
    this.audio = audio;
    this.audioEndTime = Math.max(from, Math.min(to, this.duration));
    this.playing = true;

    // 等待元数据加载完成后再设置起点并播放（否则 currentTime 设置无效）
    const startPlay = () => {
      try {
        audio.currentTime = Math.max(0, Math.min(from, this.duration));
      } catch (e) {}
      audio.play().catch(() => {});
      this._playLoop();
    };
    if (audio.readyState >= 1) {
      startPlay();
    } else {
      audio.addEventListener("loadedmetadata", startPlay, { once: true });
      audio.addEventListener("error", () => {
        this.stop();
        this.playing = false;
        if (this.opts.onPlayState) this.opts.onPlayState(false);
      }, { once: true });
    }
  }
  /** 播放选区：始终从开始手柄位置起播（若播放头在选区内则从播放头起播） */
  playSelection(url) {
    if (!url || !this.hasData) return;
    let from = this.selStart;
    if (this.playhead >= this.selStart && this.playhead <= this.selEnd) {
      from = this.playhead;
    }
    this.playRange(from, this.selEnd, url);
    if (this.opts.onPlayState) this.opts.onPlayState(true);
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
    if (this.opts.onPlayState) this.opts.onPlayState(false);
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

  // ---------------------------------------------------------- 事件（Pointer Events）
  _bind() {
    const c = this.canvas;
    const rect = () => c.getBoundingClientRect();

    c.addEventListener("pointerdown", (e) => {
      const r = rect();
      const x = e.clientX - r.left;
      const t = this._xToTime(x);
      const w = c.clientWidth || c.width;
      const edgePx = 14; // 手柄命中区（像素）
      const sx = this._timeToX(this.selStart);
      const ex = this._timeToX(this.selEnd);
      const isSel = t >= this.selStart && t <= this.selEnd;

      if (e.button === 1) {
        // 中键：平移视图
        e.preventDefault();
        this.dragging = "view";
        this.dragStartX = e.clientX;
        this.dragStartView = this.viewStart;
        this.pointerId = e.pointerId;
        c.setPointerCapture(e.pointerId);
        c.style.cursor = "grabbing";
        return;
      }
      if (e.button !== 0) return;

      // 手柄优先（靠近开始/结束线）
      if (Math.abs(x - sx) <= edgePx && isSel) {
        this.dragging = "left";
      } else if (Math.abs(x - ex) <= edgePx && isSel) {
        this.dragging = "right";
      } else if (isSel) {
        // 选区内按住左键 → 整体拖动选区
        this.dragging = "sel";
        this.dragStartSel = { s: this.selStart, e: this.selEnd };
      } else {
        // 空白处 → 设置播放头，并开始平移视图
        this.setPlayhead(Math.max(0, Math.min(t, this.duration)));
        this.dragging = "view";
        this.dragStartX = e.clientX;
        this.dragStartView = this.viewStart;
      }
      this.dragStartX = e.clientX;
      this.pointerId = e.pointerId;
      c.setPointerCapture(e.pointerId);
      c.addEventListener("pointermove", this._bound.move);
      c.addEventListener("pointerup", this._bound.up);
      c.addEventListener("pointercancel", this._bound.cancel);
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
    if (!this.dragging || (this.pointerId != null && e.pointerId !== this.pointerId)) return;
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

  _onUp(e) {
    if (this.pointerId != null && e && e.pointerId !== this.pointerId) return;
    this.dragging = null;
    this.pointerId = null;
    const c = this.canvas;
    c.style.cursor = "";
    try {
      c.removeEventListener("pointermove", this._bound.move);
      c.removeEventListener("pointerup", this._bound.up);
      c.removeEventListener("pointercancel", this._bound.cancel);
    } catch (err) {}
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

    // 时间刻度（按跨度自适应）
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
      ctx.fillText(fmtMMSS(t), x + 2, 12);
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
      ctx.fillText(fmtMMSS(this.selEnd - this.selStart), (sx + ex) / 2, 14);
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
    try {
      const c = this.canvas;
      c.removeEventListener("pointermove", this._bound.move);
      c.removeEventListener("pointerup", this._bound.up);
      c.removeEventListener("pointercancel", this._bound.cancel);
    } catch (err) {}
  }
}

// =====================================================================
// 前端解码工具
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

      // ---------- 已上传音频下拉框（可复用） ----------
      this.wwdmFileSelect = $el("select", {
        style: {
          width: "100%",
          background: "#0f1622",
          color: "#dde",
          border: "1px solid #2c3a4d",
          borderRadius: "4px",
          padding: "5px 7px",
          fontSize: "12px",
          boxSizing: "border-box",
          marginTop: "6px",
          display: "none",
        },
      });
      this.wwdmFileSelect.addEventListener("change", () => {
        const name = this.wwdmFileSelect.value;
        if (!name) return;
        this._wwdmLoadFile(name);
      });
      const fileRow = $el("div", { style: { display: "flex", gap: "6px", marginTop: "0" } });
      fileRow.append(this.wwdmFileSelect);
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
          touchAction: "none",
        },
      });
      this.wwdmWc = new WaveCanvas(this.wwdmCanvas, {
        gain: 2.2,
        onSelection: () => this._wwdmSyncWidgets(),
        onPlayState: (playing) => {
          this.wwdmBtnPlay.textContent = playing ? "⏹ 停止" : "▶ 播放";
        },
      });

      // ---------- 时间输入行（mm:ss 格式） ----------
      const mkInput = (label, ref) => {
        const inp = $el("input", {
          type: "text",
          placeholder: "mm:ss",
          spellcheck: "false",
          style: {
            width: "100%",
            background: "#0f1622",
            color: "#dde",
            border: "1px solid #2c3a4d",
            borderRadius: "4px",
            padding: "5px 7px",
            fontSize: "12px",
            boxSizing: "border-box",
            fontFamily: "monospace",
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
        mkInput("开始时间", "wwdmInpStart"),
        mkInput("结束时间", "wwdmInpEnd"),
        mkInput("选取时长", "wwdmInpDur")
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
      wrap.append(uploadZone, fileRow, this.wwdmFileName, this.wwdmCanvas, inputRow, btnRow);
      this.wwdmUiEl = wrap;

      if (this.addDOMWidget) {
        this.wwdmWidget = this.addDOMWidget("wwdm_ui", "wwdm_ui", wrap, { serialize: false });
      } else {
        const container = this.el || this.nodeEl || this.constructor?.nodeEl;
        if (container) container.appendChild(wrap);
      }

      // ---------- 输入框事件（mm:ss，双向同步） ----------
      this._wwdmGuard = false;
      this.wwdmInpStart.addEventListener("input", () => {
        if (this._wwdmGuard || !this.wwdmWc.hasData) return;
        const v = parseTime(this.wwdmInpStart.value);
        if (v == null) return;
        const dur = this.wwdmWc.duration;
        const s = Math.min(v, dur);
        const e = Math.max(s + 0.01, this.wwdmWc.selEnd);
        this.wwdmWc.setSelection(s, e);
      });
      this.wwdmInpEnd.addEventListener("input", () => {
        if (this._wwdmGuard || !this.wwdmWc.hasData) return;
        const v = parseTime(this.wwdmInpEnd.value);
        if (v == null) return;
        const e = Math.min(v, this.wwdmWc.duration);
        const s = Math.min(e - 0.01, this.wwdmWc.selStart);
        this.wwdmWc.setSelection(s, e);
      });
      this.wwdmInpDur.addEventListener("input", () => {
        if (this._wwdmGuard || !this.wwdmWc.hasData) return;
        const v = parseTime(this.wwdmInpDur.value);
        if (v == null) return;
        this.wwdmWc.setDuration(v);
      });

      // ---------- 播放按钮 ----------
      this.wwdmBtnPlay.addEventListener("click", () => {
        const url = this.wwdmAudioUrl || (this._wwdmCurrentName ? makeFileUrl(this._wwdmCurrentName) : "");
        if (!url) {
          alert("请先上传或选择音频文件");
          return;
        }
        if (!this.wwdmWc.hasData) {
          alert("波形尚未加载，请稍候或重新选择");
          return;
        }
        if (this.wwdmWc.playing) {
          this.wwdmWc.stop();
        } else {
          // 从开始手柄位置播放到结束手柄位置
          this.wwdmWc.playSelection(url);
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
          await this._wwdmLoadFile(name);
          this.wwdmUploadZone.textContent = "📂 点击或拖拽重新上传";
        } catch (err) {
          console.error("[wwdm] 上传失败", err);
          this.wwdmUploadZone.textContent = "❌ 上传失败，点击重试";
          this.wwdmFileName.textContent = String(err.message || err);
        }
      };

      /** 加载已上传/已选择的音频文件（写入 widget + 解码画波形） */
      this._wwdmLoadFile = async (name) => {
        if (!name) return;
        this._wwdmCurrentName = name;
        const wf = this.widgets?.find((x) => x.name === "audio_file");
        if (wf) wf.value = name;
        this.wwdmFileName.textContent = "已加载: " + name;
        this.wwdmAudioUrl = makeFileUrl(name);
        const sel = this.wwdmFileSelect;
        if (sel && ![...sel.options].some((o) => o.value === name)) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (sel) sel.value = name;
        try {
          this.wwdmCanvas.style.opacity = "0.45";
          const buffer = await decodeAudioBuffer(makeFileUrl(name));
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

      // ---------- 刷新已上传文件列表 ----------
      this._wwdmRefreshFiles = async () => {
        try {
          const res = await api.fetchApi("/wwdm/audio/files");
          if (!res.ok) return;
          const data = await res.json();
          const files = data.files || [];
          const sel = this.wwdmFileSelect;
          const cur = this._wwdmCurrentName;
          // 重建选项
          sel.innerHTML = "";
          if (!files.length) {
            sel.style.display = "none";
            return;
          }
          sel.style.display = "block";
          const ph = document.createElement("option");
          ph.value = "";
          ph.textContent = "已上传音频…";
          sel.appendChild(ph);
          for (const f of files) {
            const opt = document.createElement("option");
            opt.value = f;
            opt.textContent = f;
            sel.appendChild(opt);
          }
          if (cur && files.includes(cur)) {
            sel.value = cur;
          }
        } catch (err) {
          console.error("[wwdm] 刷新文件列表失败", err);
        }
      };

      // ---------- 初始化：恢复已保存文件 + 拉取文件列表 ----------
      const wf = this.widgets?.find((x) => x.name === "audio_file");
      if (wf?.value) {
        const name = String(wf.value);
        this._wwdmLoadFile(name);
      }
      this._wwdmRefreshFiles();

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
        if (this.wwdmInpStart) this.wwdmInpStart.value = fmtMMSS(start);
        if (this.wwdmInpEnd) this.wwdmInpEnd.value = fmtMMSS(end);
        if (this.wwdmInpDur) this.wwdmInpDur.value = fmtMMSS(dur);
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
      .wwdm-widget select:focus { outline: 1px solid #2f6fb3; }
    `;
    document.head.appendChild(style);
  },
});
