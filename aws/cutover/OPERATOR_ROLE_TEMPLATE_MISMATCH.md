# Failed stack used the old five-inline template

**STOP FOR REVIEW.** Do not deploy. Do not start #2–#6.

Inspected live stack `checksops-cursor-security-hardening-role` in
`us-east-1` on 2026-09-07 (status `ROLLBACK_COMPLETE`).

## 1. What template AWS actually received

`cloudformation get-template` body is **26,490** bytes, SHA-256
`fa654d370364f6780a8a503905e76c3acc8669fa1e288a376645e1a3ec9cfff6`.

That is a **byte-for-byte match** of Git commit `483adcec`
`aws/production/cursor-security-hardening-role.yaml` (the five-inline
split). It is **not** the current GitHub/HEAD file (commit `5e07501f`,
25,955 bytes, SHA-256
`ec3a9a7440fee6d3db6e7c7168261304f7d807901ed220c54926516fe1be9cd8`).

Stack `Description` stored by AWS:

`Split into five inline policies so each is under the IAM 10240-character
role-policy limit.`

Current HEAD description instead begins:

`Customer-managed policies (not role inline) because IAM enforces a
10240-byte AGGREGATE inline-policy quota per role.`

Create time: `2026-09-07T16:11:02Z`. Only resource attempted:
`ChecksOpsCursorSecurityHardeningTemp` (`AWS::IAM::Role`). No
`AWS::IAM::ManagedPolicy` resources appear in the received template.

## 2. Does `Properties.Policies` exist?

**Yes** on the role AWS received.

Five inline policies:

| PolicyName | Compact chars |
|---|---:|
| HardeningAllowCfnSns | 1887 |
| HardeningAllowConfigPosture | 1984 |
| HardeningAllowFlowAlarms | 2230 |
| HardeningAllowReadonly | 1681 |
| HardeningDenyGuardrails | 4945 |
| **Aggregate** | **12727** |

12727 > 10240 → `PutRolePolicy` / role create `ServiceLimitExceeded`.

Current HEAD role properties: `Policies` is **absent**.

## 3. Does `ManagedPolicyArns` reference all six managed policies?

**No** on the template AWS received. `ManagedPolicyArns` is **absent**.
Resources in the received template: only
`ChecksOpsCursorSecurityHardeningTemp`.

Current HEAD role `ManagedPolicyArns` refs all six:

- `AllowCfnSnsPolicy`
- `AllowConfigPosturePolicy`
- `AllowFlowAlarmsPolicy`
- `AllowReadonlyPolicy`
- `DenyFinancialAppPolicy`
- `DenyIamInfraPolicy`

## 4. Exact root cause

The third create uploaded the **previous** CloudFormation file (five
inline policies on the role). IAM’s 10,240 limit is the **aggregate
inline** quota. Combined compact size 12,727 exceeded it. This is not a
failure of the current managed-policy architecture; that file was not
what CloudFormation ran.

## 5. Exact correction required

No further policy-content redesign. Operational steps only (do not do
them until review):

1. Delete stack `checksops-cursor-security-hardening-role` (now
   `ROLLBACK_COMPLETE`; same name cannot be recreated until deleted).
2. Upload **only** the current GitHub file
   `aws/production/cursor-security-hardening-role.yaml` from commit
   `5e07501f` or later (branch
   `cursor/operator-security-services-9053`).
3. Before submit, confirm the Console template preview shows:
   - six `AWS::IAM::ManagedPolicy` resources
   - role property `ManagedPolicyArns` with six `!Ref`s
   - **no** role property `Policies`
   - description containing `Customer-managed policies (not role inline)`
4. Then create with `CAPABILITY_NAMED_IAM`. Do not start #2–#6 until
   `CREATE_COMPLETE` and `GetCallerIdentity` is
   `ChecksOpsCursorSecurityHardeningTemp`.

Do not edit `ChecksOpsCursorCloudStaging`. Do not attach the combined
permissions JSON as an inline policy.
