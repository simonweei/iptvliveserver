import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist/admin', { recursive: true });
await cp('public', 'dist', { recursive: true });
let html = await readFile('public/index.html', 'utf8');
for (const asset of ['app.js', 'style.css']) {
  const version = createHash('sha256').update(await readFile(`public/${asset}`)).digest('hex').slice(0, 12);
  html = html.replace(`/${asset}"`, `/${asset}?v=${version}"`);
}
await writeFile('dist/index.html', html);
await writeFile('dist/admin/index.html', html);
await writeFile('dist/404.html', '<!doctype html><meta charset="utf-8"><title>页面不存在</title><p>页面不存在。<a href="/admin/">进入管理页面</a></p>');
console.log('已生成 dist，Pages Functions 从 functions/ 单独构建。');
