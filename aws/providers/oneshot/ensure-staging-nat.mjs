#!/usr/bin/env node
/**
 * Staging-only private Lambda internet egress.
 *
 * Creates (when IAM allows) a NAT Gateway in an existing public subnet and
 * a 0.0.0.0/0 route on private subnet route tables only. Also ensures the
 * API Lambda SG can egress tcp/443 to 0.0.0.0/0.
 *
 * Does not:
 * - make RDS public
 * - add Lambda public inbound
 * - weaken the RDS security group
 * - print AWS credentials
 *
 * Usage: node aws/providers/oneshot/ensure-staging-nat.mjs
 */
import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const VPC_ID = process.env.STAGING_VPC_ID || 'vpc-09f2268778966ce97';
const LAMBDA_NAME = process.env.STAGING_API_FUNCTION || 'checksops-staging-api';
const RDS_SG = process.env.STAGING_RDS_SG || 'sg-0e9332faa87c1d059';

const awsJson = (args) => {
  const out = execFileSync('aws', ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim() ? JSON.parse(out) : {};
};

const awsOk = (args) => {
  try {
    return { ok: true, data: awsJson(args) };
  } catch (error) {
    const stderr = String(error.stderr || error.message || error);
    return { ok: false, error: stderr.slice(0, 400) };
  }
};

const main = () => {
  const identity = awsOk(['sts', 'get-caller-identity']);
  if (!identity.ok) {
    return {
      ok: false,
      classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
      error: identity.error,
      createdNat: false,
      rdsMadePublic: false,
    };
  }

  const lambda = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
  const vpcConfig = lambda.VpcConfig || {};
  const privateSubnetIds = vpcConfig.SubnetIds || [];
  const lambdaSgs = vpcConfig.SecurityGroupIds || [];
  if (!privateSubnetIds.length) {
    return { ok: false, error: 'lambda_not_in_vpc', createdNat: false };
  }

  const subnets = awsJson(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${VPC_ID}`]).Subnets || [];
  const routeTables = awsJson(['ec2', 'describe-route-tables', '--filters', `Name=vpc-id,Values=${VPC_ID}`]).RouteTables || [];
  const igws = awsJson(['ec2', 'describe-internet-gateways', '--filters', `Name=attachment.vpc-id,Values=${VPC_ID}`]).InternetGateways || [];
  const nats = awsJson(['ec2', 'describe-nat-gateways', '--filter', `Name=vpc-id,Values=${VPC_ID}`]).NatGateways || [];
  const igwId = igws.find((g) => (g.Attachments || []).some((a) => a.VpcId === VPC_ID && a.State === 'available'))?.InternetGatewayId || null;

  const rtForSubnet = (subnetId) => {
    const explicit = routeTables.find((rt) => (rt.Associations || []).some((a) => a.SubnetId === subnetId));
    if (explicit) return explicit;
    return routeTables.find((rt) => (rt.Associations || []).some((a) => a.Main)) || null;
  };
  const hasIgwRoute = (rt) => (rt?.Routes || []).some((r) => r.GatewayId && String(r.GatewayId).startsWith('igw-') && r.DestinationCidrBlock === '0.0.0.0/0');
  const natRoute = (rt) => (rt?.Routes || []).find((r) => r.NatGatewayId && r.DestinationCidrBlock === '0.0.0.0/0');

  const publicSubnets = subnets.filter((s) => hasIgwRoute(rtForSubnet(s.SubnetId)));
  const requestedPublic = process.env.STAGING_PUBLIC_SUBNET_ID
    || publicSubnets[0]?.SubnetId
    || null;

  const activeNat = (nats || []).find((n) => ['available', 'pending'].includes(n.State) && n.VpcId === VPC_ID);
  const actions = [];
  let natId = activeNat?.NatGatewayId || null;
  let eipAlloc = activeNat?.NatGatewayAddresses?.[0]?.AllocationId || null;

  for (const sgId of lambdaSgs) {
    const sg = (awsJson(['ec2', 'describe-security-groups', '--group-ids', sgId]).SecurityGroups || [])[0];
    const has443 = (sg?.IpPermissionsEgress || []).some((rule) => (
      rule.IpProtocol === 'tcp'
      && Number(rule.FromPort) === 443
      && Number(rule.ToPort) === 443
      && (rule.IpRanges || []).some((r) => r.CidrIp === '0.0.0.0/0')
    ));
    if (!has443) {
      const added = awsOk([
        'ec2', 'authorize-security-group-egress',
        '--group-id', sgId,
        '--ip-permissions',
        JSON.stringify([{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'HTTPS to Moov/CheckAlt UAT via NAT' }] }]),
      ]);
      actions.push({ authorizeLambdaHttpsEgress: added.ok, sgId, error: added.error || null });
    } else {
      actions.push({ authorizeLambdaHttpsEgress: 'already_present', sgId });
    }
  }

  const rds = (awsJson(['ec2', 'describe-security-groups', '--group-ids', RDS_SG]).SecurityGroups || [])[0];
  const rdsOpen = (rds?.IpPermissions || []).some((rule) => (
    Number(rule.FromPort) === 5432 && (rule.IpRanges || []).some((r) => r.CidrIp === '0.0.0.0/0')
  ));

  if (!natId) {
    if (!igwId) {
      return {
        ok: false,
        classification: 'BLOCKED BY AWS NETWORK ARCHITECTURE',
        error: 'vpc_has_no_internet_gateway',
        createdNat: false,
        rdsMadePublic: false,
        rdsOpenToWorld: rdsOpen,
      };
    }
    if (!requestedPublic) {
      return {
        ok: false,
        classification: 'BLOCKED BY AWS NETWORK ARCHITECTURE',
        error: 'no_public_subnet_with_igw_route',
        hint: 'Provide STAGING_PUBLIC_SUBNET_ID in a subnet that already has 0.0.0.0/0 → igw. Do not attach a public IP to Lambda.',
        createdNat: false,
        rdsMadePublic: false,
      };
    }
    const eip = awsOk(['ec2', 'allocate-address', '--domain', 'vpc', '--tag-specifications',
      `ResourceType=elastic-ip,Tags=[{Key=Name,Value=checksops-staging-nat},{Key=Environment,Value=staging}]`]);
    if (!eip.ok) {
      return {
        ok: false,
        classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
        error: eip.error,
        createdNat: false,
        rdsMadePublic: false,
      };
    }
    eipAlloc = eip.data.AllocationId;
    const nat = awsOk(['ec2', 'create-nat-gateway',
      '--subnet-id', requestedPublic,
      '--allocation-id', eipAlloc,
      '--tag-specifications',
      `ResourceType=natgateway,Tags=[{Key=Name,Value=checksops-staging-nat},{Key=Environment,Value=staging}]`,
    ]);
    if (!nat.ok) {
      return {
        ok: false,
        classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
        error: nat.error,
        createdNat: false,
        eipAlloc,
        rdsMadePublic: false,
      };
    }
    natId = nat.data.NatGateway?.NatGatewayId || nat.data.NatGatewayId;
    actions.push({ createNatGateway: true, natId, subnetId: requestedPublic });
  } else {
    actions.push({ createNatGateway: 'already_present', natId });
  }

  const refreshRouteTables = () => (
    awsJson(['ec2', 'describe-route-tables', '--filters', `Name=vpc-id,Values=${VPC_ID}`]).RouteTables || []
  );

  // Default VPC: Lambda subnets share the main table (0.0.0.0/0 → igw).
  // Lambda ENIs have no public IPs, so that IGW route cannot provide egress.
  // Create/reuse a dedicated private RT and associate only Lambda subnets.
  // Never replace the main/public IGW default route. Never make RDS public.
  let workingTables = routeTables;
  const taggedPrivate = workingTables.find((rt) => (
    (rt.Tags || []).some((t) => t.Key === 'Name' && t.Value === 'checksops-staging-lambda-private')
  ));
  let dedicatedPrivateRt = taggedPrivate?.RouteTableId || null;
  const lambdaRtsNeedIsolation = privateSubnetIds.some((subnetId) => hasIgwRoute(rtForSubnet(subnetId)));
  if (lambdaRtsNeedIsolation) {
    if (!dedicatedPrivateRt) {
      const createdRt = awsOk([
        'ec2', 'create-route-table',
        '--vpc-id', VPC_ID,
        '--tag-specifications',
        `ResourceType=route-table,Tags=[{Key=Name,Value=checksops-staging-lambda-private},{Key=Environment,Value=staging}]`,
      ]);
      if (!createdRt.ok) {
        return {
          ok: false,
          classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
          error: createdRt.error,
          createdNat: Boolean(natId),
          natGatewayId: natId,
          rdsMadePublic: false,
          hint: 'Need ec2:CreateRouteTable so Lambda subnets can leave the main IGW table without changing public routes.',
        };
      }
      dedicatedPrivateRt = createdRt.data.RouteTable?.RouteTableId || createdRt.data.RouteTableId;
      actions.push({ createPrivateRouteTable: true, rtId: dedicatedPrivateRt });
    } else {
      actions.push({ createPrivateRouteTable: 'already_present', rtId: dedicatedPrivateRt });
    }
    for (const subnetId of privateSubnetIds) {
      const current = rtForSubnet(subnetId);
      if (current?.RouteTableId === dedicatedPrivateRt) {
        actions.push({ associatePrivateRt: 'already_present', subnetId, rtId: dedicatedPrivateRt });
        continue;
      }
      if (hasIgwRoute(current) && current?.Associations?.some((a) => a.Main && !a.SubnetId)) {
        const associated = awsOk([
          'ec2', 'associate-route-table',
          '--route-table-id', dedicatedPrivateRt,
          '--subnet-id', subnetId,
        ]);
        actions.push({
          associatePrivateRt: associated.ok,
          subnetId,
          rtId: dedicatedPrivateRt,
          previousRtId: current?.RouteTableId || null,
          error: associated.error || null,
        });
        if (!associated.ok) {
          return {
            ok: false,
            classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
            error: associated.error,
            createdNat: Boolean(natId),
            natGatewayId: natId,
            rdsMadePublic: false,
            hint: 'Need ec2:AssociateRouteTable on Lambda subnets only. Main IGW table was not modified.',
          };
        }
      } else if (hasIgwRoute(current)) {
        actions.push({ associatePrivateRt: 'skipped_explicit_public_association', subnetId, rtId: current.RouteTableId });
      }
    }
    workingTables = refreshRouteTables();
  }

  const rtForSubnetNow = (subnetId) => {
    const explicit = workingTables.find((rt) => (rt.Associations || []).some((a) => a.SubnetId === subnetId));
    if (explicit) return explicit;
    return workingTables.find((rt) => (rt.Associations || []).some((a) => a.Main)) || null;
  };

  const waitNatAvailable = () => {
    if (!natId) return { ok: false, error: 'nat_id_missing' };
    for (let i = 0; i < 30; i += 1) {
      const latest = awsOk(['ec2', 'describe-nat-gateways', '--nat-gateway-ids', natId]);
      const state = latest.data?.NatGateways?.[0]?.State || latest.error;
      if (state === 'available') return { ok: true, state };
      if (state === 'failed' || state === 'deleted') return { ok: false, state };
      execFileSync('sleep', ['10']);
    }
    return { ok: false, error: 'nat_not_available_timeout' };
  };
  const natReady = waitNatAvailable();
  actions.push({ waitNatAvailable: natReady.ok, natId, error: natReady.error || natReady.state || null });
  if (!natReady.ok) {
    return {
      ok: false,
      classification: 'BLOCKED BY AWS NETWORK ARCHITECTURE',
      error: natReady.error || natReady.state,
      createdNat: Boolean(natId),
      natGatewayId: natId,
      rdsMadePublic: false,
    };
  }

  const privateRts = [...new Set(privateSubnetIds.map((id) => rtForSubnetNow(id)?.RouteTableId).filter(Boolean))];
  for (const rtId of privateRts) {
    const rt = workingTables.find((row) => row.RouteTableId === rtId);
    if (hasIgwRoute(rt)) {
      actions.push({ route: 'skipped_public_rt', rtId, reason: 'has_igw_default_route' });
      continue;
    }
    const existing = natRoute(rt);
    if (existing?.NatGatewayId === natId) {
      actions.push({ route: 'already_present', rtId, natId });
      continue;
    }
    if (existing && existing.NatGatewayId !== natId) {
      actions.push({ route: 'existing_other_nat', rtId, natId: existing.NatGatewayId });
      continue;
    }
    const created = awsOk(['ec2', 'create-route', '--route-table-id', rtId, '--destination-cidr-block', '0.0.0.0/0', '--nat-gateway-id', natId]);
    actions.push({ createPrivateNatRoute: created.ok, rtId, natId, error: created.error || null });
  }

  const s3Endpoint = (awsJson(['ec2', 'describe-vpc-endpoints', '--filters', `Name=vpc-id,Values=${VPC_ID}`, 'Name=service-name,Values=com.amazonaws.us-east-1.s3']).VpcEndpoints || [])[0];
  if (s3Endpoint?.VpcEndpointId && dedicatedPrivateRt && !(s3Endpoint.RouteTableIds || []).includes(dedicatedPrivateRt)) {
    const attached = awsOk([
      'ec2', 'modify-vpc-endpoint',
      '--vpc-endpoint-id', s3Endpoint.VpcEndpointId,
      '--add-route-table-ids', dedicatedPrivateRt,
    ]);
    actions.push({ attachS3GatewayToPrivateRt: attached.ok, rtId: dedicatedPrivateRt, error: attached.error || null });
  }

  const lambdaHasNatRoute = privateRts.every((rtId) => {
    const rt = workingTables.find((row) => row.RouteTableId === rtId) || rtForSubnetNow(privateSubnetIds[0]);
    const refreshed = (refreshRouteTables().find((row) => row.RouteTableId === rtId)) || rt;
    return Boolean(natRoute(refreshed)?.NatGatewayId) && !hasIgwRoute(refreshed);
  });

  return {
    ok: Boolean(natId) && lambdaHasNatRoute,
    classification: (natId && lambdaHasNatRoute)
      ? 'NAT_CONFIGURED_OR_PRESENT'
      : 'BLOCKED BY AWS NETWORK ARCHITECTURE',
    vpcId: VPC_ID,
    natGatewayId: natId,
    eipAllocationId: eipAlloc,
    publicSubnetId: requestedPublic,
    dedicatedPrivateRouteTableId: dedicatedPrivateRt,
    privateSubnetIds,
    privateRouteTableIds: privateRts,
    lambdaSecurityGroups: lambdaSgs,
    lambdaHasNatRoute,
    rdsMadePublic: false,
    rdsOpenToWorld: Boolean(rdsOpen),
    lambdaPublicInbound: false,
    actions,
    next: 'Invoke GET /providers/egress on checksops-staging-api. Do not treat this oneshot host as Lambda proof.',
  };
};

const result = main();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
