// 用真实的 _kiro/config/template 返回验证配置项解析。
// fixture 取自实机探测（test/fixtures/config-template.json）。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { parseConfigOptions } = require('./src/presets.js');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const tpl = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'config-template.json'), 'utf8'));

// 回归点：顶层 modes 是对象而不是数组，早先按数组解析会静默得到空清单
check('fixture 的顶层 modes 确实不是数组（这正是当初的坑）',
  !Array.isArray(tpl.modes) && typeof tpl.modes === 'object',
  `键: ${Object.keys(tpl.modes || {}).join(',')}`);

const p = parseConfigOptions(tpl.configOptions);

check('解析出模式清单', p.mode.items.length === 7, `${p.mode.items.length} 项`);
check('模式默认值为 vibe', p.mode.current === 'vibe', String(p.mode.current));
check('模式含 Default/Spec/Bug Fix',
  ['vibe', 'spec', 'bug-fix'].every((id) => p.mode.items.some((x) => x.id === id)),
  p.mode.items.map((x) => x.id).join(','));
check('模式项带展示名',
  p.mode.items.find((x) => x.id === 'vibe')?.label === 'Default');

check('解析出模型清单', p.model.items.length === 19, `${p.model.items.length} 项`);
check('模型默认值为 auto', p.model.current === 'auto', String(p.model.current));
check('模型含 auto 与 claude-opus-5',
  ['auto', 'claude-opus-5'].every((id) => p.model.items.some((x) => x.id === id)));
check('模型带倍率与描述', (() => {
  const m = p.model.items.find((x) => x.id === 'claude-opus-5');
  return m && typeof m.rate === 'number' && !!m.desc;
})(), (() => {
  const m = p.model.items.find((x) => x.id === 'claude-opus-5');
  return m ? `${m.label} rate=${m.rate}` : '(未找到)';
})());

check('解析出执行方式', p.autopilot.items.length === 2, `${p.autopilot.items.length} 项`);
check('执行方式为 on/off 且展示名是 Autopilot/Supervised',
  p.autopilot.items.map((x) => `${x.id}=${x.label}`).join(',') === 'on=Autopilot,off=Supervised',
  p.autopilot.items.map((x) => `${x.id}=${x.label}`).join(','));
check('执行方式默认 on', p.autopilot.current === 'on');

// contentCollection 是隐私设置，不该出现在新建流程里
check('不暴露 contentCollection', p.contentCollection === undefined);

// 容错
check('空输入不抛异常', (() => {
  for (const bad of [undefined, null, [], {}, 'x', 42, [null], [{ id: 'mode' }]]) {
    const r = parseConfigOptions(bad);
    if (!r || !r.mode || !Array.isArray(r.mode.items)) return false;
  }
  return true;
})());

check('候选值是字符串数组时也能解析', (() => {
  const r = parseConfigOptions([{ id: 'mode', options: ['a', 'b'] }]);
  return r.mode.items.length === 2 && r.mode.items[0].id === 'a';
})());

check('按 id 匹配而非 name', (() => {
  // name 故意写成误导值，仍应按 id 取到
  const r = parseConfigOptions([
    { id: 'model', name: 'Mode', currentValue: 'x', options: [{ value: 'x', name: 'X' }] },
  ]);
  return r.model.items.length === 1 && r.mode.items.length === 0;
})());

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
