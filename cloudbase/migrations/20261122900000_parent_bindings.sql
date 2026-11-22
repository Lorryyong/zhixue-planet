-- 家长绑定关系：学生 openid 与家长 openid 通过 6 位绑定码关联（云端权威）
-- 学生端绑定后生成 code；家长端用自己的微信登录、输入 code 认领，即可查看孩子周报。
create table if not exists zx_parent_bindings (
  id text primary key,
  student_openid text not null unique,
  parent_openid text,
  code text,
  guardian text not null default '',
  relation text not null default '妈妈',
  phone text not null default '',
  weekly boolean not null default false,
  weekly_day text not null default '周日',
  bound_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_zx_parent_bindings_code on zx_parent_bindings(code);
create index if not exists idx_zx_parent_bindings_parent on zx_parent_bindings(parent_openid);
