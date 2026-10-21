'use strict';
/** 临时工具：校验 index.html 里的内联 JS 语法 + DOM id 引用完整性 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const file = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.log('❌ 没找到 <script> 段');
  process.exit(1);
}

const tmp = path.join(__dirname, '_tmp-ui.js');
fs.writeFileSync(tmp, m[1], 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('✅ 前端内联 JS 语法 OK（' + m[1].length + ' 字符）');
} catch (e) {
  console.log('❌ 前端 JS 语法错误：\n' + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
} finally {
  fs.unlinkSync(tmp);
}

// DOM id 引用检查
const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((x) => x[1]));
const used = new Set([...html.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((x) => x[1]));
const missing = [...used].filter((x) => !ids.has(x));
console.log(`   HTML 定义 id ${ids.size} 个，JS 引用 ${used.size} 个`);
console.log(missing.length ? `❌ 引用了但不存在的 id：${missing.join(', ')}` : '✅ 所有 $() 引用的元素都存在');

// 反向：定义了但没用到的（仅提示）
const unused = [...ids].filter((x) => !used.has(x) && !html.includes(`"${x}"`));
if (unused.length) console.log(`   （提示：未被 JS 用到的 id：${unused.join(', ')}）`);

process.exit(missing.length ? 1 : 0);
