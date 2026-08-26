/**
 * WWDMAudioCrop —— 音频裁剪节点前端（v8.6）
 *
 * v8.6 重构（用户需求）：去掉波形面板，时间选择改为下拉方式
 *   1. 移除波形画布（WaveCanvas/双手柄/缩放平移/波形渲染全部删除）
 *   2. 开始/结束/时长三个输入框改为下拉选择，粒度按音频时长自适应：
 *      ≤60s → 每 1s 一档；≤10min → 每 30s 一档；>10min → 每 60s 一档
 *   3. 保留：上传区、已上传列表下拉、播放/同步/预加载按钮、audio_file 隐藏 widget
 *   4. 时间状态存 _wwdmSel（{s,e}），经隐藏 widget start_time/end_time/duration 传后端
 *
 * v8.5 已回退（用户反馈波形面板和按钮消失）：DOM widget 高度自适应方案失败
 *
 * v8.4 修复（用户反馈）：更换输入音频后再点预加载，跳回第一次选择的音频
 *   根因：预加载把上游 LoadAudio 解析到的文件名写入了 audio_file widget，
 *   而解析源优先读 widget → widget 被固化旧音频。
 *   修复：解析源区分来源（_wwdmResolveSourceInfo 返回 fromUpload 标记）；
 *   仅节点内上传才写 audio_file widget，上游 LoadAudio 来源写空保持实时读取。
 *
 * v8.3 优化（用户需求）：同步/预加载功能分离
 *   1. 「🔄 同步」按钮只同步时间选择与手柄位置（不加载波形）
 *   2. 新增「⏬ 预加载」按钮：从输入端获取当前音频并刷新波形
 *
 * v8.2 修复（用户反馈）：同步按钮无法从输入的 AUDIO 加载波形
 *   根因：新版 ComfyUI 的 app.graph.links 是 Map（旧版是数组），
 *   _wwdmResolveSource 用 links.find() 直接 TypeError，同步中断。
 *   修复：兼容 Map（.get）与数组（.find）两种结构。
 *
 * v8.1 优化（用户反馈）：
 *   1. 输出只保留裁剪后的 audio 音频（去掉 start/end/duration/preview 输出）
 *   2. 修复结束手柄无法拖动：手柄命中判定改为纯像素距离（不依赖选区时间
 *      区间 isSel），避免结束手柄在音频末尾时鼠标落点在手柄右侧导致
 *      判定失败落入画布平移；拖动改为偏移量方式精确跟随指针
 *
 * v8 优化（用户需求）：
 *   1. 去掉节点上半部分的 start_time/end_time/duration 原生参数 widget
 *      （前端隐藏，视觉上消失）；保留波形下方的「开始时间/结束时间/选取时长」
 *      输入框 + audio_file 上传功能。隐藏 widget 仍序列化，执行时正常传参。
 *   2. 「🔄 同步」按钮功能改为：从输入的 audio 加载波形（优先节点内上传的
 *      audio_file，其次上游 LoadAudio 节点），同时同步开始时间、结束时间、
 *      选取时长和波形手柄位置。
 *
 * 架构（沿用 v4-v7）：
 *   上传 → /upload/image → 文件名存 hidden widget audio_file → 前端解码 → 下拉选时间
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el } from "../../../scripts/ui.js";

const NODE_TYPE = "WWDMAudioCrop";

// 插件版本号（每次更新递增；显示在节点头部，便于确认是否最新版）
const WWDM_VERSION = "v8.6.0";

function normalizeUrl(url) {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  return api.apiURL(url.replace(/^\/+/, ""));
}

// ---------- 时间格式工具（hh:mm:ss + 一位小数秒）----------
/** 解析 "hh:mm:ss.s" / "mm:ss.s" / "ss.s" / 纯数字秒 → 秒数；解析失败返回 null */
function parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s); // 纯秒
  const m = s.match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/); // hh:mm:ss(.s)
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10), ss = parseInt(m[3], 10);
    if (mm >= 60 || ss >= 60) return null;
    const frac = m[4] ? parseFloat("0." + m[4]) : 0;
    return hh * 3600 + mm * 60 + ss + frac;
  }
  const m2 = s.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d+))?$/); // mm:ss(.s)
  if (m2) {
    const mm = parseInt(m2[1], 10), ss = parseInt(m2[2], 10);
    if (ss >= 60) return null;
    const frac = m2[3] ? parseFloat("0." + m2[3]) : 0;
    return mm * 60 + ss + frac;
  }
  const f = parseFloat(s);
  return isFinite(f) && f >= 0 ? f : null;
}
/** 秒 → "hh:mm:ss.s"（秒始终保留 1 位小数） */
function fmtHMS(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t - h * 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  const ss = s.toFixed(1);
  const [ssi, ssf] = ss.split(".");
  return `${pad(h)}:${pad(m)}:${pad(ssi)}.${ssf}`;
}
/** 秒 → 保留 1 位小数的数字字符串（duration/选取时长用） */
function fmtSec1(t) {
  if (!isFinite(t) || t < 0) t = 0;
  return t.toFixed(1);
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
// 时间下拉选项生成（混合粒度：短音频细档 + 长音频粗档）
// =====================================================================
/** 根据音频时长生成时间档位列表（秒）。
 *  ≤60s → 每 1s 一档（细）
 *  ≤10min → 每 30s 一档（中）
 *  >10min → 每 60s 一档（粗）
 *  始终包含 0 与音频总时长（对齐到档位）。 */
function timeSteps(duration) {
  const dur = Math.max(0, duration || 0);
  const step = dur <= 60 ? 1 : dur <= 600 ? 30 : 60;
  const steps = [];
  for (let t = 0; t < dur; t += step) steps.push(t);
  steps.push(dur); // 总时长（对齐到档位的最后值）
  return steps;
}

/** 填充下拉框选项：时间为 hh:mm:ss.s 格式；value 存原始秒数。 */
function fillTimeSelect(sel, duration, current) {
  if (!sel) return;
  const steps = timeSteps(duration);
  const cur = current == null ? null : Number(current);
  sel.innerHTML = "";
  // 精确匹配优先，否则选最接近的档位（向下取整，避免超过当前值）
  let best = 0;
  let bestIdx = 0;
  for (const t of steps) {
    if (cur != null && Math.abs(t - cur) < 1e-6) bestIdx = steps.indexOf(t);
    else if (cur != null && t <= cur + 1e-6) { best = t; bestIdx = steps.indexOf(t); }
    const opt = document.createElement("option");
    opt.value = String(t);
    opt.textContent = fmtHMS(t);
    sel.appendChild(opt);
  }
  sel.selectedIndex = bestIdx;
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
          padding: "8px 8px",
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
          padding: "4px 6px",
          fontSize: "12px",
          boxSizing: "border-box",
          marginTop: "5px",
          display: "none",
        },
      });
      this.wwdmFileSelect.addEventListener("change", () => {
        const name = this.wwdmFileSelect.value;
        if (!name) return;
        this._wwdmLoadFile(name);
      });
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

      // ---------- 时间下拉行（v8.6：开始/结束/时长，混合粒度） ----------
      const selStyle = {
        width: "100%",
        background: "#0f1622",
        color: "#dde",
        border: "1px solid #2c3a4d",
        borderRadius: "4px",
        padding: "4px 6px",
        fontSize: "12px",
        boxSizing: "border-box",
        fontFamily: "monospace",
      };
      const mkSel = (label, ref) => {
        const sel = $el("select", { style: selStyle });
        const lab = $el("label", {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            fontSize: "11px",
            color: "#8fa0b8",
            flex: 1,
          },
        });
        lab.append(document.createTextNode(label), sel);
        this[ref] = sel;
        return lab;
      };
      const timeRow = $el("div", { style: { display: "flex", gap: "6px", marginTop: "6px" } });
      timeRow.append(
        mkSel("开始时间", "wwdmSelStart"),
        mkSel("结束时间", "wwdmSelEnd"),
        mkSel("选取时长", "wwdmSelDur")
      );

      // ---------- 按钮行（播放 + 同步 + 预加载） ----------
      const btnStyle = (bg) => ({
        background: bg,
        color: "#fff",
        border: "none",
        borderRadius: "5px",
        padding: "6px 12px",
        fontSize: "12px",
        cursor: "pointer",
        fontWeight: 600,
      });
      this.wwdmBtnPlay = $el("button", { textContent: "▶ 播放", style: btnStyle("#2e7d54") });
      this.wwdmBtnPlay.style.flex = "1";
      this.wwdmBtnSync = $el("button", { textContent: "🔄 同步", style: btnStyle("#3d5a80") });
      this.wwdmBtnPreload = $el("button", { textContent: "⏬ 预加载", style: btnStyle("#6a4fa3") });
      const hint = $el("div", {
        style: { fontSize: "10px", color: "#5c6a82", flex: "1.2", lineHeight: "16px", textAlign: "right" },
        textContent: "版本 " + WWDM_VERSION,
      });
      const btnRow = $el("div", { style: { display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" } });
      btnRow.append(this.wwdmBtnPlay, this.wwdmBtnSync, this.wwdmBtnPreload, hint);

      const wrap = $el("div", { style: { width: "100%", padding: "2px 0" } });
      wrap.append(uploadZone, this.wwdmFileSelect, this.wwdmFileName, timeRow, btnRow);
      this.wwdmUiEl = wrap;

      if (this.addDOMWidget) {
        this.wwdmWidget = this.addDOMWidget("wwdm_ui", "wwdm_ui", wrap, { serialize: false });
        // v8.6：无波形画布，内容更紧凑。固定高度（上传区34+下拉30+文件名16+时间行52+按钮行30+边距≈20 ≈ 182）
        this.wwdmWidget.computeSize = function (width) {
          return [width || 320, 185];
        };
      } else {
        const container = this.el || this.nodeEl || this.constructor?.nodeEl;
        if (container) container.appendChild(wrap);
      }

      // 节点高度覆盖（v8.6：无画布，内容紧凑）
      const origComputeSize = this.computeSize?.bind(this);
      this.computeSize = function (w) {
        const base = origComputeSize ? origComputeSize(w) : [360, 300];
        const needed = 240; // 上传区(34)+下拉(30)+文件名(16)+时间行(52)+按钮行(30)+边距(~78)
        return [base[0], Math.max(base[1], needed)];
      };

      // ---------- 隐藏原生 start_time/end_time/duration + audio_file 参数（v8） ----------
      // widget 仍留在 this.widgets 中，值会被序列化并随执行传给后端 crop()，保证功能不变。
      for (const nm of ["start_time", "end_time", "duration", "audio_file"]) {
        const w = this.widgets?.find((x) => x.name === nm);
        if (w) {
          w.hidden = true;
          w.computeSize = () => [0, -4];
        }
      }

      // ---------- 状态 ----------
      this._wwdmGuard = false;
      // v8.6：时间选区状态（不再有波形画布）
      this._wwdmSel = { s: 0, e: 0 };
      this._wwdmDuration = 0;
      this._wwdmAudioUrl = "";
      this._wwdmHasAudio = false;
      // ---------- 时间下拉事件（v8.6） ----------
      const applyFromDropdowns = () => {
        if (!this._wwdmHasAudio) return;
        const dur = this._wwdmDuration || 1;
        const sv = this.wwdmSelStart.value ? Number(this.wwdmSelStart.value) : 0;
        const ev = this.wwdmSelEnd.value ? Number(this.wwdmSelEnd.value) : dur;
        const dv = this.wwdmSelDur.value ? Number(this.wwdmSelDur.value) : 0;
        let s = Math.max(0, Math.min(sv, dur));
        let e;
        if (dv != null && dv > 0) {
          e = Math.min(dur, s + dv); // 时长优先
        } else {
          e = Math.min(dur, Math.max(ev, s + 0.01));
        }
        if (e <= s + 0.01) e = Math.min(dur, s + 0.01);
        this._setSel(s, e);
      };
      this.wwdmSelStart.addEventListener("change", applyFromDropdowns);
      this.wwdmSelEnd.addEventListener("change", applyFromDropdowns);
      this.wwdmSelDur.addEventListener("change", applyFromDropdowns);

      // ---------- 同步按钮（v8.3：只同步时间选择，不加载波形） ----------
      this.wwdmBtnSync.addEventListener("click", () => this._wwdmSyncAll());

      // ---------- 预加载按钮（v8.3：从输入端获取当前音频并刷新） ----------
      this.wwdmBtnPreload.addEventListener("click", () => this._wwdmPreload());

      // ---------- 播放按钮 ----------
      this.wwdmBtnPlay.addEventListener("click", () => {
        const url = this.wwdmAudioUrl || (this._wwdmCurrentName ? makeFileUrl(this._wwdmCurrentName) : "");
        if (!url) {
          alert("请先上传或选择音频文件");
          return;
        }
        if (!this._wwdmHasAudio) {
          alert("音频尚未加载，请先点「⏬ 预加载」或上传");
          return;
        }
        if (this._wwdmPlaying) {
          this._wwdmStopPlay();
        } else {
          this._wwdmPlaySelection(url);
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

      /** 加载已上传/已选择的音频文件（写入 widget + 解码获取时长 + 填充时间下拉） */
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
          const buffer = await decodeAudioBuffer(makeFileUrl(name));
          const duration = buffer.duration || (buffer.length / (buffer.sampleRate || 44100));
          this._wwdmDuration = duration;
          this._wwdmHasAudio = true;
          this._setSel(0, duration); // 全选并填充下拉
        } catch (err) {
          console.error("[wwdm] 音频解码失败", err);
          this.wwdmFileName.textContent = "❌ 音频解码失败: " + String(err.message || err);
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

    // ---------- 设置选区（v8.6：核心状态入口） ----------
    // 写 _wwdmSel、刷新三个时间下拉、写隐藏 widget（start_time/end_time/duration）
    nodeType.prototype._setSel = function (s, e) {
      const dur = this._wwdmDuration || 0;
      if (dur <= 0) return;
      s = Math.max(0, Math.min(s, dur));
      e = Math.max(s, Math.min(e, dur));
      this._wwdmSel = { s, e };
      // 刷新下拉（保持当前选择，若档位不同则就近对齐）
      fillTimeSelect(this.wwdmSelStart, dur, s);
      fillTimeSelect(this.wwdmSelEnd, dur, e);
      fillTimeSelect(this.wwdmSelDur, dur, e - s);
      this._wwdmSyncWidgets();
    };

    // ---------- 解析音频源（返回 {name, fromUpload}：fromUpload=true 表示节点内上传） ----------
    nodeType.prototype._wwdmResolveSourceInfo = function () {
      // 1) 节点内上传的 audio_file
      const wf = this.widgets?.find((x) => x.name === "audio_file");
      if (wf?.value && String(wf.value).trim()) {
        return { name: String(wf.value).trim(), fromUpload: true };
      }
      // 2) 上游 LoadAudio 节点的音频文件名
      //    注意：新版 ComfyUI 的 app.graph.links 是 Map（旧版是数组），需兼容两种结构
      const inp = this.inputs?.find((x) => x.name === "audio");
      if (inp?.link != null && app?.graph) {
        const links = app.graph.links;
        const link = Array.isArray(links)
          ? links.find((l) => l.id === inp.link)
          : links?.get?.(inp.link);
        const src = link ? app.graph.getNodeById(link.origin_id) : null;
        if (src) {
          // LoadAudio 的 audio 参数
          const aw = src.widgets?.find((x) => x.name === "audio");
          if (aw?.value && String(aw.value).trim()) {
            return { name: String(aw.value).trim(), fromUpload: false };
          }
          // 兼容：第一个 widget 恰好是文件名的场景
          const w0 = src.widgets?.[0];
          if (w0?.value && typeof w0.value === "string" && String(w0.value).trim()) {
            return { name: String(w0.value).trim(), fromUpload: false };
          }
        }
      }
      return null;
    };

    // ---------- 解析音频源（兼容旧调用：返回文件名或 null） ----------
    nodeType.prototype._wwdmResolveSource = function () {
      const info = this._wwdmResolveSourceInfo();
      return info ? info.name : null;
    };

    // ---------- 同步（v8.3：只同步时间选择，不加载音频） ----------
    // v8.6：从三个下拉读取开始/结束/时长，重算选区（时长优先）
    nodeType.prototype._wwdmSyncAll = function () {
      if (!this._wwdmHasAudio) {
        alert("音频尚未加载：请先点「⏬ 预加载」或上传音频");
        return;
      }
      const dur = this._wwdmDuration || 1;
      const sv = this.wwdmSelStart.value ? Number(this.wwdmSelStart.value) : 0;
      const ev = this.wwdmSelEnd.value ? Number(this.wwdmSelEnd.value) : dur;
      const dv = this.wwdmSelDur.value ? Number(this.wwdmSelDur.value) : 0;
      let s = Math.max(0, Math.min(sv, dur));
      let e;
      if (dv != null && dv > 0) {
        e = Math.min(dur, s + dv); // 时长优先
      } else {
        e = Math.min(dur, Math.max(ev, s + 0.01));
      }
      if (e <= s + 0.01) e = Math.min(dur, s + 0.01);
      this._setSel(s, e);
    };

    // ---------- 预加载（v8.4：从输入端获取当前音频，每次强制重新解码） ----------
    nodeType.prototype._wwdmPreload = async function () {
      const info = this._wwdmResolveSourceInfo();
      const name = info ? info.name : null;
      if (!name) {
        alert("未找到音频：请在节点内上传音频，或连接 LoadAudio 的 AUDIO 输入");
        return;
      }
      const url = makeFileUrl(name);
      try {
        const buffer = await decodeAudioBuffer(url);
        const duration = buffer.duration || (buffer.length / (buffer.sampleRate || 44100));
        // 更新来源展示（强制刷新：即使同名也刷新 UI，解决更换输入音频后点击无效）
        this._wwdmCurrentName = name;
        // 仅节点内上传才写入 audio_file widget；上游 LoadAudio 来源不写 widget，
        // 保持 widget 为空 → 下次解析仍读上游当前音频（否则会固化旧音频导致跳回第一次）
        const wf = this.widgets?.find((x) => x.name === "audio_file");
        if (info.fromUpload) {
          if (wf) wf.value = name;
        } else if (wf) {
          wf.value = "";
        }
        this.wwdmFileName.textContent = "已加载: " + name;
        this.wwdmAudioUrl = url;
        this._wwdmDuration = duration;
        this._wwdmHasAudio = true;
        const sel = this.wwdmFileSelect;
        if (sel && ![...sel.options].some((o) => o.value === name)) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
        if (sel) sel.value = name;
        // 新音频：选区重置为全选，并填充时间下拉
        this._setSel(0, duration);
      } catch (err) {
        console.error("[wwdm] 预加载失败", err);
        this.wwdmFileName.textContent = "❌ 音频加载失败: " + String(err.message || err);
        alert("音频加载失败: " + String(err.message || err));
      }
    };

    // ---------- 选区 → 隐藏 widget（start_time/end_time/duration）同步 ----------
    nodeType.prototype._wwdmSyncWidgets = function () {
      if (this._wwdmGuard) return;
      this._wwdmGuard = true;
      try {
        const { s, e } = this._wwdmSel || { s: 0, e: 0 };
        const dur = Math.max(0, e - s);
        const w = (name) => this.widgets?.find((x) => x.name === name);
        const ws = w("start_time"), we = w("end_time"), wd = w("duration");
        if (ws) ws.value = fmtHMS(s);
        if (we) we.value = fmtHMS(e);
        if (wd) wd.value = fmtSec1(dur);
      } finally {
        this._wwdmGuard = false;
      }
    };

    // ---------- 节点参数变化 → 下拉（反向联动，一般不会触发因为 widget 已隐藏） ----------
    const onWidgetChanged = nodeType.prototype.onWidgetChanged;
    nodeType.prototype.onWidgetChanged = function (widget, value) {
      const r = onWidgetChanged?.apply(this, arguments);
      if (this._wwdmGuard || !this._wwdmHasAudio) return r;
      if (widget?.name === "start_time") {
        const v = parseTime(value);
        if (v != null) {
          const e = Math.max(v + 0.01, this._wwdmSel.e);
          this._setSel(v, e);
        }
      } else if (widget?.name === "end_time") {
        const v = parseTime(value);
        if (v != null) {
          const s = Math.min(v - 0.01, this._wwdmSel.s);
          this._setSel(s, v);
        }
      } else if (widget?.name === "duration") {
        const v = parseTime(value);
        if (v != null) this._setSel(this._wwdmSel.s, this._wwdmSel.s + v);
      }
      return r;
    };

    // ---------- 执行结果（保留：读取后端返回的时长/URL，刷新时间下拉） ----------
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      const pick = (v) => (Array.isArray(v) ? v[0] : v);
      const audioUrl = pick(message?.wwdm_audio_url);
      const cropUrl = pick(message?.wwdm_crop_url);
      if (audioUrl) this.wwdmAudioUrl = audioUrl;
      if (cropUrl) this._wwdmCropUrl = cropUrl;
      // 保留用户已设置的时间参数：执行后下拉反映 start/end/duration 值
      const w = (name) => this.widgets?.find((x) => x.name === name);
      const sv = parseTime(w("start_time")?.value);
      const ev = parseTime(w("end_time")?.value);
      const dv = parseTime(w("duration")?.value);
      if (sv != null || ev != null || dv != null) {
        const dur = this._wwdmDuration || 1;
        let s = this._wwdmSel?.s ?? 0;
        let e = this._wwdmSel?.e ?? dur;
        if (sv != null && sv >= 0) s = Math.min(sv, dur);
        if (dv != null && dv > 0) e = Math.min(dur, s + dv);
        else if (ev != null && ev > 0) e = Math.min(dur, Math.max(ev, s + 0.01));
        this._setSel(s, e);
      }
      return r;
    };

    // ---------- 序列化保留（v8.6：无波形，无需恢复；保留钩子） ----------
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      return onConfigure?.apply(this, arguments);
    };

    // ---------- 播放（v8.6：用 <audio> 播放选区，无波形） ----------
    nodeType.prototype._wwdmPlaySelection = function (url) {
      if (!url || !this._wwdmHasAudio) return;
      this._wwdmStopPlay();
      const audio = new Audio(url);
      this._wwdmAudioEl = audio;
      this._wwdmPlaying = true;
      this.wwdmBtnPlay.textContent = "⏹ 停止";
      const { s, e } = this._wwdmSel || { s: 0, e: 0 };
      const startPlay = () => {
        try {
          audio.currentTime = Math.max(0, Math.min(s, this._wwdmDuration || 0));
        } catch (err) {}
        audio.play().catch(() => {});
      };
      if (audio.readyState >= 1) startPlay();
      else audio.addEventListener("loadedmetadata", startPlay, { once: true });
      audio.addEventListener("ended", () => this._wwdmStopPlay(), { once: true });
      audio.addEventListener("error", () => this._wwdmStopPlay(), { once: true });
      // 播放到结束时间自动停止
      const checkEnd = () => {
        if (!this._wwdmPlaying || !this._wwdmAudioEl) return;
        if (this._wwdmAudioEl.currentTime >= e) {
          this._wwdmStopPlay();
          return;
        }
        this._wwdmPlayRaf = requestAnimationFrame(checkEnd);
      };
      this._wwdmPlayRaf = requestAnimationFrame(checkEnd);
    };
    nodeType.prototype._wwdmStopPlay = function () {
      this._wwdmPlaying = false;
      if (this._wwdmPlayRaf) cancelAnimationFrame(this._wwdmPlayRaf);
      this._wwdmPlayRaf = null;
      if (this._wwdmAudioEl) {
        try {
          this._wwdmAudioEl.pause();
          this._wwdmAudioEl.removeAttribute("src");
        } catch (err) {}
        this._wwdmAudioEl = null;
      }
      if (this.wwdmBtnPlay) this.wwdmBtnPlay.textContent = "▶ 播放";
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
