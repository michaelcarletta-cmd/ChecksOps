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
| Public IPv4, $0.005/h per address | $14.60 (4) | $7.30 (2) |
| Data processing, ~5.5 GB / 30 days × $0.045 | ~$0.25 | ~$0.25 |
| **Estimated monthly** | **~$146** | **~$73** (after step 4 below) |

An Elastic IP is billed whether or not it is attached, so the old addresses keep costing
$3.65/month each until step 4 releases them.

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

## Answers to the open questions (2026-11-04)

1. **Partner IP allowlists: none.** Owner, 2026-11-04: "no partner allowlists our IPs". The
   egress addresses may change.
2. **The existing NAT cannot be switched to manual mode.** The EC2 API (botocore 1.43.123 service
   model) has no `ModifyNatGateway`. The NAT operations are `CreateNatGateway`,
   `DeleteNatGateway`, `DescribeNatGateways`, `AssociateNatGatewayAddress`,
   `DisassociateNatGatewayAddress` and the private-address pair. Manual AZ coverage is set only by
   `CreateNatGateway`'s `AvailabilityZoneAddresses`: "If not specified, the NAT gateway will
   automatically expand to new AZs and associate EIPs upon detection of an elastic network
   interface. If you specify this parameter, auto-expansion is disabled and you must manually manage
   AZ coverage." Removing the 1b and 1c addresses from the current NAT is not a fix: while 1b and 1c
   hold network interfaces, automatic mode is documented to expand to them again.
3. **The Cognito endpoint cannot move to 1a/1f.** `describe-vpc-endpoint-services` lists
   `com.amazonaws.us-east-1.cognito-idp` only in us-east-1b, 1c and 1d. Its interfaces will stay
   in AZs the Lambdas do not use, so an automatic-mode NAT in this VPC will always cover at least
   one extra AZ.

So the original step 1 (switch in place) is withdrawn. The only way to a two-AZ NAT is a new
manual-mode regional NAT and a route swap.

## Revised proposal

Create a second regional NAT in **manual mode covering only us-east-1a and us-east-1f**, point the
Lambda route table at it, then delete the old NAT after a soak period.

- One route changes: 0.0.0.0/0 on `checksops-staging-lambda-private` (`rtb-057702ecbb292845f`).
  It is the only route to the NAT, and it carries both staging and `checksops-production-prep-api`
  egress.
- The egress addresses change to two new Elastic IPs (allowed: answer 1).
- At the route swap, connections already open through the old NAT stop working, so outbound
  keep-alive connections from the Lambdas are reset once and reopened by their clients. New
  connections use the new NAT at once.
- Until step 3 the old NAT stays running and is the rollback.
- A future Lambda subnet in another AZ needs that AZ added to the new NAT explicitly
  (`associate-nat-gateway-address --availability-zone ...`).

Cost after step 4: 2 AZs × $0.045 × 730 h = $65.70, plus 2 addresses × $3.65 = $7.30, so
about **$73/month**, against about $146 today. While the two NATs overlap (steps 1–3) the cost is
about $0.10/hour higher, which is negligible.

## Steps (each on its own go phrase)

Commands are AWS CLI, run in CloudShell by the owner or by Claude through boto3 with the same
parameters. The new ids (`<NEW_NAT>`, `<EIP_1A>`, `<EIP_1F>`) are printed by step 1 and recorded
here in the record PR. Nothing else is decided at run time.

**Step 0, read-only (no phrase).** Done 2026-11-04 (live state above). Repeat immediately before
step 1 and stop if anything differs: old NAT `available` with the four addresses, the single route
to it, VPC Lambdas only in `subnet-0df2518070c5b9ff0` and `subnet-092e4e41821fba6c4`.

**Step 1, "NAT: create the two-AZ NAT".** Nothing routes to it yet, so no traffic changes.

```bash
aws ec2 allocate-address --domain vpc --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=checksops-vpc-nat-1a}]'
aws ec2 allocate-address --domain vpc --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=checksops-vpc-nat-1f}]'
aws ec2 create-nat-gateway --vpc-id vpc-09f2268778966ce97 --availability-mode regional \
  --availability-zone-addresses 'AvailabilityZone=us-east-1a,AllocationIds=<EIP_1A>' 'AvailabilityZone=us-east-1f,AllocationIds=<EIP_1F>' \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=checksops-vpc-nat}]'
aws ec2 wait nat-gateway-available --nat-gateway-ids <NEW_NAT>
```

Verify: `describe-nat-gateways` for `<NEW_NAT>` shows `available`, `AvailabilityMode regional`,
`AutoProvisionZones disabled`, and addresses only in us-east-1a and us-east-1f. If any of these
differ, stop: delete `<NEW_NAT>` and release the two addresses.

**Step 2, "NAT: switch the Lambda route".**

```bash
aws ec2 replace-route --route-table-id rtb-057702ecbb292845f --destination-cidr-block 0.0.0.0/0 --nat-gateway-id <NEW_NAT>
```

Verify within 15 minutes:
- the route shows `<NEW_NAT>`, `active`;
- `GET /providers/egress` on `checksops-staging-api` succeeds;
- a read-only production request that makes an outbound call succeeds;
- `AWS/NATGateway` `BytesOutToDestination` for `<NEW_NAT>` is non-zero in 1a and/or 1f, and the old
  NAT's falls to zero.

Rollback: the same `replace-route` with `--nat-gateway-id nat-15f538197c4a75331`.

**Step 3, "NAT: delete the old NAT"**, after at least 24 hours with no egress errors.

```bash
aws ec2 delete-nat-gateway --nat-gateway-id nat-15f538197c4a75331
```

After this there is no fast rollback. A problem from here on is fixed on `<NEW_NAT>`, for example
by adding an AZ.

**Step 4, "NAT: release the old addresses".** Released addresses cannot be recovered.

```bash
aws ec2 release-address --allocation-id eipalloc-00522d181fe59bb1d   # 184.193.58.15 (1a)
aws ec2 release-address --allocation-id eipalloc-06781d2314441cec9   # 54.198.228.212 (1f)
aws ec2 release-address --allocation-id eipalloc-001bd1b5e1c454c13   # 13.219.134.91 (1b)
aws ec2 release-address --allocation-id eipalloc-0facc2a9a85845505   # 100.61.101.135 (1c)
```

Deleting the NAT should leave these four unattached. Verify with `describe-addresses` that each
has no association before releasing it. The unrelated idle `100.50.171.44`
(`eipalloc-01f1f9b72ac281ce9`) is not part of this step.

## Applied: step 1 (2026-11-04)

Owner's go phrase: "NAT: create the two-AZ NAT".

- Claude's first attempt (boto3 as `user/claude-code`) was refused at `ec2:AllocateAddress`
  (`UnauthorizedOperation`, no identity-based policy allows it) before anything was created.
  The owner then ran the commands in CloudShell.
- Addresses: `checksops-vpc-nat-1a` `eipalloc-0d8fff9a8ff036785` (52.4.42.236) and
  `checksops-vpc-nat-1f` `eipalloc-0dc609cf225a38c23` (23.20.96.103).
- A first `create-nat-gateway` with the placeholders left in failed with
  `InvalidElasticIpID.Malformed` and created nothing. The second, with client token
  `checksops-vpc-nat-step1-20261104-b`, created **`nat-1f2d1e419482e2737`** (`checksops-vpc-nat`)
  at 2026-11-04 20:38:09 UTC.
- Verified read-only by Claude (boto3): `available`, `AvailabilityMode regional`,
  `AutoProvisionZones disabled`, `AutoScalingIps disabled`, addresses only us-east-1a
  (52.4.42.236) and us-east-1f (23.20.96.103), both `succeeded`. No route table points at it.
  `rtb-057702ecbb292845f` still sends 0.0.0.0/0 to `nat-15f538197c4a75331`, which is `available`
  with its four addresses. No traffic changed.

For steps 2 and 3, `<NEW_NAT>` is `nat-1f2d1e419482e2737`.

## Applied: step 2 (2026-11-04)

The owner ran the step 2 command in CloudShell. CloudTrail `ReplaceRoute` on
`rtb-057702ecbb292845f`, all three by `root` from 3.236.155.90:

| time (UTC) | `natGatewayId` |
|---|---|
| 20:43:09 | `nat-1f2d1e419482e2737` (new) |
| 20:43:16 | `nat-15f538197c4a75331` (the rollback command, run along with step 2) |
| 20:44:24 | `nat-1f2d1e419482e2737` (new, final) |

Egress therefore switched twice within about 75 seconds before settling on the new NAT.

Verified:
- **Route.** 0.0.0.0/0 → `nat-1f2d1e419482e2737`, `active`. Read by Claude six times
  20:45–20:48 UTC and again at 20:50.
- **Staging egress.** The owner ran `aws lambda invoke` on `checksops-staging-api`,
  `GET /providers/egress`: `ok true`, `moovReachable true`, `checkaltUatReachable true`
  (`api.moov.io` HTTP 403 in 384 ms, `uatapi.checkalt.com` HTTP 403 in 170 ms).
- **Production egress.** The owner ran the same invoke on `checksops-production-prep-api`
  (`environment production-prep`): `ok true`, Moov HTTP 403 in 340 ms, CheckAlt UAT HTTP 403 in
  156 ms. A 403 means the host was reached. The probe sends no credentials and changes nothing.
- **NAT metrics** (`AWS/NATGateway`, 1-minute sums, read at 20:50 UTC):
  - The new NAT carries traffic in us-east-1f from 20:45 (`ConnectionEstablishedCount` 9, 2, 1)
    with no `ErrorPortAllocation`.
  - The old NAT has had no traffic since 20:42.
  - The new NAT's us-east-1a showed `PacketsDropCount` 38, 49, 27, 21, 2 at 20:41–20:45, falling
    to 2 by 20:45, with no connections there yet. The 20:41–20:42 counts come before any route
    pointed at it and are not explained. The 20:43–20:44 counts fit the switch-back and forth.
  - **us-east-1a has not yet carried a connection through the new NAT.** It is to be confirmed
    during the soak, before step 3.

The 24-hour soak runs from 20:44:24 UTC. Step 3 ("NAT: delete the old NAT") is due no earlier
than 2026-11-05 20:44 UTC, and only after us-east-1a traffic on the new NAT is confirmed.

## Alternatives considered

- **Leave it as it is** (~$146/month). No risk, no saving.
- **A single zonal NAT** (~$37/month). Cheaper still, but the production API's egress would then
  depend on one AZ, and the other AZ's traffic would cross AZs. Not preferred while production
  shares it.
- **Bring the NAT under IaC.** Wrong home in the `checksops-staging` stack, because production
  depends on it. A stack of its own is a separate reviewed change.

## What this note does not do

- Changes no AWS resource, route, template, Lambda or database.
- Does not touch the Cognito or Secrets Manager endpoints, or the unattached `100.50.171.44`.
- No release-lock, pin or migration change.
