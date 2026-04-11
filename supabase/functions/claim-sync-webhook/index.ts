import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-claim-sync-secret',
};

function normalizeInspectionValue(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

function findMatchingExternalInspection(
  existingInspections: Array<{
    id: string;
    inspection_time: string | null;
    inspection_type: string | null;
    inspector_name: string | null;
  }>,
  incomingInspection: {
    inspection_time?: string | null;
    inspection_type?: string | null;
    inspector_name?: string | null;
  }
) {
  const incomingTime = normalizeInspectionValue(incomingInspection.inspection_time);
  const incomingType = normalizeInspectionValue(incomingInspection.inspection_type);
  const incomingInspector = normalizeInspectionValue(incomingInspection.inspector_name);

  const exactMatch = existingInspections.find((inspection) => {
    return (
      normalizeInspectionValue(inspection.inspection_time) === incomingTime &&
      normalizeInspectionValue(inspection.inspection_type) === incomingType &&
      normalizeInspectionValue(inspection.inspector_name) === incomingInspector
    );
  });

  if (exactMatch) return exactMatch;

  return existingInspections.length === 1 ? existingInspections[0] : null;
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const syncSecret = Deno.env.get('CLAIM_SYNC_SECRET');
    const requestSecret = req.headers.get('x-claim-sync-secret');

    console.log(`Webhook received - has env secret: ${!!syncSecret}, has request secret: ${!!requestSecret}`);
    
    // Validate sync secret
    if (!syncSecret || requestSecret !== syncSecret) {
      console.error(`Secret mismatch`);
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { 
      action, 
      claim_data, 
      external_claim_id, 
      source_instance_url, 
      target_workspace_id,
      tasks_data,
      updates_data,
      inspections_data,
      adjusters_data,
      accounting_data,
      files_data,
      photos_data,
      emails_data,
      partner_assignment,
    } = await req.json();

    console.log(`Received sync request: action=${action}, external_claim_id=${external_claim_id}, source=${source_instance_url}, target_workspace_id=${target_workspace_id}, partner_assignment=${partner_assignment ? partner_assignment.sales_rep_name : 'none'}`);

    // Handle get_users action - returns staff and admin users for partner assignment
    if (action === 'get_users') {
      console.log('Handling get_users action');
      
      // Get all users who have staff or admin roles
      const { data: userRoles, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["admin", "staff"]);

      if (rolesError) {
        console.error("Error fetching user roles:", rolesError);
        throw rolesError;
      }

      // Get unique user IDs
      const userIds = [...new Set(userRoles?.map((r) => r.user_id) || [])];

      if (userIds.length === 0) {
        return new Response(
          JSON.stringify({ success: true, users: [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get profile info for these users
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds)
        .eq("approval_status", "approved");

      if (profilesError) {
        console.error("Error fetching profiles:", profilesError);
        throw profilesError;
      }

      // Combine profile info with roles
      const users = profiles?.map((profile: any) => {
        const roles = userRoles?.filter((r) => r.user_id === profile.id).map((r) => r.role) || [];
        return {
          id: profile.id,
          full_name: profile.full_name,
          email: profile.email,
          roles,
        };
      }) || [];

      console.log(`Found ${users.length} staff/admin users`);

      return new Response(
        JSON.stringify({ success: true, users }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === 'create_or_update') {
      // Check if we already have this linked claim
      const { data: existingLink } = await supabase
        .from('linked_claims')
        .select('claim_id')
        .eq('external_instance_url', source_instance_url)
        .eq('external_claim_id', external_claim_id)
        .single();

      let claimId: string;

      if (existingLink) {
        // Update existing claim
        claimId = existingLink.claim_id;
        console.log(`Updating existing linked claim: ${claimId}`);
        
        // Build update object - only update fields that are provided
        const updateData: Record<string, any> = {
          updated_at: new Date().toISOString(),
        };
        
        // Always sync these core fields if claim_data exists
        if (claim_data) {
          if (claim_data.claim_number !== undefined) updateData.claim_number = claim_data.claim_number;
          if (claim_data.policyholder_name !== undefined) updateData.policyholder_name = claim_data.policyholder_name;
          if (claim_data.policyholder_email !== undefined) updateData.policyholder_email = claim_data.policyholder_email;
          if (claim_data.policyholder_phone !== undefined) updateData.policyholder_phone = claim_data.policyholder_phone;
          if (claim_data.policyholder_address !== undefined) updateData.policyholder_address = claim_data.policyholder_address;
          if (claim_data.insurance_company !== undefined) updateData.insurance_company = claim_data.insurance_company;
          if (claim_data.insurance_phone !== undefined) updateData.insurance_phone = claim_data.insurance_phone;
          if (claim_data.insurance_email !== undefined) updateData.insurance_email = claim_data.insurance_email;
          if (claim_data.loss_type !== undefined) updateData.loss_type = claim_data.loss_type;
          if (claim_data.loss_date !== undefined) updateData.loss_date = claim_data.loss_date;
          if (claim_data.loss_description !== undefined) updateData.loss_description = claim_data.loss_description;
          if (claim_data.policy_number !== undefined) updateData.policy_number = claim_data.policy_number;
          if (claim_data.claim_amount !== undefined) updateData.claim_amount = claim_data.claim_amount;
          // Store partner's construction status in the partner_construction_status field
          if (claim_data.construction_status !== undefined) updateData.partner_construction_status = claim_data.construction_status;
        }
        
        if (target_workspace_id) updateData.workspace_id = target_workspace_id;
        
        // Update partner assignment fields if provided
        if (partner_assignment) {
          updateData.partner_assigned_user_id = partner_assignment.sales_rep_id || null;
          updateData.partner_assigned_user_email = partner_assignment.sales_rep_email || null;
          updateData.partner_assigned_user_name = partner_assignment.sales_rep_name || null;
        }
        
        console.log(`Updating claim ${claimId} with fields:`, Object.keys(updateData));
        
        const { error: updateError } = await supabase
          .from('claims')
          .update(updateData)
          .eq('id', claimId);

        if (updateError) {
          console.error('Error updating claim:', updateError);
          throw updateError;
        }
      } else {
        // Create new claim
        console.log('Creating new claim from external sync');
        
        const { data: newClaim, error: createError } = await supabase
          .from('claims')
          .insert({
            claim_number: claim_data.claim_number,
            policyholder_name: claim_data.policyholder_name,
            policyholder_email: claim_data.policyholder_email,
            policyholder_phone: claim_data.policyholder_phone,
            policyholder_address: claim_data.policyholder_address,
            insurance_company: claim_data.insurance_company,
            insurance_phone: claim_data.insurance_phone,
            insurance_email: claim_data.insurance_email,
            loss_type: claim_data.loss_type,
            loss_date: claim_data.loss_date,
            loss_description: claim_data.loss_description,
            policy_number: claim_data.policy_number,
            status: claim_data.status || 'open',
            claim_amount: claim_data.claim_amount,
            workspace_id: target_workspace_id,
            partner_construction_status: claim_data.construction_status,
            // Set partner assignment fields
            partner_assigned_user_id: partner_assignment?.sales_rep_id || null,
            partner_assigned_user_email: partner_assignment?.sales_rep_email || null,
            partner_assigned_user_name: partner_assignment?.sales_rep_name || null,
          })
          .select()
          .single();

        if (createError) {
          console.error('Error creating claim:', createError);
          throw createError;
        }

        claimId = newClaim.id;

        // Create the linked_claims record
        const { error: linkError } = await supabase
          .from('linked_claims')
          .insert({
            claim_id: claimId,
            external_instance_url: source_instance_url,
            external_claim_id: external_claim_id,
            instance_name: claim_data.instance_name || 'External Instance',
            sync_status: 'synced',
            last_synced_at: new Date().toISOString(),
          });

        if (linkError) {
          console.error('Error creating link:', linkError);
          throw linkError;
        }
      }

      // Update sync status
      await supabase
        .from('linked_claims')
        .update({ 
          sync_status: 'synced', 
          last_synced_at: new Date().toISOString() 
        })
        .eq('external_instance_url', source_instance_url)
        .eq('external_claim_id', external_claim_id);

      // Sync tasks
      if (tasks_data && tasks_data.length > 0) {
        console.log(`Syncing ${tasks_data.length} tasks`);
        for (const task of tasks_data) {
          // Check if task already exists by title and claim
          const { data: existingTask } = await supabase
            .from('tasks')
            .select('id')
            .eq('claim_id', claimId)
            .eq('title', task.title)
            .maybeSingle();

          if (!existingTask) {
            await supabase.from('tasks').insert({
              claim_id: claimId,
              title: task.title,
              description: task.description,
              status: task.status,
              priority: task.priority,
              due_date: task.due_date,
              completed_at: task.completed_at,
            });
          } else {
            // Update existing task
            await supabase.from('tasks').update({
              description: task.description,
              status: task.status,
              priority: task.priority,
              due_date: task.due_date,
              completed_at: task.completed_at,
            }).eq('id', existingTask.id);
          }
        }
      }

      // Sync notes/updates
      if (updates_data && updates_data.length > 0) {
        console.log(`Syncing ${updates_data.length} updates`);
        for (const update of updates_data) {
          // Check if update already exists by content and timestamp
          const { data: existingUpdate } = await supabase
            .from('claim_updates')
            .select('id')
            .eq('claim_id', claimId)
            .eq('content', update.content)
            .maybeSingle();

          if (!existingUpdate) {
            await supabase.from('claim_updates').insert({
              claim_id: claimId,
              content: update.content,
              update_type: update.update_type,
              recipients: update.recipients,
              created_at: update.created_at,
            });
          }
        }
      }

      // Sync inspections
      if (inspections_data && inspections_data.length > 0) {
        console.log(`Syncing ${inspections_data.length} inspections`);
        for (const inspection of inspections_data) {
          const { data: existingExternalInspections, error: existingInspectionsError } = await supabase
            .from('inspections')
            .select('id, inspection_time, inspection_type, inspector_name')
            .eq('claim_id', claimId)
            .eq('inspection_date', inspection.inspection_date)
            .is('created_by', null);

          if (existingInspectionsError) {
            throw existingInspectionsError;
          }

          const existingInspection = findMatchingExternalInspection(existingExternalInspections || [], inspection);

          if (!existingInspection) {
            await supabase.from('inspections').insert({
              claim_id: claimId,
              inspection_date: inspection.inspection_date,
              inspection_time: inspection.inspection_time,
              inspection_type: inspection.inspection_type,
              inspector_name: inspection.inspector_name,
              status: inspection.status,
              notes: inspection.notes,
            });
          } else {
            await supabase.from('inspections').update({
              inspection_time: inspection.inspection_time,
              inspection_type: inspection.inspection_type,
              inspector_name: inspection.inspector_name,
              status: inspection.status,
              notes: inspection.notes,
            }).eq('id', existingInspection.id);
          }
        }
      }

      // Sync adjusters
      if (adjusters_data && adjusters_data.length > 0) {
        console.log(`Syncing ${adjusters_data.length} adjusters`);
        for (const adjuster of adjusters_data) {
          const { data: existingAdjuster } = await supabase
            .from('claim_adjusters')
            .select('id')
            .eq('claim_id', claimId)
            .eq('adjuster_name', adjuster.adjuster_name)
            .maybeSingle();

          if (!existingAdjuster) {
            await supabase.from('claim_adjusters').insert({
              claim_id: claimId,
              adjuster_name: adjuster.adjuster_name,
              adjuster_email: adjuster.adjuster_email,
              adjuster_phone: adjuster.adjuster_phone,
              company: adjuster.company,
              is_primary: adjuster.is_primary,
              notes: adjuster.notes,
            });
          } else {
            await supabase.from('claim_adjusters').update({
              adjuster_email: adjuster.adjuster_email,
              adjuster_phone: adjuster.adjuster_phone,
              company: adjuster.company,
              is_primary: adjuster.is_primary,
              notes: adjuster.notes,
            }).eq('id', existingAdjuster.id);
          }
        }
      }

      // Sync accounting data
      if (accounting_data) {
        console.log('Syncing accounting data');
        
        // Sync settlements
        if (accounting_data.settlements && accounting_data.settlements.length > 0) {
          for (const settlement of accounting_data.settlements) {
            await supabase
              .from('claim_settlements')
              .upsert({
                claim_id: claimId,
                replacement_cost_value: settlement.replacement_cost_value,
                recoverable_depreciation: settlement.recoverable_depreciation,
                non_recoverable_depreciation: settlement.non_recoverable_depreciation,
                deductible: settlement.deductible,
                estimate_amount: settlement.estimate_amount,
                total_settlement: settlement.total_settlement,
                other_structures_rcv: settlement.other_structures_rcv,
                other_structures_recoverable_depreciation: settlement.other_structures_recoverable_depreciation,
                other_structures_non_recoverable_depreciation: settlement.other_structures_non_recoverable_depreciation,
                other_structures_deductible: settlement.other_structures_deductible,
                pwi_rcv: settlement.pwi_rcv,
                pwi_recoverable_depreciation: settlement.pwi_recoverable_depreciation,
                pwi_non_recoverable_depreciation: settlement.pwi_non_recoverable_depreciation,
                pwi_deductible: settlement.pwi_deductible,
                prior_offer: settlement.prior_offer,
                notes: settlement.notes,
              }, { onConflict: 'claim_id' });
          }
        }

        // Sync checks
        if (accounting_data.checks && accounting_data.checks.length > 0) {
          for (const check of accounting_data.checks) {
            const { data: existingCheck } = await supabase
              .from('claim_checks')
              .select('id')
              .eq('claim_id', claimId)
              .eq('check_number', check.check_number)
              .maybeSingle();

            if (!existingCheck) {
              await supabase.from('claim_checks').insert({
                claim_id: claimId,
                check_number: check.check_number,
                check_type: check.check_type,
                amount: check.amount,
                check_date: check.check_date,
                received_date: check.received_date,
                notes: check.notes,
              });
            } else {
              await supabase.from('claim_checks').update({
                check_type: check.check_type,
                amount: check.amount,
                check_date: check.check_date,
                received_date: check.received_date,
                notes: check.notes,
              }).eq('id', existingCheck.id);
            }
          }
        }

        // Sync expenses
        if (accounting_data.expenses && accounting_data.expenses.length > 0) {
          for (const expense of accounting_data.expenses) {
            const { data: existingExpense } = await supabase
              .from('claim_expenses')
              .select('id')
              .eq('claim_id', claimId)
              .eq('description', expense.description)
              .eq('expense_date', expense.expense_date)
              .maybeSingle();

            if (!existingExpense) {
              await supabase.from('claim_expenses').insert({
                claim_id: claimId,
                description: expense.description,
                amount: expense.amount,
                expense_date: expense.expense_date,
                category: expense.category,
                paid_to: expense.paid_to,
                payment_method: expense.payment_method,
                notes: expense.notes,
              });
            }
          }
        }

        // Sync fees
        if (accounting_data.fees && accounting_data.fees.length > 0) {
          for (const fee of accounting_data.fees) {
            await supabase
              .from('claim_fees')
              .upsert({
                claim_id: claimId,
                company_fee_percentage: fee.company_fee_percentage,
                company_fee_amount: fee.company_fee_amount,
                adjuster_fee_percentage: fee.adjuster_fee_percentage,
                adjuster_fee_amount: fee.adjuster_fee_amount,
                contractor_fee_percentage: fee.contractor_fee_percentage,
                contractor_fee_amount: fee.contractor_fee_amount,
                referrer_fee_percentage: fee.referrer_fee_percentage,
                referrer_fee_amount: fee.referrer_fee_amount,
                notes: fee.notes,
              }, { onConflict: 'claim_id' });
          }
        }

        // Sync payments - convert released payments to received on this side
        if (accounting_data.payments && accounting_data.payments.length > 0) {
          console.log(`Syncing ${accounting_data.payments.length} payments as received`);
          for (const payment of accounting_data.payments) {
            // Check if payment already exists by amount and date
            const { data: existingPayment } = await supabase
              .from('claim_payments')
              .select('id')
              .eq('claim_id', claimId)
              .eq('amount', payment.amount)
              .eq('payment_date', payment.payment_date)
              .eq('direction', 'received')
              .maybeSingle();

            if (!existingPayment) {
              await supabase.from('claim_payments').insert({
                claim_id: claimId,
                amount: payment.amount,
                payment_date: payment.payment_date,
                payment_method: payment.payment_method,
                check_number: payment.check_number,
                recipient_type: payment.recipient_type,
                notes: payment.notes ? `[Synced] ${payment.notes}` : '[Synced from workspace]',
                direction: 'received', // Mark as received on this side
              });
            }
          }
        }
      }

      // Sync files - download from signed URLs
      if (files_data && files_data.length > 0) {
        console.log(`Syncing ${files_data.length} files`);
        for (const file of files_data) {
          try {
            const { data: existingFile } = await supabase
              .from('claim_files')
              .select('id')
              .eq('claim_id', claimId)
              .eq('file_name', file.file_name)
              .maybeSingle();

            if (!existingFile) {
              let newFilePath = file.file_path;
              
              // Download from signed URL if provided
              if (file.signed_url) {
                try {
                  const response = await fetch(file.signed_url);
                  if (response.ok) {
                    const blob = await response.blob();
                    const arrayBuffer = await blob.arrayBuffer();
                    const bytes = new Uint8Array(arrayBuffer);
                    
                    newFilePath = `${claimId}/${Date.now()}-${file.file_name}`;
                    
                    const { error: uploadError } = await supabase.storage
                      .from('claim-files')
                      .upload(newFilePath, bytes, {
                        contentType: blob.type || file.file_type || 'application/octet-stream',
                        upsert: true,
                      });
                    
                    if (uploadError) {
                      console.error(`Failed to upload file ${file.file_name}:`, uploadError);
                      newFilePath = file.file_path;
                    } else {
                      console.log(`Uploaded file: ${file.file_name} to ${newFilePath}`);
                    }
                  } else {
                    console.error(`Failed to download file from URL: ${response.status}`);
                  }
                } catch (err) {
                  console.error(`Error downloading file ${file.file_name}:`, err);
                }
              }
              
              await supabase.from('claim_files').insert({
                claim_id: claimId,
                file_name: file.file_name,
                file_path: newFilePath,
                file_type: file.file_type,
                file_size: file.file_size,
              });
            }
          } catch (err) {
            console.error(`Error syncing file ${file.file_name}:`, err);
          }
        }
      }

      // Sync photos - download from signed URLs
      if (photos_data && photos_data.length > 0) {
        console.log(`Syncing ${photos_data.length} photos`);
        for (const photo of photos_data) {
          try {
            const { data: existingPhoto } = await supabase
              .from('claim_photos')
              .select('id')
              .eq('claim_id', claimId)
              .eq('file_name', photo.file_name)
              .maybeSingle();

            if (!existingPhoto) {
              let newFilePath = photo.file_path;
              
              // Download from signed URL if provided
              if (photo.signed_url) {
                try {
                  const response = await fetch(photo.signed_url);
                  if (response.ok) {
                    const blob = await response.blob();
                    const arrayBuffer = await blob.arrayBuffer();
                    const bytes = new Uint8Array(arrayBuffer);
                    
                    newFilePath = `${claimId}/photos/${Date.now()}-${photo.file_name}`;
                    
                    const { error: uploadError } = await supabase.storage
                      .from('claim-files')
                      .upload(newFilePath, bytes, {
                        contentType: blob.type || 'image/jpeg',
                        upsert: true,
                      });
                    
                    if (uploadError) {
                      console.error(`Failed to upload photo ${photo.file_name}:`, uploadError);
                      newFilePath = photo.file_path;
                    } else {
                      console.log(`Uploaded photo: ${photo.file_name} to ${newFilePath}`);
                    }
                  } else {
                    console.error(`Failed to download photo from URL: ${response.status}`);
                  }
                } catch (err) {
                  console.error(`Error downloading photo ${photo.file_name}:`, err);
                }
              }
              
              await supabase.from('claim_photos').insert({
                claim_id: claimId,
                file_name: photo.file_name,
                file_path: newFilePath,
                description: photo.description,
                category: photo.category,
                file_size: photo.file_size,
              });
            }
          } catch (err) {
            console.error(`Error syncing photo ${photo.file_name}:`, err);
          }
        }
      }

      // Sync emails
      if (emails_data && emails_data.length > 0) {
        console.log(`Syncing ${emails_data.length} emails`);
        for (const email of emails_data) {
          const { data: existingEmail } = await supabase
            .from('emails')
            .select('id')
            .eq('claim_id', claimId)
            .eq('subject', email.subject)
            .eq('recipient_email', email.recipient_email)
            .maybeSingle();

          if (!existingEmail) {
            await supabase.from('emails').insert({
              claim_id: claimId,
              subject: email.subject,
              body: email.body,
              recipient_email: email.recipient_email,
              recipient_name: email.recipient_name,
              recipient_type: email.recipient_type,
              sent_at: email.sent_at,
            });
          }
        }
      }

      // Log activity
      await supabase
        .from('claim_updates')
        .insert({
          claim_id: claimId,
          content: `Claim fully synced from ${claim_data.instance_name || source_instance_url} (tasks: ${tasks_data?.length || 0}, updates: ${updates_data?.length || 0}, inspections: ${inspections_data?.length || 0})`,
          update_type: 'sync',
        });

      console.log(`Successfully synced claim ${claimId} with all related data`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          claim_id: claimId,
          message: existingLink ? 'Claim updated' : 'Claim created',
          synced: {
            tasks: tasks_data?.length || 0,
            updates: updates_data?.length || 0,
            inspections: inspections_data?.length || 0,
            adjusters: adjusters_data?.length || 0,
            files: files_data?.length || 0,
            photos: photos_data?.length || 0,
            emails: emails_data?.length || 0,
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Unknown action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('Sync webhook error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
