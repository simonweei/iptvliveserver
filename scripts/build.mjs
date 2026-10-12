import { mkdir, cp, writeFile } from 'node:fs/promises';
await mkdir('dist/admin', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('public/index.html', 'dist/admin/index.html');
await writeFile('dist/404.html', '<!doctype html><meta charset="utf-8"><title>页面不存在</title><p>页面不存在。<a href="/admin/">进入管理页面</a></p>');
console.log('已生成 dist，Pages Functions 从 functions/ 单独构建。');
