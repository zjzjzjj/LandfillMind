/**
 * LandfillMind · 管理员认证中间件（L · 生产安全）
 *
 * 用法：
 *   - 设置环境变量 ADMIN_TOKEN（生产必填；开发模式自动生成一个默认值）
 *   - 前端访问 /admin 时，会要求输入此 token（sessionStorage 保存）
 *   - 受保护的端点：/api/feedback/distill（写）、/api/ab/*（写）、/api/admin/*
 *
 * 注意：这是一个简单的 token 认证，**不是**完整的 OAuth/JWT。
 * 生产环境若需要更严格的安全，请替换为成熟的认证方案。
 */

import type { Request, Response, NextFunction } from 'express';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || generateDevToken();

function generateDevToken(): string {
  // 开发模式：使用固定可预测的 token（避免每次重启变化）
  const dev = 'landfillmind-dev-2026';
  if (!process.env.ADMIN_TOKEN) {
    console.log(`[admin-auth] ⚠️  ADMIN_TOKEN 未设置，使用开发默认值：${dev}`);
  }
  return dev;
}

export function getAdminToken(): string {
  return ADMIN_TOKEN;
}

/**
 * Express middleware：校验 X-Admin-Token 请求头
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('X-Admin-Token') ?? req.query.token;
  if (!token || token !== ADMIN_TOKEN) {
    res.status(401).json({
      ok: false,
      error: 'admin auth required',
      hint: '请在请求头加 X-Admin-Token: <token>',
    });
    return;
  }
  next();
}

/**
 * 公开检查（无需 token）— 用于前端判断是否需要登录
 */
export function getAdminAuthStatus(): { enabled: boolean; hint?: string } {
  return {
    enabled: !!process.env.ADMIN_TOKEN,
    hint: process.env.ADMIN_TOKEN
      ? undefined
      : '当前使用开发默认值 token；生产部署请设置 ADMIN_TOKEN 环境变量',
  };
}