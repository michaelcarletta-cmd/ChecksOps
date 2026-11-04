# Plan: shrink the shared NAT gateway to the two AZs that use it

Owner, 2026-11-04: "do the NAT design note" (after asking how to make AWS cost effective).

This note changes nothing by itself. It records the live state and proposes one change. Each step
below runs only on the owner's go phrase for that step. No guarded workflow covers NAT gateways, so
each phrase is an explicit exception for that one step, as for
`ops/security/AWS_ACCOUNT_HARDENING_2026_11.md` and `ops/security/RDS_PRIVATE_SUBNETS_PLAN_2026_11.md`.

## Why

NAT `nat-15f538197c4a75331` (Name `checksops-staging-nat`) is a **regional** NAT gateway in
automatic mode. A regional NAT gateway is billed per hour **for each Availability Zone it is active
in** ([Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/)). It is active in four AZs, but only
two of them carry traffic, and nothing that routes through it runs in the other two.

| | today (4 AZs) | proposed (2 AZs) |
|---|---|---|
| NAT hours, 730 h × $0.045 per AZ-hour | $131.40 | $65.70 |
| Public IPv4, $0.005/h per address | $14.60 (4) | $7.30 (2), after step 2 releases the other two |
| Data processing, ~5.5 GB / 30 days × $0.045 | ~$0.25 | ~$0.25 |
| **Estimated monthly** | **~$146** | **~$80 after step 1, ~$73 after step 2** |

An Elastic IP is billed whether or not it is attached, so the 1b and 1c addresses keep costing
$3.65/month each from step 1 until step 2 releases them.

These are list-price estimates (us-east-1). They are not from the bill: the `claude-code` IAM user
has no `ce:GetCostAndUsage` or `pricing:GetProducts`. The owner can confirm the per-AZ charge in
Cost Explorer (usage type `NatGateway-Hours` or the regional NAT equivalent) before step 1.

## Live state (read-only, 2026-11-04, boto3 as `user/claude-code` through the session proxy)

**Created outside any stack.** CloudTrail: `CreateNatGateway` by `root` from the console,
2026-09-03 19:11:19 UTC, `AvailabilityMode: regional`, VPC `vpc-09f2268778966ce97`, then
`CreateRoute` 0.0.0.0/0 → this NAT on `rtb-057702ecbb292845f` at 19:15:02. CloudFormation reports no
stack containing it. The `checksops-staging` stack's own NAT (`StagingNatGateway`, condition
`CreateStagingNat`) is not created: the stack has `PublicSubnetId=''` and `PrivateRouteTableId=''`.

**Settings:** `AvailabilityMode regional`, `AutoProvisionZones enabled`, `AutoScalingIps enabled`,
connectivity public, its own route table `rtb-0e89e36b0cdca5c17` (0.0.0.0/0 → `igw-07fb541358a89fe21`).

| AZ | NAT address (allocation) | NAT bytes, last 30 days (out / in) | network interfaces in the AZ |
|---|---|---|---|
| us-east-1a | `184.193.58.15` (`eipalloc-00522d181fe59bb1d`) | 0.106 GB / 5.205 GB | 10: `checksops-staging-api`, `checksops-production-prep-api`, `checksops-p5c-sql-oneshot` (4), RDS, both Secrets Manager endpoints, 1 other |
| us-east-1f | `54.198.228.212` (`eipalloc-06781d2314441cec9`) | 0.088 GB / 0.088 GB | 10: `checksops-production-prep-api`, `checksops-p5c-sql-oneshot` (4), RDS (2), both Secrets Manager endpoints, `checksops-cursor-moov-monitor-temp` |
| us-east-1b | `13.219.134.91` (`eipalloc-001bd1b5e1c454c13`) | 0 / 0 | 1: Cognito endpoint `vpce-01e64f35c26956533` |
| us-east-1c | `100.61.101.135` (`eipalloc-0facc2a9a85845505`) | 0 / 0 | 1: Cognito endpoint `vpce-01e64f35c26956533` |

Metrics are `AWS/NATGateway` `BytesOutToDestination` / `BytesInFromDestination`, dimensions
`NatGatewayId` + `AvailabilityZone`, daily sums over 31 data points.

Why 1b and 1c: in automatic mode the gateway expands to any AZ where it detects a network interface
([regional NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html)).
The only interfaces in 1b and 1c belong to the staging Cognito endpoint (`checksops-staging-cognito-idp`,
`Purpose jwks-privatelink`), whose subnets route to the internet gateway, not to this NAT.

**Who uses it.** The only route to this NAT is `checksops-staging-lambda-private`
(`rtb-057702ecbb292845f`), associated with `subnet-0df2518070c5b9ff0` (1a) and
`subnet-092e4e41821fba6c4` (1f). Every VPC Lambda runs only in those two subnets:
`checksops-staging-api`, `checksops-staging-guarded-sql-executor`, `checksops-staging-rehearsal-oneshot`
and **`checksops-production-prep-api`**. Despite its name, this NAT is the internet egress path for
the production API. Any change to it is a production change.

**Also seen:** Elastic IP `100.50.171.44` (`eipalloc-01f1f9b72ac281ce9`, no tags) is attached to
nothing (~$3.65/month). Out of scope here; its own go phrase if wanted.

## Proposal

**Switch the NAT to manual AZ mode, keeping 1a and 1f with their current addresses, and drop 1b
and 1c.**

- No route change: `rtb-057702ecbb292845f` keeps pointing at the same NAT id.
- No egress IP change for any workload: the Lambdas run only in 1a and 1f, and those keep
  `184.193.58.15` and `54.198.228.212`. 1b and 1c have carried zero bytes for 30 days.
- In manual mode the gateway serves only the listed AZs and stops expanding, so every AZ with a
  private subnet routed through it must be listed. Today that is exactly 1a and 1f.
- A future Lambda subnet in another AZ would then need its AZ added explicitly
  (`associate-nat-gateway-address --availability-zone ...`). Record that in the Lambda
  subnet procedure when it changes.

### Alternatives considered

- **Move the Cognito endpoint's interfaces from 1b/1c into 1a/1f** and leave automatic mode on.
  It should contract by itself, but the endpoint has private DNS on, so the production API's
  Cognito JWKS calls may use it too. It changes a second shared resource, and the next interface
  anyone creates in another AZ silently brings the cost back. Not preferred.
- **Replace it with one zonal NAT in a public subnet** (~$33 + 1 address). Cheapest, but it
  needs a new NAT, a `ReplaceRoute` cutover with dropped connections, new egress IPs, and it makes
  the production API's egress depend on a single AZ. Not preferred while production shares it.
- **Bring it under the `checksops-staging` template.** Wrong home: production depends on it. If it
  is brought under IaC, it belongs in a stack of its own, as a separate reviewed change.

## Open questions for the owner (before step 1)

1. **Partner IP allowlists.** Does any provider (Moov, CheckAlt, a bank, Resend) allowlist our
   egress IPs? The repository has no record of one. If one lists `13.219.134.91` or
   `100.61.101.135`, it can be removed from their list after this change, since no traffic leaves
   from them.
2. **Can the mode be changed in place?** The AWS docs describe manual mode and removing addresses,
   but Claude did not confirm that an existing automatic-mode regional NAT can be switched to
   manual without recreating it. Step 1 reads the current documentation and the CLI reference
   (`aws ec2 modify-nat-gateway help`, `disassociate-nat-gateway-address help`) first. If an
   in-place switch is not supported, **stop**: the fallback is a new NAT and a route cutover, which
   needs its own plan.
3. **Window.** Changes to 1b/1c should not touch 1a/1f traffic. Even so, run it at low traffic,
   outside the production database maintenance window (Thu 07:30–08:00 UTC), with no other
   production change in flight.

## Steps (each on its own go phrase)

**Step 0, read-only (no phrase needed).** Re-run the live-state checks above and stop if anything
differs: NAT id, state `available`, the four addresses and their AZs, the single route, the VPC
Lambda subnets, zero bytes in 1b/1c over the last 7 days.

**Step 1, "NAT: manual mode, keep 1a and 1f".** Confirm the commands in the current
documentation (open question 2), then turn off automatic zone expansion keeping the 1a and 1f
addresses, and remove the 1b and 1c addresses from the gateway. The exact commands are written into
this note in a follow-up PR once confirmed; nothing is improvised at run time.

Verify:
- `describe-nat-gateways`: `AutoProvisionZones` disabled, `NatGatewayAddresses` lists only 1a
  (`184.193.58.15`) and 1f (`54.198.228.212`), both `succeeded`.
- Egress works from both AZs: `GET /providers/egress` on `checksops-staging-api`, and a
  read-only production health check that makes an outbound call.
- `BytesOutToDestination` continues in 1a and 1f over the next hour.

Rollback: re-enable automatic mode, or `associate-nat-gateway-address` for 1b and 1c with the
same allocation ids (`eipalloc-001bd1b5e1c454c13`, `eipalloc-0facc2a9a85845505`), which stay
allocated after step 1.

**Step 2, "NAT: release 1b and 1c addresses"** (optional, after a week without issues).
Release `eipalloc-001bd1b5e1c454c13` and `eipalloc-0facc2a9a85845505`. Released addresses cannot
be recovered, so this waits until open question 1 is settled.

## What this note does not do

- Changes no AWS resource, route, template, Lambda or database.
- Does not touch the Cognito or Secrets Manager endpoints, or the unattached `100.50.171.44`.
- No release-lock, pin or migration change.
