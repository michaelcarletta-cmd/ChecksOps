# Least-privilege IAM to delete leftover restore role

Lambda `checksops-staging-restore-oneshot` is already gone (`ResourceNotFoundException`).

Role `checksops-staging-restore-oneshot` still exists and still has access to the RDS admin secret and the one backup object. `iam:DeleteRole` returns `DeleteConflict: must delete policies first`. This operator can `iam:GetRole` but cannot list or delete that role's policies.

Principal to add these statements to: `arn:aws:iam::806168576068:role/ChecksOpsCursorCloudStaging`.

Do **not** grant `iam:*`, `Resource: *`, or role-management on any other role.

## Required (inline policies — this is the current blocker)

`DeleteRole` failed with the inline-policy conflict message. Grant these on **only** this role:

```
Action:    iam:ListRolePolicies
Resource:  arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot

Action:    iam:GetRolePolicy
Resource:  arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot

Action:    iam:DeleteRolePolicy
Resource:  arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot

Action:    iam:DeleteRole
Resource:  arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot
```

`GetRolePolicy` is included so the inline policy name can be confirmed before delete. `ListRolePolicies` is required; brute-force `GetRolePolicy` of common names returned `NoSuchEntity`.

## Include if required after inline policies are gone (managed policies)

If `DeleteRole` then says policies must be detached, also grant **only** on this role:

```
Action:    iam:ListAttachedRolePolicies
Resource:  arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot

Action:    iam:DetachRolePolicy
Resource:  arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot
```

`DetachRolePolicy` scoped to this role cannot detach policies from any other role. Do not add `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, or `iam:UpdateAssumeRolePolicy`.

## Example identity-policy fragment (this role only)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CleanupRestoreOneshotInlinePoliciesOnly",
      "Effect": "Allow",
      "Action": [
        "iam:ListRolePolicies",
        "iam:GetRolePolicy",
        "iam:DeleteRolePolicy"
      ],
      "Resource": "arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot"
    },
    {
      "Sid": "CleanupRestoreOneshotManagedPoliciesIfPresent",
      "Effect": "Allow",
      "Action": [
        "iam:ListAttachedRolePolicies",
        "iam:DetachRolePolicy"
      ],
      "Resource": "arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot"
    },
    {
      "Sid": "DeleteRestoreOneshotRoleOnly",
      "Effect": "Allow",
      "Action": "iam:DeleteRole",
      "Resource": "arn:aws:iam::806168576068:role/checksops-staging-restore-oneshot"
    }
  ]
}
```

After this is attached, a later pass can list the inline policy name, delete it, detach any managed policies, and delete the role. No other IAM roles should be in scope.

## Completed 2026-09-02

Inline policy `oneshot-restore-least-privilege` deleted. No managed policies were attached. Role deleted (`NoSuchEntity`). Lambda still absent.
