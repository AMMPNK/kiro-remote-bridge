'use strict';
/**
 * 解析 Kiro 的会话配置项（configOptions）。
 *
 * 单独成模块是为了可测：extension.js 依赖 vscode，没法在 node 里直接跑。
 *
 * 数据来源有两处，结构相同：
 *   - `_kiro/config/template` 的返回
 *   - `session/new` 的返回（新建会话时自带，不必再查一次 template）
 *
 * 实测结构：
 *   configOptions: [
 *     { type:"select", id:"mode", name:"Mode", category:"mode", currentValue:"vibe",
 *       options:[ { value:"vibe", name:"Default", description:"…",
 *                   _meta:{ kiro:{ source:"bundled" } } }, … ] },
 *     { id:"model",  currentValue:"auto", options:[ …19 项，_meta.kiro.rateMultiplier … ] },
 *     { id:"autopilot", currentValue:"on",
 *       options:[ {value:"on",name:"Autopilot"}, {value:"off",name:"Supervised"} ] },
 *     { id:"contentCollection", … }
 *   ]
 *
 * 两个踩过的坑，写在这里免得再犯：
 *   1. 顶层 `modes` 不是数组，而是 { availableModes, currentModeId }。
 *      用 Array.isArray 去判断会静默得到空清单 —— 可用清单在 configOptions 里。
 *   2. 必须按 `id` 匹配，不能按 `name`。name 是展示用的（"Content Collection" 带空格），
 *      早先按 name 做宽松匹配，把模式名和配置项名混成了一堆全塞进"模型"。
 */

/** 需要暴露给前端的配置项，其余（如 contentCollection）不在新建流程里改 */
const EXPOSED = ['mode', 'model', 'autopilot'];

/**
 * @param {unknown} configOptions
 * @returns {{[k:string]: {items: Array<{id:string,label:string,desc?:string,rate?:number}>,
 *                        current?: string}}}
 */
function parseConfigOptions(configOptions) {
  const byId = new Map();
  for (const o of Array.isArray(configOptions) ? configOptions : []) {
    if (o && o.id !== undefined && o.id !== null) byId.set(String(o.id), o);
  }

  const take = (id) => {
    const o = byId.get(id);
    if (!o) return { items: [], current: undefined };
    const items = [];
    for (const x of Array.isArray(o.options) ? o.options : []) {
      if (!x || typeof x !== 'object') {
        // 少见但要兜住：候选值直接是字符串
        if (typeof x === 'string' && x) items.push({ id: x, label: x });
        continue;
      }
      const value = x.value !== undefined ? x.value : x.id;
      if (value === undefined || value === null || value === '') continue;
      const kiro = (x._meta && x._meta.kiro) || {};
      const entry = { id: String(value), label: String(x.name || value) };
      if (x.description) entry.desc = String(x.description);
      if (typeof kiro.rateMultiplier === 'number') entry.rate = kiro.rateMultiplier;
      items.push(entry);
    }
    return {
      items,
      current: o.currentValue !== undefined && o.currentValue !== null
        ? String(o.currentValue)
        : undefined,
    };
  };

  const out = {};
  for (const id of EXPOSED) out[id] = take(id);
  return out;
}

module.exports = { parseConfigOptions, EXPOSED };
