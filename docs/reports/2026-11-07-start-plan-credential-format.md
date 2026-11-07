# Start Plan Credential Format Compatibility

> Status: RESEARCH
> Last updated: 2026-11-07
> Last verified: 2026-11-07
> Verified against: ZCode CLI `0.17.1` installed bundle and Preview candidate based on `3ac67514`

## 结论

`oauth:bigmodel:user_info` 在官方 `credentials.json` 中不是可直接解析的
plain JSON object。它是官方 credential store 的 `enc:v1:` AES-256-GCM
密文；解密后的明文再由官方写入者保存为 JSON object。

因此此前真实 E2E 在 `START_PLAN_CREDENTIAL_DISCOVERY` 失败的直接原因是：

1. Bridge 直接读取了加密后的 credential value。
2. Bridge 只接受 object，未按官方 credential store 合同解密。
3. `user_info` 因此被判定为无效，`readOfficialStartPlanCredential()` 返回
   `null`，后续 Billing、Provider 和模型请求均未开始。

这不是 JWT、Device ID 或账户数据缺失。

## 官方合同

对已安装的 ZCode CLI `0.17.1` 只读检查得到：

- credential record 的顶层必须是 object。
- credential record 的每个 value 必须是 string。
- 新写入值使用 `enc:v1:<iv>.<auth-tag>.<ciphertext>` 封装。
- 加密算法为 AES-256-GCM。
- IV 为 12 bytes，authentication tag 为 16 bytes，三段均为 base64url。
- 密钥为 `SHA-256(secret)`。
- secret 优先取非空 `ZCODE_CREDENTIAL_SECRET`；否则使用官方 fallback：
  `zcode-credential-fallback:<platform>:<homedir>:<username>`。
- 官方读取路径对非 `enc:v1:` 值保留 plaintext 兼容。

`oauth:bigmodel:user_info` 解密后的 JSON 结构：

```text
{
  id: string,
  username: string,
  displayName: string,
  rawProfile: {
    avatar: string,
    email: string,
    name: string,
    user_id: string,
    zcodeProfileSchemaVersion: number
  }
}
```

`zcodejwttoken` 同样通过官方 credential store 加密；解密后为三段非空 JWT。

## 本机结构核验

只在进程内存中读取并解密真实官方文件，没有输出、复制、上传或归档任何
JWT、Device ID、Cookie、邮箱、账户 ID 或用户资料值。核验结果仅记录：

- `oauth:bigmodel:user_info`: string
- 外层格式: `enc:v1:`
- AES-GCM IV: 12 bytes
- authentication tag: 16 bytes
- 解密与 JSON parse: PASS
- 解密后根类型: object
- 必需身份字段 `id`: present
- JWT: string、`enc:v1:`、解密成功、三段非空
- 持久 `deviceMid`: present

## 最小修复

修改 `src/runtime/start-plan-production-auth.ts`：

- 增加官方 credential value 的 `enc:v1:` 解密支持。
- 保持旧 object fixture/兼容格式。
- 保持 plaintext JSON string 兼容，与官方 store 的 plaintext passthrough
  行为一致。
- JWT 和 `user_info` 均先经过同一 credential value 解码。
- 继续沿用既有账户字段优先级：
  `id`、`user_id`、`account_id`、`email`。
- 不从 JWT claim 推导账户身份。
- JWT payload 无法解析时 fail-closed。
- 密钥派生或认证标签失败时不记录原始值，直接 fail-closed。
- 未修改 Billing、Provider、HANDLE、Private Lease、SQLite 或 Worker
  生命周期逻辑。

## 回归测试

`test/start-plan-production-auth.test.ts` 新增脱敏合成 fixture，覆盖：

1. 官方 `enc:v1:` 字符串格式成功。
2. 原 object 格式继续成功。
3. malformed envelope、非 JSON string、错误密钥拒绝。
4. 缺少可验证账户身份拒绝。
5. JWT payload 无效拒绝。
6. JWT 过期拒绝。
7. 构造后账户身份切换拒绝且 Billing 调用为 0。
8. Device ID 缺失拒绝。
9. 凭据失败时 Auth Issuer 不构造且 Billing 调用为 0。
10. Coding Plan callback 行为不变。

验证结果：

- 定向测试：14/14 PASS。
- `npm run test:affected`：因新增源码/测试尚未登记影响映射，按规范回退
  `FULL_SUITE`，不是跳过。
- 完整隔离回归：891 tests，889 pass，2 skip，0 fail。
- B3-05 已实际运行。
- typecheck、build、plugin validation、`git diff --check`：PASS。

## 本机凭据发现

修复候选直接读取真实官方 credential record，结果为：

```yaml
credential_found: true
account_present: true
jwt_present: true
jwt_expiry_present: false
device_mid_present: true
```

该验证只证明官方凭据发现成功，不代表 Start Plan E2E 通过。没有发起
OAuth、Billing、Claim、Provider 注册或模型请求。

## 状态

```yaml
STATUS: PASS
OFFICIAL_USER_INFO_FORMAT: CONFIRMED
ROOT_CAUSE: Bridge read the official AES-256-GCM credential envelope as a plain credential record
PARSER_COMPATIBILITY: PASS
OBJECT_FORMAT_REGRESSION: PASS
NEGATIVE_CASES: PASS
LOCAL_CREDENTIAL_DISCOVERY: PASS
BILLING_REQUESTS: 0
MODEL_REQUESTS: 0
CODING_PLAN_REGRESSION: PASS
PRODUCTION_DB_MODIFIED: NO
PRODUCTION_CREDENTIALS_MODIFIED: NO
READY_FOR_PREVIEW_PR: YES
```
