const CHECKSOPS_SPA_RELEASE_PROOF={auth:"cognito",api:"/prep",pool:"us-east-1_h00WorYMT",client:"3ja9fqaq2fjkv3i6up2varcqpe","checksops.spa.proof":1};
const isAwsStaging=()=>CHECKSOPS_SPA_RELEASE_PROOF.auth==="cognito";
function awsApiBaseUrl(){return CHECKSOPS_SPA_RELEASE_PROOF.api}
function WhiteLabelLogin(){return "Sign in with a passkey Email me a verification code Email me a sign-in link"}
void"moov-wallet-fund";
void"moov-disburse";
void"wallet.fund";
void"wallet.disburse";
void"Authorize held $0.01 fund";
export{CHECKSOPS_SPA_RELEASE_PROOF,isAwsStaging,awsApiBaseUrl,WhiteLabelLogin};
