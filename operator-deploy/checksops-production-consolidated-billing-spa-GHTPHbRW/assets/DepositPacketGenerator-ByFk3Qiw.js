import{r as R,x as m,s as c,j as e,bA as U,B as S,C as E,f as M,a$ as k}from"./index-GHTPHbRW.js";import{P}from"./printer-Bc1iks5j.js";const v={insured:"Insured",mortgage_company:"Mortgage Company",contractor:"Contractor",public_adjuster:"Public Adjuster",other:"Other"};function r(a){return a==null?"—":String(a).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function w(a){return a==null?"—":`$${a.toLocaleString("en-US",{minimumFractionDigits:2})}`}function l(a){if(!a)return"—";try{return k(new Date(a),"MMM d, yyyy")}catch{return"—"}}function K({checkId:a}){var g,f;const b=R.useRef(null),{data:t}=m({queryKey:["deposit-packet",a],queryFn:async()=>{const{data:s,error:h}=await c.from("check_intake_items").select("*, check_payees(*), tenants(name)").eq("id",a).single();if(h)throw h;return s}}),{data:u=[]}=m({queryKey:["deposit-packet-decisions",a],queryFn:async()=>{const{data:s}=await c.from("check_review_decisions").select("*").eq("check_id",a).order("created_at",{ascending:!1});return s??[]}}),{data:n}=m({queryKey:["deposit-packet-reviewer",t==null?void 0:t.reviewed_by],enabled:!!(t!=null&&t.reviewed_by),queryFn:async()=>{const{data:s}=await c.from("profiles").select("full_name, email").eq("id",t.reviewed_by).single();return s}}),{data:p}=m({queryKey:["check-image-url",t==null?void 0:t.front_image_path],enabled:!!(t!=null&&t.front_image_path),queryFn:async()=>{const{data:s}=await c.storage.from("claim-files").createSignedUrl(t.front_image_path,3600);return(s==null?void 0:s.signedUrl)??null}}),{data:x}=m({queryKey:["check-back-image-url",t==null?void 0:t.back_image_path],enabled:!!(t!=null&&t.back_image_path),queryFn:async()=>{const{data:s}=await c.storage.from("claim-files").createSignedUrl(t.back_image_path,3600);return(s==null?void 0:s.signedUrl)??null}}),N=()=>{var y,_,j;if(!t)return;const s=window.open("","_blank");if(!s)return;const h=(t.check_payees??[]).map(i=>`<tr>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${r(i.payee_name)}</td>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${r(v[i.payee_type]??i.payee_type)}</td>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${r(i.endorsement_status)}</td>
        <td style="border:1px solid #ddd;padding:0.4rem;font-size:0.8rem">${i.endorsed_at?r(l(i.endorsed_at)):"—"}</td>
      </tr>`).join(""),$=(n==null?void 0:n.full_name)||(n==null?void 0:n.email)||"Staff",C=((y=t.tenants)==null?void 0:y.name)||"Freedom Adjustment",o=u[0],D=o?`
      <h2>Reviewer Decision</h2>
      <div class="notes">
        <p><strong>Decision:</strong> ${r((_=o.deposit_path)==null?void 0:_.replace(/_/g," "))}</p>
        <p><strong>Reviewed by:</strong> ${r($)}</p>
        ${o.reviewer_notes?`<p><strong>Notes:</strong> ${r(o.reviewer_notes)}</p>`:""}
        <p style="font-size:0.7rem;color:#888;margin-top:0.3rem">Reviewed ${r(l(o.created_at))}</p>
      </div>
    `:"",F=t.review_notes&&!o?`
      <h2>Reviewer Notes</h2>
      <div class="notes">${r(t.review_notes)}</div>
    `:"",q=p?`
      <h2>Check Front</h2>
      <img src="${r(p)}" alt="Check front" class="check-img" />
    `:"",z=x?`
      <h2>Check Back (Endorsements)</h2>
      <img src="${r(x)}" alt="Check back with endorsements" class="check-img" />
    `:"";s.document.write(`<!DOCTYPE html><html><head>
      <title>Deposit Packet — Check #${r(t.check_number??"Unknown")}</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem;color:#1a1a2e}
        h1{font-size:1.25rem;margin-bottom:0.25rem}
        h2{font-size:1rem;color:#444;margin-top:1.5rem;margin-bottom:0.5rem;border-bottom:1px solid #ddd;padding-bottom:0.25rem}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:0.5rem}
        .meta-item label{font-size:0.7rem;color:#888;text-transform:uppercase;letter-spacing:0.5px}
        .meta-item p{font-size:0.9rem;margin:0.15rem 0 0;font-weight:500}
        .notes{background:#f9f9f9;padding:0.75rem;border-radius:0.25rem;font-size:0.85rem;margin-top:0.5rem}
        .check-img{display:block;width:100%;height:auto;border:1px solid #ddd;border-radius:0.25rem}
        .footer{margin-top:2rem;padding-top:0.75rem;border-top:1px solid #ddd;font-size:0.7rem;color:#999}
        table{width:100%;border-collapse:collapse;margin-top:0.5rem}
        th{border:1px solid #ddd;padding:0.4rem;background:#f5f5f5;font-weight:600;font-size:0.8rem;text-align:left}
        @media print{body{padding:1rem}}
      </style>
    </head><body>
      <h1>Deposit Packet</h1>
      <p style="color:#888;font-size:0.8rem">Check #${r(t.check_number??"Unknown")} · ${r(t.carrier_name??"Unknown Carrier")}</p>
      <h2>Check Details</h2>
      <div class="meta">
        <div class="meta-item"><label>Carrier</label><p>${r(t.carrier_name)}</p></div>
        <div class="meta-item"><label>Amount</label><p style="font-weight:700">${r(w(t.amount))}</p></div>
        <div class="meta-item"><label>Check #</label><p style="font-family:monospace">${r(t.check_number)}</p></div>
        <div class="meta-item"><label>Claim #</label><p>${r(t.detected_claim_number)}</p></div>
        <div class="meta-item"><label>Issue Date</label><p>${r(l(t.issue_date))}</p></div>
        <div class="meta-item"><label>Recommendation</label><p>${r((j=t.deposit_recommendation)==null?void 0:j.replace(/_/g," "))}</p></div>
      </div>
      <h2>Payees &amp; Endorsements</h2>
      <table>
        <thead><tr><th>Payee</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
        <tbody>${h}</tbody>
      </table>
      ${D}
      ${F}
      ${q}
      ${z}
      <div class="footer">Generated ${r(new Date().toLocaleString())} · ${r(C)} Deposit Packet</div>
    </body></html>`),s.document.close(),s.print()};if(!t)return null;const d=u[0];return e.jsxs("div",{className:"space-y-3",children:[e.jsxs("div",{className:"flex items-center justify-between",children:[e.jsxs("h3",{className:"text-sm font-semibold flex items-center gap-2",children:[e.jsx(U,{className:"h-4 w-4"}),"Deposit Packet"]}),e.jsxs(S,{size:"sm",variant:"outline",onClick:N,children:[e.jsx(P,{className:"h-3.5 w-3.5 mr-1"}),"Print / Export"]})]}),e.jsx(E,{children:e.jsx(M,{className:"p-4 text-sm space-y-3",children:e.jsxs("div",{ref:b,children:[e.jsx("h1",{className:"text-base font-bold",children:"Deposit Packet"}),e.jsxs("p",{className:"text-xs text-muted-foreground",children:["Check #",t.check_number??"Unknown"," · ",t.carrier_name??"Unknown Carrier"]}),e.jsx("h2",{className:"text-sm font-semibold mt-3 mb-1 border-b border-border pb-1",children:"Check Details"}),e.jsxs("div",{className:"grid grid-cols-2 gap-2",children:[e.jsxs("div",{children:[e.jsx("p",{className:"text-[10px] text-muted-foreground uppercase",children:"Carrier"}),e.jsx("p",{className:"text-xs font-medium",children:t.carrier_name??"—"})]}),e.jsxs("div",{children:[e.jsx("p",{className:"text-[10px] text-muted-foreground uppercase",children:"Amount"}),e.jsx("p",{className:"text-xs font-bold",children:w(t.amount)})]}),e.jsxs("div",{children:[e.jsx("p",{className:"text-[10px] text-muted-foreground uppercase",children:"Check #"}),e.jsx("p",{className:"text-xs font-mono",children:t.check_number??"—"})]}),e.jsxs("div",{children:[e.jsx("p",{className:"text-[10px] text-muted-foreground uppercase",children:"Claim #"}),e.jsx("p",{className:"text-xs",children:t.detected_claim_number??"—"})]}),e.jsxs("div",{children:[e.jsx("p",{className:"text-[10px] text-muted-foreground uppercase",children:"Issue Date"}),e.jsx("p",{className:"text-xs",children:l(t.issue_date)})]}),e.jsxs("div",{children:[e.jsx("p",{className:"text-[10px] text-muted-foreground uppercase",children:"Recommendation"}),e.jsx("p",{className:"text-xs",children:((g=t.deposit_recommendation)==null?void 0:g.replace(/_/g," "))??"—"})]})]}),e.jsx("h2",{className:"text-sm font-semibold mt-3 mb-1 border-b border-border pb-1",children:"Payees & Endorsements"}),e.jsx("div",{className:"space-y-1",children:(t.check_payees??[]).map(s=>e.jsxs("div",{className:"flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0",children:[e.jsx("span",{className:"font-medium",children:s.payee_name}),e.jsx("span",{className:"text-muted-foreground",children:v[s.payee_type]??s.payee_type}),e.jsx("span",{className:s.endorsement_status==="signed"?"text-emerald-400":s.endorsement_status==="rejected"?"text-red-400":"text-muted-foreground",children:s.endorsement_status}),e.jsx("span",{className:"text-muted-foreground",children:s.endorsed_at?l(s.endorsed_at):"—"})]},s.id))}),d&&e.jsxs(e.Fragment,{children:[e.jsx("h2",{className:"text-sm font-semibold mt-3 mb-1 border-b border-border pb-1",children:"Reviewer Decision"}),e.jsxs("div",{className:"bg-muted/50 p-2 rounded text-xs space-y-1",children:[e.jsxs("p",{children:[e.jsx("strong",{children:"Decision:"})," ",(f=d.deposit_path)==null?void 0:f.replace(/_/g," ")]}),e.jsxs("p",{children:[e.jsx("strong",{children:"Reviewed by:"})," ",(n==null?void 0:n.full_name)||(n==null?void 0:n.email)||"Staff"]}),d.reviewer_notes&&e.jsxs("p",{children:[e.jsx("strong",{children:"Notes:"})," ",d.reviewer_notes]}),e.jsxs("p",{className:"text-muted-foreground text-[10px]",children:["Reviewed ",k(new Date(d.created_at),"MMM d, yyyy h:mm a")]})]})]}),t.review_notes&&!d&&e.jsxs(e.Fragment,{children:[e.jsx("h2",{className:"text-sm font-semibold mt-3 mb-1 border-b border-border pb-1",children:"Reviewer Notes"}),e.jsx("div",{className:"bg-muted/50 p-2 rounded text-xs",children:t.review_notes})]}),p&&e.jsxs(e.Fragment,{children:[e.jsx("h2",{className:"text-sm font-semibold mt-3 mb-1 border-b border-border pb-1",children:"Check Front"}),e.jsx("img",{src:p,alt:"Check front",className:"max-w-full border border-border rounded"})]}),x&&e.jsxs(e.Fragment,{children:[e.jsx("h2",{className:"text-sm font-semibold mt-3 mb-1 border-b border-border pb-1",children:"Check Back (Endorsements)"}),e.jsx("img",{src:x,alt:"Check back with endorsements",className:"max-w-full border border-border rounded"})]})]})})})]})}export{K as DepositPacketGenerator};
