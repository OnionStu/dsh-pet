/**
 * 表情包池（host 半侧）：把配置顶层 memes 映射（名称 → 描述）解析成可用的候选池。
 *
 * 设计：
 * - memes 是「键 = assets/memes/<键>.png，值 = 该图内容描述」，碎碎念/对话共用同一张表；
 * - 只认**磁盘上真实存在**的图片：配置里写了但文件缺失的条目静默剔除（不告警刷屏，
 *   用户删图后不必同步改配置）；文件在但配置没写的图不参与（无从得知它的描述）；
 * - 纯函数 + 目录参数，便于测试（不碰全局状态）。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 表情包根目录（包内 assets/memes） */
export const MEMES_DIR = 'memes';

/** 池中一张图：name = 配置键（= 文件名去扩展名），desc = 给模型看的描述 */
export interface MemeEntry {
  name: string;
  desc: string;
}

/**
 * 从配置的 memes 映射解析出候选池。
 * @param memes 配置顶层 memes 值（未配置/类型非法 → 空池）
 * @param assetsRoot 包内 assets 目录绝对路径
 * @returns 名称升序的候选池（文件缺失或描述为空的条目被剔除）
 */
export function readMemePool(memes: unknown, assetsRoot: string): MemeEntry[] {
  if (!memes || typeof memes !== 'object' || Array.isArray(memes)) return [];
  const dir = join(assetsRoot, MEMES_DIR);
  const out: MemeEntry[] = [];
  for (const [name, desc] of Object.entries(memes as Record<string, unknown>)) {
    const text = typeof desc === 'string' ? desc.trim() : '';
    if (!name || !text) continue;
    if (!existsSync(join(dir, name + '.png'))) continue;
    out.push({ name, desc: text });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 抽一张图（均匀随机）；空池返回 undefined */
export function pickMeme(pool: MemeEntry[], random: () => number = Math.random): MemeEntry | undefined {
  if (pool.length === 0) return undefined;
  const idx = Math.floor(random() * pool.length) % pool.length;
  return pool[idx];
}

/** 模型选图校验：只在池内命中时才认（防幻觉出池外名称）；命中返回该条目，否则 undefined */
export function matchMeme(pool: MemeEntry[], name: string): MemeEntry | undefined {
  const key = String(name ?? '').trim();
  return key ? pool.find((m) => m.name === key) : undefined;
}
