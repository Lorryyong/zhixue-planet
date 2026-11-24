-- 2026-11-24 安全修复：轮换内置管理员口令 + 登录防爆破
-- 背景：旧口令为弱口令且其哈希/明文曾出现在公开仓库中，必须视为已泄露。
-- 新口令为 20 位随机口令，存储格式 scrypt$<saltHex>$<hashHex>（加盐慢哈希），口令本身不入库、不进仓库。

-- 1) 登录失败计数与锁定列（adminAuth 登录防爆破用）
ALTER TABLE zx_admin_accounts ADD COLUMN IF NOT EXISTS fail_count   INT DEFAULT 0;
ALTER TABLE zx_admin_accounts ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- 2) 轮换 builtin 账号口令（同时清零失败计数与锁定）
UPDATE zx_admin_accounts
SET password_hash = 'scrypt$f1be22123ea61a0ed1c7dd30493e965e$6dd625144c879aeed5a87bdba34ed649cf8f168055e88ce46d68e3a293724c903d34bc1616c37265846773e580d48db704eedaeb4fb82b46a8df4833fd31508a',
    fail_count = 0,
    locked_until = NULL
WHERE builtin = true;
