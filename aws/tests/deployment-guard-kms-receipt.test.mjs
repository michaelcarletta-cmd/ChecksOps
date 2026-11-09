import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { canonicalReceiptPayload, verifyReceiptKmsSignature } from '../../scripts/deployment-guard/lib/issuer.mjs';
import { signReceiptWithKms } from '../../scripts/deployment-guard/lib/kms-issuer.mjs';

const KEY_ARN='arn:aws:kms:us-east-1:806168576068:key/11111111-2222-3333-4444-555555555555';
const { privateKey, publicKey }=generateKeyPairSync('ec',{namedCurve:'P-256'});
const PUBLIC_DER=publicKey.export({type:'spki',format:'der'}).toString('base64');
const ENV={
  CHECKSOPS_DEPLOYMENT_GUARD_KMS_KEY_ARN:KEY_ARN,
  CHECKSOPS_DEPLOYMENT_GUARD_KMS_PUBLIC_KEY_DER_B64:PUBLIC_DER,
};

function receipt(){
  return {
    schema_version:1,
    kind:'deployment-guard-receipt',
    workstream_id:'github-staging-overlay-1',
    commit:'a'.repeat(40),
    target_environment:'staging',
    target_component:'checksops-staging-api',
    deployment_type:'lambda-overlay',
  };
}

function locallySigned(input=receipt()){
  const withKey={...input,kms_key_arn:KEY_ARN};
  const signature=sign('sha256',Buffer.from(canonicalReceiptPayload(withKey)),privateKey).toString('base64');
  return {...withKey,kms_signature:signature};
}

test('valid KMS-style receipt verifies with pinned key identity and public key',()=>{
  assert.equal(verifyReceiptKmsSignature(locallySigned(),ENV),true);
});

test('KMS receipt tampering, wrong key ARN, and wrong public key fail closed',()=>{
  const valid=locallySigned();
  assert.equal(verifyReceiptKmsSignature({...valid,commit:'b'.repeat(40)},ENV),false);
  assert.equal(verifyReceiptKmsSignature({...valid,kms_key_arn:KEY_ARN.replace('11111111','aaaaaaaa')},ENV),false);
  const other=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
  assert.equal(verifyReceiptKmsSignature(valid,{...ENV,CHECKSOPS_DEPLOYMENT_GUARD_KMS_PUBLIC_KEY_DER_B64:other}),false);
});

test('KMS signer is bound to configured key and ECDSA_SHA_256',()=>{
  const calls=[];
  const signed=signReceiptWithKms(receipt(),{
    env:ENV,
    execFile:(cmd,args)=>{
      calls.push({cmd,args});
      const withKey={...receipt(),kms_key_arn:KEY_ARN};
      return JSON.stringify({
        KeyId:KEY_ARN,
        SigningAlgorithm:'ECDSA_SHA_256',
        Signature:sign('sha256',Buffer.from(canonicalReceiptPayload(withKey)),privateKey).toString('base64'),
      });
    },
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].cmd,'aws');
  assert.ok(calls[0].args.includes('sign'));
  assert.ok(calls[0].args.includes(KEY_ARN));
  assert.equal(verifyReceiptKmsSignature(signed,ENV),true);
});

test('KMS signer refuses missing config and mismatched KMS response',()=>{
  assert.throws(()=>signReceiptWithKms(receipt(),{env:{},execFile:()=>''}),/missing or invalid/);
  assert.throws(()=>signReceiptWithKms(receipt(),{
    env:ENV,
    execFile:()=>JSON.stringify({KeyId:'wrong',SigningAlgorithm:'ECDSA_SHA_256',Signature:'abc'}),
  }),/did not match/);
});

function argAfter(args,flag){
  const i=args.indexOf(flag);
  assert.ok(i>=0,`${flag} is passed`);
  return args[i+1];
}

test('KMS signer sends the SHA-256 digest of the canonical payload as a DIGEST message',()=>{
  const calls=[];
  signReceiptWithKms(receipt(),{
    env:ENV,
    execFile:(cmd,args)=>{
      calls.push(args);
      const withKey={...receipt(),kms_key_arn:KEY_ARN};
      return JSON.stringify({
        KeyId:KEY_ARN,
        SigningAlgorithm:'ECDSA_SHA_256',
        Signature:sign('sha256',Buffer.from(canonicalReceiptPayload(withKey)),privateKey).toString('base64'),
      });
    },
  });
  const args=calls[0];
  assert.equal(argAfter(args,'--message-type'),'DIGEST');
  assert.equal(argAfter(args,'--signing-algorithm'),'ECDSA_SHA_256');
  const expected=createHash('sha256').update(canonicalReceiptPayload({...receipt(),kms_key_arn:KEY_ARN})).digest();
  assert.deepEqual(Buffer.from(argAfter(args,'--message'),'base64'),expected);
});

test('a receipt larger than the 4096-byte KMS RAW limit still signs and verifies',()=>{
  // Shaped like the onboarding-keys update receipt: the preflight fingerprint carries live key policies.
  const big={...receipt(),preflight_live_fingerprint:{key_policies:{documents:'x'.repeat(3000),pii:'y'.repeat(3000)}}};
  const withKey={...big,kms_key_arn:KEY_ARN};
  assert.ok(Buffer.byteLength(canonicalReceiptPayload(withKey))>4096);
  let sent;
  const signed=signReceiptWithKms(big,{
    env:ENV,
    execFile:(cmd,args)=>{
      sent=Buffer.from(argAfter(args,'--message'),'base64');
      return JSON.stringify({
        KeyId:KEY_ARN,
        SigningAlgorithm:'ECDSA_SHA_256',
        Signature:sign('sha256',Buffer.from(canonicalReceiptPayload(withKey)),privateKey).toString('base64'),
      });
    },
  });
  assert.equal(sent.length,32);
  assert.equal(verifyReceiptKmsSignature(signed,ENV),true);
  assert.equal(verifyReceiptKmsSignature({...signed,preflight_live_fingerprint:{key_policies:{documents:'z',pii:'y'}}},ENV),false);
});
