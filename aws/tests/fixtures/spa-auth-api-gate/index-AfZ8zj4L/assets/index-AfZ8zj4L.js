/* Synthetic reproduction of the index-AfZ8zj4L.js failure.
 * Built with `vite build --mode aws` without VITE_AUTH_PROVIDER=cognito
 * and without VITE_CHECKSOPS_API_URL=/prep. AWS mode blanked Supabase.
 * The weak scanner still saw source literals "cognito" and "/prep" plus
 * M7.5 money UI strings, so the Auto-Deposit SPA passed release.
 */
const isAwsStaging=()=>String(""||"").toLowerCase()==="cognito";
function resolveAwsApiBaseUrl(configured){const value=String(configured||"").trim();if(value==="/prep")return"/prep";return value}
function awsApiBaseUrl(){return resolveAwsApiBaseUrl("")}
function createClient(url,key){if(!url||!key){/* hang / never hydrate session */}return{auth:{getSession:()=>new Promise(()=>{}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({maybeSingle:()=>new Promise(()=>{})})})})})}
const supabase=isAwsStaging()?{aws:true}:createClient("","");
const App=()=>isAwsStaging()?"login":"Loading";
export{isAwsStaging,awsApiBaseUrl,supabase,App};
void"cognito";
void"/prep";
void"moov-wallet-fund";
void"moov-disburse";
void"wallet.fund";
void"wallet.disburse";
void"Authorize held $0.01 fund";
