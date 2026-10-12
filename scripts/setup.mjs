import { writeFile, access } from 'node:fs/promises';
import { randomHex } from '../lib/auth.js';
try {
  let exists = false; try { await access('.env.local'); exists = true; } catch {}
  if (exists) throw new Error('.env.local 已存在。为避免覆盖现有配置，请先备份并移走该文件。');
  await writeFile('.env.local', `ADMIN_PASSWORD=\nSESSION_SECRET=${randomHex()}\nCRON_SECRET=${randomHex()}\n`, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env.local（已被 Git 忽略）。请编辑 ADMIN_PASSWORD（至少 6 个字符）。使用 dev:cf 时复制为 .dev.vars；线上在 Cloudflare Pages 配置同名 Secrets。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
