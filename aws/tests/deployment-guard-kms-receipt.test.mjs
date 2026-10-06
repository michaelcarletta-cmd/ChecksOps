import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { consumedReceiptFile, consumeReceiptOnce } from '../../scripts/deployment-guard/lib/consumed-receipts.mjs';
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

test('KMS receipt without HMAC mac can be consumed once',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'checksops-kms-consume-'));
  const kmsReceipt=locallySigned({...receipt(),expiry:'2099-01-01T00:00:00.000Z'});
  assert.equal(kmsReceipt.mac,undefined);
  assert.equal(Boolean(consumedReceiptFile(root,kmsReceipt)),true);
  const first=consumeReceiptOnce(root,kmsReceipt,{now:1,script:'lambda-overlay-apply'});
  assert.equal(first.ok,true);
  const replay=consumeReceiptOnce(root,kmsReceipt,{now:2,script:'lambda-overlay-apply'});
  assert.equal(replay.ok,false);
  assert.equal(replay.code,'RECEIPT_REUSED');
  fs.rmSync(root,{recursive:true,force:true});
});
