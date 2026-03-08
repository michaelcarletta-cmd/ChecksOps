-- Update email templates: {claim.policyholder_name} -> ${policyholder}
UPDATE email_templates SET 
  subject = REPLACE(subject, '{claim.policyholder_name}', '${policyholder}'),
  body = REPLACE(body, '{claim.policyholder_name}', '${policyholder}')
WHERE subject LIKE '%{claim.policyholder_name}%' OR body LIKE '%{claim.policyholder_name}%';

-- Update email templates: {claim.claim_number} -> ${claim.claim_number}
UPDATE email_templates SET 
  subject = REPLACE(subject, '{claim.claim_number}', '${claim.claim_number}'),
  body = REPLACE(body, '{claim.claim_number}', '${claim.claim_number}')
WHERE subject LIKE '%{claim.claim_number}%' OR body LIKE '%{claim.claim_number}%';

-- Update email templates: {claim.policyholder_address} -> ${property_address}
UPDATE email_templates SET 
  subject = REPLACE(subject, '{claim.policyholder_address}', '${property_address}'),
  body = REPLACE(body, '{claim.policyholder_address}', '${property_address}')
WHERE subject LIKE '%{claim.policyholder_address}%' OR body LIKE '%{claim.policyholder_address}%';

-- Update email templates: other claim fields
UPDATE email_templates SET body = REPLACE(body, '{claim.policy_number}', '${policy}') WHERE body LIKE '%{claim.policy_number}%';
UPDATE email_templates SET body = REPLACE(body, '{claim.insurance_company}', '${insurance_company}') WHERE body LIKE '%{claim.insurance_company}%';
UPDATE email_templates SET body = REPLACE(body, '{claim.loss_type}', '${claim.loss_type}') WHERE body LIKE '%{claim.loss_type}%';
UPDATE email_templates SET body = REPLACE(body, '{claim.loss_date}', '${claim.loss_date}') WHERE body LIKE '%{claim.loss_date}%';
UPDATE email_templates SET body = REPLACE(body, '{claim.status}', '${claim.status}') WHERE body LIKE '%{claim.status}%';
UPDATE email_templates SET body = REPLACE(body, '{claim.policyholder_phone}', '${policyholder_phone}') WHERE body LIKE '%{claim.policyholder_phone}%';
UPDATE email_templates SET body = REPLACE(body, '{claim.policyholder_email}', '${policyholder_email}') WHERE body LIKE '%{claim.policyholder_email}%';

-- Update email templates: inspection fields
UPDATE email_templates SET 
  body = REPLACE(REPLACE(REPLACE(body, '{inspection.date}', '${inspection.date}'), '{inspection.time}', '${inspection.time}'), '{inspection.inspector}', '${inspection.inspector}'),
  subject = REPLACE(REPLACE(REPLACE(subject, '{inspection.date}', '${inspection.date}'), '{inspection.time}', '${inspection.time}'), '{inspection.inspector}', '${inspection.inspector}')
WHERE body LIKE '%{inspection.%' OR subject LIKE '%{inspection.%';

-- Update email templates: settlement fields
UPDATE email_templates SET 
  body = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(body, 
    '{settlement.total_rcv}', '${settlement.total_rcv}'),
    '{settlement.total_net}', '${settlement.total_net}'),
    '{settlement.total_deductible}', '${settlement.total_deductible}'),
    '{settlement.dwelling_rcv}', '${settlement.dwelling_rcv}'),
    '{settlement.prior_offer}', '${settlement.prior_offer}'),
    '{settlement.total_recoverable_dep}', '${settlement.total_recoverable_dep}')
WHERE body LIKE '%{settlement.%';

-- SMS templates: same replacements
UPDATE sms_templates SET body = REPLACE(body, '{claim.policyholder_name}', '${policyholder}') WHERE body LIKE '%{claim.policyholder_name}%';
UPDATE sms_templates SET body = REPLACE(body, '{claim.claim_number}', '${claim.claim_number}') WHERE body LIKE '%{claim.claim_number}%';
UPDATE sms_templates SET body = REPLACE(body, '{claim.policyholder_address}', '${property_address}') WHERE body LIKE '%{claim.policyholder_address}%';
UPDATE sms_templates SET body = REPLACE(body, '{claim.policy_number}', '${policy}') WHERE body LIKE '%{claim.policy_number}%';
UPDATE sms_templates SET body = REPLACE(body, '{claim.insurance_company}', '${insurance_company}') WHERE body LIKE '%{claim.insurance_company}%';
UPDATE sms_templates SET body = REPLACE(body, '{claim.status}', '${claim.status}') WHERE body LIKE '%{claim.status}%';
UPDATE sms_templates SET body = REPLACE(body, '{claim.loss_type}', '${claim.loss_type}') WHERE body LIKE '%{claim.loss_type}%';
UPDATE sms_templates SET body = REPLACE(REPLACE(REPLACE(body, '{inspection.date}', '${inspection.date}'), '{inspection.time}', '${inspection.time}'), '{inspection.inspector}', '${inspection.inspector}') WHERE body LIKE '%{inspection.%';
