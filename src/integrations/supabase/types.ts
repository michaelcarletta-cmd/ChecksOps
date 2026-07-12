export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ach_authorizations: {
        Row: {
          authorized_by: string
          authorized_name: string
          created_at: string
          form_text: string
          id: string
          ip_address: string | null
          is_active: boolean
          revoke_reason: string | null
          revoked_at: string | null
          revoked_by: string | null
          stakeholder_account_id: string
          tenant_id: string
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          authorized_by: string
          authorized_name: string
          created_at?: string
          form_text: string
          id?: string
          ip_address?: string | null
          is_active?: boolean
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          stakeholder_account_id: string
          tenant_id: string
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          authorized_by?: string
          authorized_name?: string
          created_at?: string
          form_text?: string
          id?: string
          ip_address?: string | null
          is_active?: boolean
          revoke_reason?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          stakeholder_account_id?: string
          tenant_id?: string
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ach_authorizations_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ach_authorizations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      actum_transactions: {
        Row: {
          actum_history_id: string | null
          actum_order_id: string | null
          amount: number
          auth_code: string | null
          batch_id: string | null
          consumer_unique: string | null
          created_at: string
          id: string
          idempotence_key: string | null
          mer_order_number: string | null
          raw_response: Json | null
          response_reason: string | null
          split_id: string | null
          status: string
          tenant_id: string
          transaction_type: string
          updated_at: string
        }
        Insert: {
          actum_history_id?: string | null
          actum_order_id?: string | null
          amount: number
          auth_code?: string | null
          batch_id?: string | null
          consumer_unique?: string | null
          created_at?: string
          id?: string
          idempotence_key?: string | null
          mer_order_number?: string | null
          raw_response?: Json | null
          response_reason?: string | null
          split_id?: string | null
          status?: string
          tenant_id: string
          transaction_type?: string
          updated_at?: string
        }
        Update: {
          actum_history_id?: string | null
          actum_order_id?: string | null
          amount?: number
          auth_code?: string | null
          batch_id?: string | null
          consumer_unique?: string | null
          created_at?: string
          id?: string
          idempotence_key?: string | null
          mer_order_number?: string | null
          raw_response?: Json | null
          response_reason?: string | null
          split_id?: string | null
          status?: string
          tenant_id?: string
          transaction_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "actum_transactions_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "disbursement_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actum_transactions_split_id_fkey"
            columns: ["split_id"]
            isOneToOne: false
            referencedRelation: "disbursement_splits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "actum_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      adjusters: {
        Row: {
          company: string | null
          created_at: string | null
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean | null
          name: string
          notes: string | null
          phone: string | null
          phone_extension: string | null
          updated_at: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string | null
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          notes?: string | null
          phone?: string | null
          phone_extension?: string | null
          updated_at?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string | null
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          notes?: string | null
          phone?: string | null
          phone_extension?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ai_generated_tasks: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          claim_id: string
          created_at: string
          dismissed_reason: string | null
          generation_reason: string
          id: string
          is_approved: boolean | null
          is_dismissed: boolean | null
          source_analysis_type: string | null
          suggested_assignee_id: string | null
          suggested_description: string | null
          suggested_due_date: string | null
          suggested_priority: string | null
          suggested_title: string
          task_id: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          claim_id: string
          created_at?: string
          dismissed_reason?: string | null
          generation_reason: string
          id?: string
          is_approved?: boolean | null
          is_dismissed?: boolean | null
          source_analysis_type?: string | null
          suggested_assignee_id?: string | null
          suggested_description?: string | null
          suggested_due_date?: string | null
          suggested_priority?: string | null
          suggested_title: string
          task_id?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          claim_id?: string
          created_at?: string
          dismissed_reason?: string | null
          generation_reason?: string
          id?: string
          is_approved?: boolean | null
          is_dismissed?: boolean | null
          source_analysis_type?: string | null
          suggested_assignee_id?: string | null
          suggested_description?: string | null
          suggested_due_date?: string | null
          suggested_priority?: string | null
          suggested_title?: string
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_generated_tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "ai_generated_tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "ai_generated_tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_generated_tasks_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_documents: {
        Row: {
          category: string
          created_at: string
          description: string | null
          error_message: string | null
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string
          id: string
          status: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          category: string
          created_at?: string
          description?: string | null
          error_message?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          file_type: string
          id?: string
          status?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          error_message?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string
          id?: string
          status?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      ai_response_cache: {
        Row: {
          cache_key: string
          claim_id: string
          created_at: string
          expires_at: string
          hits: number
          model: string
          payload: Json
          prompt_hash: string
          search_mode: string
          task: string
        }
        Insert: {
          cache_key: string
          claim_id?: string
          created_at?: string
          expires_at?: string
          hits?: number
          model: string
          payload: Json
          prompt_hash: string
          search_mode?: string
          task: string
        }
        Update: {
          cache_key?: string
          claim_id?: string
          created_at?: string
          expires_at?: string
          hits?: number
          model?: string
          payload?: Json
          prompt_hash?: string
          search_mode?: string
          task?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          id: string
          ip_address: string | null
          metadata: Json | null
          new_values: Json | null
          old_values: Json | null
          record_id: string | null
          record_type: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          new_values?: Json | null
          old_values?: Json | null
          record_id?: string | null
          record_type: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          new_values?: Json | null
          old_values?: Json | null
          record_id?: string | null
          record_type?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      automation_executions: {
        Row: {
          automation_id: string
          claim_id: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          result: Json | null
          started_at: string | null
          status: string
          trigger_data: Json | null
        }
        Insert: {
          automation_id: string
          claim_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          result?: Json | null
          started_at?: string | null
          status?: string
          trigger_data?: Json | null
        }
        Update: {
          automation_id?: string
          claim_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          result?: Json | null
          started_at?: string | null
          status?: string
          trigger_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_executions_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_executions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "automation_executions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "automation_executions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      automations: {
        Row: {
          actions: Json
          conditions: Json | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          trigger_config: Json
          trigger_type: string
          updated_at: string
        }
        Insert: {
          actions?: Json
          conditions?: Json | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          trigger_config?: Json
          trigger_type: string
          updated_at?: string
        }
        Update: {
          actions?: Json
          conditions?: Json | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          trigger_config?: Json
          trigger_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      autopilot_action_feedback: {
        Row: {
          action_summary: string
          action_type: string
          claim_id: string
          confidence: string
          created_at: string
          id: string
          priority_score: number | null
          user_action: string
          user_id: string | null
        }
        Insert: {
          action_summary: string
          action_type: string
          claim_id: string
          confidence?: string
          created_at?: string
          id?: string
          priority_score?: number | null
          user_action: string
          user_id?: string | null
        }
        Update: {
          action_summary?: string
          action_type?: string
          claim_id?: string
          confidence?: string
          created_at?: string
          id?: string
          priority_score?: number | null
          user_action?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "autopilot_action_feedback_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "autopilot_action_feedback_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "autopilot_action_feedback_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      autopilot_model_snapshot: {
        Row: {
          confidence_adjustments: Json
          created_at: string
          drift_analytics_summary: Json
          escalation_governance: Json
          health_parameters: Json
          id: string
          notes: string | null
          resistance_thresholds: Json
          scoring_weights: Json
          snapshot_date: string
          snapshot_type: string
        }
        Insert: {
          confidence_adjustments?: Json
          created_at?: string
          drift_analytics_summary?: Json
          escalation_governance?: Json
          health_parameters?: Json
          id?: string
          notes?: string | null
          resistance_thresholds?: Json
          scoring_weights?: Json
          snapshot_date?: string
          snapshot_type?: string
        }
        Update: {
          confidence_adjustments?: Json
          created_at?: string
          drift_analytics_summary?: Json
          escalation_governance?: Json
          health_parameters?: Json
          id?: string
          notes?: string | null
          resistance_thresholds?: Json
          scoring_weights?: Json
          snapshot_date?: string
          snapshot_type?: string
        }
        Relationships: []
      }
      bank_balance: {
        Row: {
          balance: number
          business_loans: number
          id: string
          updated_at: string
        }
        Insert: {
          balance?: number
          business_loans?: number
          id?: string
          updated_at?: string
        }
        Update: {
          balance?: number
          business_loans?: number
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      building_code_citations: {
        Row: {
          code_source: string
          code_year: string
          content: string
          created_at: string
          id: string
          keywords: string[] | null
          section_number: string
          section_title: string | null
          state_adoptions: string[] | null
          updated_at: string
        }
        Insert: {
          code_source: string
          code_year: string
          content: string
          created_at?: string
          id?: string
          keywords?: string[] | null
          section_number: string
          section_title?: string | null
          state_adoptions?: string[] | null
          updated_at?: string
        }
        Update: {
          code_source?: string
          code_year?: string
          content?: string
          created_at?: string
          id?: string
          keywords?: string[] | null
          section_number?: string
          section_title?: string | null
          state_adoptions?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      building_footprint_ingestion_logs: {
        Row: {
          completed_at: string | null
          config: Json | null
          created_by: string | null
          error_count: number | null
          errors: Json | null
          fetched_count: number | null
          id: string
          inserted_count: number | null
          parsed_count: number | null
          skipped_count: number | null
          source: string
          started_at: string
          state: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          config?: Json | null
          created_by?: string | null
          error_count?: number | null
          errors?: Json | null
          fetched_count?: number | null
          id?: string
          inserted_count?: number | null
          parsed_count?: number | null
          skipped_count?: number | null
          source?: string
          started_at?: string
          state: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          config?: Json | null
          created_by?: string | null
          error_count?: number | null
          errors?: Json | null
          fetched_count?: number | null
          id?: string
          inserted_count?: number | null
          parsed_count?: number | null
          skipped_count?: number | null
          source?: string
          started_at?: string
          state?: string
          status?: string
        }
        Relationships: []
      }
      building_footprints: {
        Row: {
          area_sqft: number
          bbox: Json | null
          centroid_lat: number
          centroid_lng: number
          created_at: string
          geometry: unknown
          id: string
          source: string
          source_id: string | null
          state: string
          updated_at: string
          vertex_count: number | null
        }
        Insert: {
          area_sqft: number
          bbox?: Json | null
          centroid_lat: number
          centroid_lng: number
          created_at?: string
          geometry: unknown
          id?: string
          source?: string
          source_id?: string | null
          state: string
          updated_at?: string
          vertex_count?: number | null
        }
        Update: {
          area_sqft?: number
          bbox?: Json | null
          centroid_lat?: number
          centroid_lng?: number
          created_at?: string
          geometry?: unknown
          id?: string
          source?: string
          source_id?: string | null
          state?: string
          updated_at?: string
          vertex_count?: number | null
        }
        Relationships: []
      }
      carrier_argument_queue: {
        Row: {
          claim_id: string
          created_at: string
          error_message: string | null
          extracted_text: string
          file_id: string | null
          file_name: string | null
          id: string
          processed_at: string | null
          status: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          error_message?: string | null
          extracted_text: string
          file_id?: string | null
          file_name?: string | null
          id?: string
          processed_at?: string | null
          status?: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          error_message?: string | null
          extracted_text?: string
          file_id?: string | null
          file_name?: string | null
          id?: string
          processed_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "carrier_argument_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "carrier_argument_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "carrier_argument_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "carrier_argument_queue_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      carrier_argument_rebuttals: {
        Row: {
          argument_type: string
          carrier_position: string
          carrier_ready_paragraph: string
          citations: Json
          claim_id: string
          collateral_hits: string | null
          confidence: number | null
          created_at: string
          damage_mechanism: string | null
          documentation_checklist: Json
          exclusion_invoked: string | null
          expert_support: string | null
          id: string
          loss_trigger: string | null
          needs_review: boolean | null
          pattern_notes: string | null
          principle: string
          source_file_id: string | null
          source_file_name: string | null
          storm_date: string | null
          updated_at: string
          warranty_scope: string | null
          what_proves_damage: string
          why_different: string
        }
        Insert: {
          argument_type: string
          carrier_position: string
          carrier_ready_paragraph: string
          citations?: Json
          claim_id: string
          collateral_hits?: string | null
          confidence?: number | null
          created_at?: string
          damage_mechanism?: string | null
          documentation_checklist?: Json
          exclusion_invoked?: string | null
          expert_support?: string | null
          id?: string
          loss_trigger?: string | null
          needs_review?: boolean | null
          pattern_notes?: string | null
          principle: string
          source_file_id?: string | null
          source_file_name?: string | null
          storm_date?: string | null
          updated_at?: string
          warranty_scope?: string | null
          what_proves_damage: string
          why_different: string
        }
        Update: {
          argument_type?: string
          carrier_position?: string
          carrier_ready_paragraph?: string
          citations?: Json
          claim_id?: string
          collateral_hits?: string | null
          confidence?: number | null
          created_at?: string
          damage_mechanism?: string | null
          documentation_checklist?: Json
          exclusion_invoked?: string | null
          expert_support?: string | null
          id?: string
          loss_trigger?: string | null
          needs_review?: boolean | null
          pattern_notes?: string | null
          principle?: string
          source_file_id?: string | null
          source_file_name?: string | null
          storm_date?: string | null
          updated_at?: string
          warranty_scope?: string | null
          what_proves_damage?: string
          why_different?: string
        }
        Relationships: [
          {
            foreignKeyName: "carrier_argument_rebuttals_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "carrier_argument_rebuttals_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "carrier_argument_rebuttals_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "carrier_argument_rebuttals_source_file_id_fkey"
            columns: ["source_file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      carrier_behavior_analytics: {
        Row: {
          avg_days_to_deny: number | null
          avg_days_to_pay: number | null
          avg_first_offer_vs_final: number | null
          carrier_name: string
          created_at: string
          id: string
          initial_denial_rate: number | null
          last_computed_at: string | null
          litigation_frequency: number | null
          most_common_denial_reasons: Json | null
          reversal_rate_after_engineer: number | null
          reversal_rate_after_supplement: number | null
          total_claims_analyzed: number | null
          updated_at: string
        }
        Insert: {
          avg_days_to_deny?: number | null
          avg_days_to_pay?: number | null
          avg_first_offer_vs_final?: number | null
          carrier_name: string
          created_at?: string
          id?: string
          initial_denial_rate?: number | null
          last_computed_at?: string | null
          litigation_frequency?: number | null
          most_common_denial_reasons?: Json | null
          reversal_rate_after_engineer?: number | null
          reversal_rate_after_supplement?: number | null
          total_claims_analyzed?: number | null
          updated_at?: string
        }
        Update: {
          avg_days_to_deny?: number | null
          avg_days_to_pay?: number | null
          avg_first_offer_vs_final?: number | null
          carrier_name?: string
          created_at?: string
          id?: string
          initial_denial_rate?: number | null
          last_computed_at?: string | null
          litigation_frequency?: number | null
          most_common_denial_reasons?: Json | null
          reversal_rate_after_engineer?: number | null
          reversal_rate_after_supplement?: number | null
          total_claims_analyzed?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      carrier_behavior_profiles: {
        Row: {
          adjuster_notes: Json | null
          avg_initial_response_days: number | null
          avg_supplement_response_days: number | null
          carrier_name: string
          common_lowball_tactics: Json | null
          counter_sequences: Json | null
          created_at: string
          escalation_effectiveness: Json | null
          first_offer_vs_final_ratio: number | null
          id: string
          last_updated: string
          preferred_communication: string | null
          recommended_approach: string | null
          supplement_approval_rate: number | null
          total_claims_tracked: number | null
          typical_denial_reasons: Json | null
        }
        Insert: {
          adjuster_notes?: Json | null
          avg_initial_response_days?: number | null
          avg_supplement_response_days?: number | null
          carrier_name: string
          common_lowball_tactics?: Json | null
          counter_sequences?: Json | null
          created_at?: string
          escalation_effectiveness?: Json | null
          first_offer_vs_final_ratio?: number | null
          id?: string
          last_updated?: string
          preferred_communication?: string | null
          recommended_approach?: string | null
          supplement_approval_rate?: number | null
          total_claims_tracked?: number | null
          typical_denial_reasons?: Json | null
        }
        Update: {
          adjuster_notes?: Json | null
          avg_initial_response_days?: number | null
          avg_supplement_response_days?: number | null
          carrier_name?: string
          common_lowball_tactics?: Json | null
          counter_sequences?: Json | null
          created_at?: string
          escalation_effectiveness?: Json | null
          first_offer_vs_final_ratio?: number | null
          id?: string
          last_updated?: string
          preferred_communication?: string | null
          recommended_approach?: string | null
          supplement_approval_rate?: number | null
          total_claims_tracked?: number | null
          typical_denial_reasons?: Json | null
        }
        Relationships: []
      }
      carrier_playbooks: {
        Row: {
          action_type: string | null
          carrier_name: string
          created_at: string | null
          id: string
          is_active: boolean | null
          priority: number | null
          recommended_action: string
          sample_size: number | null
          state_code: string | null
          success_rate: number | null
          trigger_condition: Json
          updated_at: string | null
        }
        Insert: {
          action_type?: string | null
          carrier_name: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          priority?: number | null
          recommended_action: string
          sample_size?: number | null
          state_code?: string | null
          success_rate?: number | null
          trigger_condition: Json
          updated_at?: string | null
        }
        Update: {
          action_type?: string | null
          carrier_name?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          priority?: number | null
          recommended_action?: string
          sample_size?: number | null
          state_code?: string | null
          success_rate?: number | null
          trigger_condition?: Json
          updated_at?: string | null
        }
        Relationships: []
      }
      carrier_scenario_playbooks: {
        Row: {
          avg_indemnity_delta: number | null
          avg_time_to_resolution_days: number | null
          carrier: string
          confidence_label: string | null
          confidence_score: number | null
          created_at: string
          decision_type: string | null
          denial_rationale: string | null
          id: string
          last_updated_at: string | null
          loss_type: string | null
          policy_form: string | null
          sample_size_recent_12mo: number | null
          sample_size_total: number | null
          scenario_key: string
          state_code: string | null
          top_resolution_paths: Json | null
          trade: string | null
          win_rate: number | null
        }
        Insert: {
          avg_indemnity_delta?: number | null
          avg_time_to_resolution_days?: number | null
          carrier: string
          confidence_label?: string | null
          confidence_score?: number | null
          created_at?: string
          decision_type?: string | null
          denial_rationale?: string | null
          id?: string
          last_updated_at?: string | null
          loss_type?: string | null
          policy_form?: string | null
          sample_size_recent_12mo?: number | null
          sample_size_total?: number | null
          scenario_key: string
          state_code?: string | null
          top_resolution_paths?: Json | null
          trade?: string | null
          win_rate?: number | null
        }
        Update: {
          avg_indemnity_delta?: number | null
          avg_time_to_resolution_days?: number | null
          carrier?: string
          confidence_label?: string | null
          confidence_score?: number | null
          created_at?: string
          decision_type?: string | null
          denial_rationale?: string | null
          id?: string
          last_updated_at?: string | null
          loss_type?: string | null
          policy_form?: string | null
          sample_size_recent_12mo?: number | null
          sample_size_total?: number | null
          scenario_key?: string
          state_code?: string | null
          top_resolution_paths?: Json | null
          trade?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      carrier_scenario_tactics: {
        Row: {
          created_at: string
          id: string
          last_updated_at: string | null
          median_delta_when_present: number | null
          recency_weighted_score: number | null
          scenario_key: string
          success_lift: number | null
          support_count: number | null
          tactic_name: string
          tactic_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_updated_at?: string | null
          median_delta_when_present?: number | null
          recency_weighted_score?: number | null
          scenario_key: string
          success_lift?: number | null
          support_count?: number | null
          tactic_name: string
          tactic_type: string
        }
        Update: {
          created_at?: string
          id?: string
          last_updated_at?: string | null
          median_delta_when_present?: number | null
          recency_weighted_score?: number | null
          scenario_key?: string
          success_lift?: number | null
          support_count?: number | null
          tactic_name?: string
          tactic_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "carrier_scenario_tactics_scenario_key_fkey"
            columns: ["scenario_key"]
            isOneToOne: false
            referencedRelation: "carrier_scenario_playbooks"
            referencedColumns: ["scenario_key"]
          },
        ]
      }
      cash_flow_forecast: {
        Row: {
          avg_payment_velocity: number | null
          avg_resistance_score: number | null
          created_at: string
          expected_30d_recovery: number | null
          expected_60d_recovery: number | null
          expected_90d_exposure: number | null
          forecast_date: string
          id: string
          methodology_notes: string | null
          total_claims_active: number | null
          total_outstanding_gap: number | null
        }
        Insert: {
          avg_payment_velocity?: number | null
          avg_resistance_score?: number | null
          created_at?: string
          expected_30d_recovery?: number | null
          expected_60d_recovery?: number | null
          expected_90d_exposure?: number | null
          forecast_date?: string
          id?: string
          methodology_notes?: string | null
          total_claims_active?: number | null
          total_outstanding_gap?: number | null
        }
        Update: {
          avg_payment_velocity?: number | null
          avg_resistance_score?: number | null
          created_at?: string
          expected_30d_recovery?: number | null
          expected_60d_recovery?: number | null
          expected_90d_exposure?: number | null
          forecast_date?: string
          id?: string
          methodology_notes?: string | null
          total_claims_active?: number | null
          total_outstanding_gap?: number | null
        }
        Relationships: []
      }
      cash_job_attachments: {
        Row: {
          attachment_type: string | null
          cash_job_id: string
          created_at: string
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          id: string
          tenant_id: string
          uploaded_by: string
        }
        Insert: {
          attachment_type?: string | null
          cash_job_id: string
          created_at?: string
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          tenant_id: string
          uploaded_by: string
        }
        Update: {
          attachment_type?: string | null
          cash_job_id?: string
          created_at?: string
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          tenant_id?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_job_attachments_cash_job_id_fkey"
            columns: ["cash_job_id"]
            isOneToOne: false
            referencedRelation: "cash_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_job_attachments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_job_line_items: {
        Row: {
          cash_job_id: string
          created_at: string
          description: string
          id: string
          quantity: number
          sort_order: number
          tenant_id: string
          total: number | null
          unit_price: number
        }
        Insert: {
          cash_job_id: string
          created_at?: string
          description: string
          id?: string
          quantity?: number
          sort_order?: number
          tenant_id: string
          total?: number | null
          unit_price?: number
        }
        Update: {
          cash_job_id?: string
          created_at?: string
          description?: string
          id?: string
          quantity?: number
          sort_order?: number
          tenant_id?: string
          total?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "cash_job_line_items_cash_job_id_fkey"
            columns: ["cash_job_id"]
            isOneToOne: false
            referencedRelation: "cash_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_job_line_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_job_payments: {
        Row: {
          amount: number
          cash_job_id: string
          created_at: string
          created_by: string
          id: string
          notes: string | null
          payee_name: string | null
          payment_date: string
          payment_method: Database["public"]["Enums"]["cash_payment_method"]
          reference_number: string | null
          stakeholder_account_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          cash_job_id: string
          created_at?: string
          created_by: string
          id?: string
          notes?: string | null
          payee_name?: string | null
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["cash_payment_method"]
          reference_number?: string | null
          stakeholder_account_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          cash_job_id?: string
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          payee_name?: string | null
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["cash_payment_method"]
          reference_number?: string | null
          stakeholder_account_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_job_payments_cash_job_id_fkey"
            columns: ["cash_job_id"]
            isOneToOne: false
            referencedRelation: "cash_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_job_payments_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_job_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_jobs: {
        Row: {
          balance_due: number | null
          completion_date: string | null
          contract_amount: number
          created_at: string
          created_by: string
          customer_email: string | null
          customer_name: string
          customer_phone: string | null
          description: string | null
          estimate_date: string | null
          id: string
          job_name: string
          notes: string | null
          property_address: string | null
          property_city: string | null
          property_state: string | null
          property_zip: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["cash_job_status"]
          tenant_id: string
          total_paid: number
          updated_at: string
          work_type: Database["public"]["Enums"]["cash_job_work_type"]
        }
        Insert: {
          balance_due?: number | null
          completion_date?: string | null
          contract_amount?: number
          created_at?: string
          created_by: string
          customer_email?: string | null
          customer_name: string
          customer_phone?: string | null
          description?: string | null
          estimate_date?: string | null
          id?: string
          job_name: string
          notes?: string | null
          property_address?: string | null
          property_city?: string | null
          property_state?: string | null
          property_zip?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["cash_job_status"]
          tenant_id: string
          total_paid?: number
          updated_at?: string
          work_type?: Database["public"]["Enums"]["cash_job_work_type"]
        }
        Update: {
          balance_due?: number | null
          completion_date?: string | null
          contract_amount?: number
          created_at?: string
          created_by?: string
          customer_email?: string | null
          customer_name?: string
          customer_phone?: string | null
          description?: string | null
          estimate_date?: string | null
          id?: string
          job_name?: string
          notes?: string | null
          property_address?: string | null
          property_city?: string | null
          property_state?: string | null
          property_zip?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["cash_job_status"]
          tenant_id?: string
          total_paid?: number
          updated_at?: string
          work_type?: Database["public"]["Enums"]["cash_job_work_type"]
        }
        Relationships: [
          {
            foreignKeyName: "cash_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      causation_rubric_weights: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          indicator_key: string
          indicator_label: string
          is_active: boolean | null
          updated_at: string
          weight: number
        }
        Insert: {
          category: string
          created_at?: string
          description?: string | null
          id?: string
          indicator_key: string
          indicator_label: string
          is_active?: boolean | null
          updated_at?: string
          weight?: number
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          indicator_key?: string
          indicator_label?: string
          is_active?: boolean | null
          updated_at?: string
          weight?: number
        }
        Relationships: []
      }
      check_audit_log: {
        Row: {
          actor_id: string | null
          check_id: string
          created_at: string | null
          event_data: Json | null
          event_description: string | null
          event_type: string
          id: string
          tenant_id: string | null
        }
        Insert: {
          actor_id?: string | null
          check_id: string
          created_at?: string | null
          event_data?: Json | null
          event_description?: string | null
          event_type: string
          id?: string
          tenant_id?: string | null
        }
        Update: {
          actor_id?: string | null
          check_id?: string
          created_at?: string | null
          event_data?: Json | null
          event_description?: string | null
          event_type?: string
          id?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_audit_log_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_billing_config: {
        Row: {
          active: boolean
          created_at: string
          currency: string
          id: string
          price_per_check_cents: number
          stripe_meter_event_name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          currency?: string
          id?: string
          price_per_check_cents?: number
          stripe_meter_event_name?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          currency?: string
          id?: string
          price_per_check_cents?: number
          stripe_meter_event_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      check_billing_events: {
        Row: {
          billed_at: string
          check_intake_item_id: string | null
          created_at: string
          currency: string
          disbursement_split_id: string | null
          error_message: string | null
          event_type: string | null
          id: string
          reported_at: string | null
          status: string
          stripe_customer_id: string | null
          stripe_meter_event_id: string | null
          tenant_id: string
          unit_price_cents: number
          updated_at: string
        }
        Insert: {
          billed_at?: string
          check_intake_item_id?: string | null
          created_at?: string
          currency?: string
          disbursement_split_id?: string | null
          error_message?: string | null
          event_type?: string | null
          id?: string
          reported_at?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_meter_event_id?: string | null
          tenant_id: string
          unit_price_cents: number
          updated_at?: string
        }
        Update: {
          billed_at?: string
          check_intake_item_id?: string | null
          created_at?: string
          currency?: string
          disbursement_split_id?: string | null
          error_message?: string | null
          event_type?: string | null
          id?: string
          reported_at?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_meter_event_id?: string | null
          tenant_id?: string
          unit_price_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_billing_events_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_billing_events_disbursement_split_id_fkey"
            columns: ["disbursement_split_id"]
            isOneToOne: false
            referencedRelation: "disbursement_splits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_billing_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_deletion_log: {
        Row: {
          amount: number | null
          check_id: string
          check_number: string | null
          claim_id: string | null
          deleted_at: string
          deleted_by: string
          id: string
          reason: string
          snapshot: Json | null
          status: string | null
        }
        Insert: {
          amount?: number | null
          check_id: string
          check_number?: string | null
          claim_id?: string | null
          deleted_at?: string
          deleted_by: string
          id?: string
          reason: string
          snapshot?: Json | null
          status?: string | null
        }
        Update: {
          amount?: number | null
          check_id?: string
          check_number?: string | null
          claim_id?: string | null
          deleted_at?: string
          deleted_by?: string
          id?: string
          reason?: string
          snapshot?: Json | null
          status?: string | null
        }
        Relationships: []
      }
      check_eligibility_results: {
        Row: {
          check_id: string
          evaluated_at: string | null
          evaluated_by: string | null
          id: string
          reasons: Json | null
          recommendation: string
          rule_results: Json | null
        }
        Insert: {
          check_id: string
          evaluated_at?: string | null
          evaluated_by?: string | null
          id?: string
          reasons?: Json | null
          recommendation: string
          rule_results?: Json | null
        }
        Update: {
          check_id?: string
          evaluated_at?: string | null
          evaluated_by?: string | null
          id?: string
          reasons?: Json | null
          recommendation?: string
          rule_results?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "check_eligibility_results_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      check_endorsement_events: {
        Row: {
          actor_id: string | null
          check_id: string
          created_at: string | null
          event_data: Json | null
          event_type: string
          id: string
          payee_id: string | null
        }
        Insert: {
          actor_id?: string | null
          check_id: string
          created_at?: string | null
          event_data?: Json | null
          event_type: string
          id?: string
          payee_id?: string | null
        }
        Update: {
          actor_id?: string | null
          check_id?: string
          created_at?: string | null
          event_data?: Json | null
          event_type?: string
          id?: string
          payee_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_endorsement_events_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_endorsement_events_payee_id_fkey"
            columns: ["payee_id"]
            isOneToOne: false
            referencedRelation: "check_payees"
            referencedColumns: ["id"]
          },
        ]
      }
      check_endorsements: {
        Row: {
          check_id: string
          consent_text: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          id: string
          ip_address: string | null
          last_reminder_at: string | null
          loss_draft_task_created: boolean
          notes: string | null
          payee_id: string | null
          payee_name: string
          payee_type: string
          reminder_count: number
          request_sent_at: string | null
          signature_image_url: string | null
          signature_method: string | null
          signed_at: string | null
          status: string
          tenant_id: string | null
          token: string | null
          token_expires_at: string | null
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          check_id: string
          consent_text?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          last_reminder_at?: string | null
          loss_draft_task_created?: boolean
          notes?: string | null
          payee_id?: string | null
          payee_name: string
          payee_type?: string
          reminder_count?: number
          request_sent_at?: string | null
          signature_image_url?: string | null
          signature_method?: string | null
          signed_at?: string | null
          status?: string
          tenant_id?: string | null
          token?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          check_id?: string
          consent_text?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          last_reminder_at?: string | null
          loss_draft_task_created?: boolean
          notes?: string | null
          payee_id?: string | null
          payee_name?: string
          payee_type?: string
          reminder_count?: number
          request_sent_at?: string | null
          signature_image_url?: string | null
          signature_method?: string | null
          signed_at?: string | null
          status?: string
          tenant_id?: string | null
          token?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_endorsements_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_endorsements_payee_id_fkey"
            columns: ["payee_id"]
            isOneToOne: false
            referencedRelation: "check_payees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_endorsements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_files: {
        Row: {
          category: string
          check_intake_item_id: string
          created_at: string
          description: string | null
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          id: string
          signature_request_id: string | null
          source: string
          uploaded_by: string | null
        }
        Insert: {
          category?: string
          check_intake_item_id: string
          created_at?: string
          description?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          signature_request_id?: string | null
          source?: string
          uploaded_by?: string | null
        }
        Update: {
          category?: string
          check_intake_item_id?: string
          created_at?: string
          description?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          signature_request_id?: string | null
          source?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_files_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_files_signature_request_id_fkey"
            columns: ["signature_request_id"]
            isOneToOne: false
            referencedRelation: "signature_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      check_intake_items: {
        Row: {
          account_number: string | null
          amount: number | null
          back_image_path: string | null
          carrier_name: string | null
          cash_job_id: string | null
          cash_job_payment_class: string | null
          check_number: string | null
          check_source: string
          check_stage: Database["public"]["Enums"]["check_stage"]
          claim_id: string | null
          created_at: string | null
          deposit_recommendation: string | null
          deposit_recommendation_reasons: Json | null
          deposited_at: string | null
          deposited_by_tenant_id: string | null
          detected_claim_number: string | null
          endorsement_override: Json | null
          endorsement_packet_path: string | null
          expiration_days: number | null
          external_origin: Json | null
          freedom_claim_id: string | null
          freedom_claim_number: string | null
          freedom_status: string | null
          freedom_status_label: string | null
          freedom_status_updated_at: string | null
          front_image_path: string
          funds_type: string | null
          id: string
          is_multi_payee: boolean | null
          issue_date: string | null
          lead_id: string | null
          mortgage_final_released_at: string | null
          mortgage_monitoring_type: string
          mortgage_received_at: string | null
          mortgage_sent_at: string | null
          mortgage_tracking_number: string | null
          ocr_heartbeat_at: string | null
          ocr_needs_verification: boolean
          ocr_status: string | null
          pa_fee_amount: number | null
          pa_fee_pct: number | null
          partner_status: string | null
          partner_status_label: string | null
          partner_status_updated_at: string | null
          payee_address: string | null
          payee_line: string | null
          payment_classification: string | null
          property_address: string | null
          raw_ocr_back: Json | null
          raw_ocr_front: Json | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          routing_number: string | null
          status: string | null
          tenant_id: string | null
          updated_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          account_number?: string | null
          amount?: number | null
          back_image_path?: string | null
          carrier_name?: string | null
          cash_job_id?: string | null
          cash_job_payment_class?: string | null
          check_number?: string | null
          check_source?: string
          check_stage?: Database["public"]["Enums"]["check_stage"]
          claim_id?: string | null
          created_at?: string | null
          deposit_recommendation?: string | null
          deposit_recommendation_reasons?: Json | null
          deposited_at?: string | null
          deposited_by_tenant_id?: string | null
          detected_claim_number?: string | null
          endorsement_override?: Json | null
          endorsement_packet_path?: string | null
          expiration_days?: number | null
          external_origin?: Json | null
          freedom_claim_id?: string | null
          freedom_claim_number?: string | null
          freedom_status?: string | null
          freedom_status_label?: string | null
          freedom_status_updated_at?: string | null
          front_image_path: string
          funds_type?: string | null
          id?: string
          is_multi_payee?: boolean | null
          issue_date?: string | null
          lead_id?: string | null
          mortgage_final_released_at?: string | null
          mortgage_monitoring_type?: string
          mortgage_received_at?: string | null
          mortgage_sent_at?: string | null
          mortgage_tracking_number?: string | null
          ocr_heartbeat_at?: string | null
          ocr_needs_verification?: boolean
          ocr_status?: string | null
          pa_fee_amount?: number | null
          pa_fee_pct?: number | null
          partner_status?: string | null
          partner_status_label?: string | null
          partner_status_updated_at?: string | null
          payee_address?: string | null
          payee_line?: string | null
          payment_classification?: string | null
          property_address?: string | null
          raw_ocr_back?: Json | null
          raw_ocr_front?: Json | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          routing_number?: string | null
          status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          account_number?: string | null
          amount?: number | null
          back_image_path?: string | null
          carrier_name?: string | null
          cash_job_id?: string | null
          cash_job_payment_class?: string | null
          check_number?: string | null
          check_source?: string
          check_stage?: Database["public"]["Enums"]["check_stage"]
          claim_id?: string | null
          created_at?: string | null
          deposit_recommendation?: string | null
          deposit_recommendation_reasons?: Json | null
          deposited_at?: string | null
          deposited_by_tenant_id?: string | null
          detected_claim_number?: string | null
          endorsement_override?: Json | null
          endorsement_packet_path?: string | null
          expiration_days?: number | null
          external_origin?: Json | null
          freedom_claim_id?: string | null
          freedom_claim_number?: string | null
          freedom_status?: string | null
          freedom_status_label?: string | null
          freedom_status_updated_at?: string | null
          front_image_path?: string
          funds_type?: string | null
          id?: string
          is_multi_payee?: boolean | null
          issue_date?: string | null
          lead_id?: string | null
          mortgage_final_released_at?: string | null
          mortgage_monitoring_type?: string
          mortgage_received_at?: string | null
          mortgage_sent_at?: string | null
          mortgage_tracking_number?: string | null
          ocr_heartbeat_at?: string | null
          ocr_needs_verification?: boolean
          ocr_status?: string | null
          pa_fee_amount?: number | null
          pa_fee_pct?: number | null
          partner_status?: string | null
          partner_status_label?: string | null
          partner_status_updated_at?: string | null
          payee_address?: string | null
          payee_line?: string | null
          payment_classification?: string | null
          property_address?: string | null
          raw_ocr_back?: Json | null
          raw_ocr_front?: Json | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          routing_number?: string | null
          status?: string | null
          tenant_id?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_intake_items_cash_job_id_fkey"
            columns: ["cash_job_id"]
            isOneToOne: false
            referencedRelation: "cash_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_intake_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "check_intake_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "check_intake_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_intake_items_deposited_by_tenant_id_fkey"
            columns: ["deposited_by_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_intake_items_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "homeowner_intro_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_intake_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_intake_mortgage_draws: {
        Row: {
          amount: number | null
          check_id: string
          completed_at: string | null
          created_at: string
          draw_number: number
          draw_type: string
          id: string
          notes: string | null
          requested_at: string
          status: string
        }
        Insert: {
          amount?: number | null
          check_id: string
          completed_at?: string | null
          created_at?: string
          draw_number?: number
          draw_type?: string
          id?: string
          notes?: string | null
          requested_at?: string
          status?: string
        }
        Update: {
          amount?: number | null
          check_id?: string
          completed_at?: string | null
          created_at?: string
          draw_number?: number
          draw_type?: string
          id?: string
          notes?: string | null
          requested_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_intake_mortgage_draws_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      check_message_reads: {
        Row: {
          check_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          check_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          check_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_message_reads_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      check_messages: {
        Row: {
          body: string
          check_id: string
          created_at: string
          id: string
          is_deleted: boolean
          sender_id: string
          updated_at: string
        }
        Insert: {
          body: string
          check_id: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          sender_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          check_id?: string
          created_at?: string
          id?: string
          is_deleted?: boolean
          sender_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_messages_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      check_payees: {
        Row: {
          check_id: string
          contact_email: string | null
          contact_phone: string | null
          created_at: string | null
          endorsed_at: string | null
          endorsement_image_path: string | null
          endorsement_status: string | null
          endorsement_token: string | null
          endorsement_token_expires_at: string | null
          id: string
          notification_delivery_status: string | null
          notification_error: string | null
          notification_sent_at: string | null
          notification_sent_via: string | null
          payee_name: string
          payee_type: string | null
          tenant_id: string | null
          updated_at: string | null
        }
        Insert: {
          check_id: string
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          endorsed_at?: string | null
          endorsement_image_path?: string | null
          endorsement_status?: string | null
          endorsement_token?: string | null
          endorsement_token_expires_at?: string | null
          id?: string
          notification_delivery_status?: string | null
          notification_error?: string | null
          notification_sent_at?: string | null
          notification_sent_via?: string | null
          payee_name: string
          payee_type?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Update: {
          check_id?: string
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          endorsed_at?: string | null
          endorsement_image_path?: string | null
          endorsement_status?: string | null
          endorsement_token?: string | null
          endorsement_token_expires_at?: string | null
          id?: string
          notification_delivery_status?: string | null
          notification_error?: string | null
          notification_sent_at?: string | null
          notification_sent_via?: string | null
          payee_name?: string
          payee_type?: string | null
          tenant_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_payees_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_payees_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_payment_directions: {
        Row: {
          answer_notes: string | null
          answer_source: string | null
          answered_at: string | null
          check_id: string
          claim_id: string
          contractor_name: string | null
          created_at: string
          decision: string | null
          expires_at: string | null
          id: string
          request_status: string
          requested_at: string
          secure_token: string
          updated_at: string
        }
        Insert: {
          answer_notes?: string | null
          answer_source?: string | null
          answered_at?: string | null
          check_id: string
          claim_id: string
          contractor_name?: string | null
          created_at?: string
          decision?: string | null
          expires_at?: string | null
          id?: string
          request_status?: string
          requested_at?: string
          secure_token?: string
          updated_at?: string
        }
        Update: {
          answer_notes?: string | null
          answer_source?: string | null
          answered_at?: string | null
          check_id?: string
          claim_id?: string
          contractor_name?: string | null
          created_at?: string
          decision?: string | null
          expires_at?: string | null
          id?: string
          request_status?: string
          requested_at?: string
          secure_token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_payment_directions_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "claim_checks"
            referencedColumns: ["id"]
          },
        ]
      }
      check_reconciliation_alerts: {
        Row: {
          alert_type: string
          check_intake_item_id: string | null
          created_at: string
          details: Json
          id: string
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          severity: string
        }
        Insert: {
          alert_type: string
          check_intake_item_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
        }
        Update: {
          alert_type?: string
          check_intake_item_id?: string | null
          created_at?: string
          details?: Json
          id?: string
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_reconciliation_alerts_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      check_reissue_requests: {
        Row: {
          check_id: string
          created_at: string
          id: string
          notes: string | null
          reason: string
          reason_category: string
          requested_by: string
          resolved_at: string | null
          resolved_by: string | null
          status: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          check_id: string
          created_at?: string
          id?: string
          notes?: string | null
          reason: string
          reason_category?: string
          requested_by: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          check_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          reason?: string
          reason_category?: string
          requested_by?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_reissue_requests_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_reissue_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_review_decisions: {
        Row: {
          check_id: string
          confirmed_amount: number | null
          confirmed_carrier_name: string | null
          confirmed_check_number: string | null
          confirmed_payee_line: string | null
          confirmed_payees: Json | null
          created_at: string
          decision: string
          deposit_path: string
          id: string
          reviewer_id: string
          reviewer_notes: string | null
          tenant_id: string | null
        }
        Insert: {
          check_id: string
          confirmed_amount?: number | null
          confirmed_carrier_name?: string | null
          confirmed_check_number?: string | null
          confirmed_payee_line?: string | null
          confirmed_payees?: Json | null
          created_at?: string
          decision: string
          deposit_path: string
          id?: string
          reviewer_id: string
          reviewer_notes?: string | null
          tenant_id?: string | null
        }
        Update: {
          check_id?: string
          confirmed_amount?: number | null
          confirmed_carrier_name?: string | null
          confirmed_check_number?: string | null
          confirmed_payee_line?: string | null
          confirmed_payees?: Json | null
          created_at?: string
          decision?: string
          deposit_path?: string
          id?: string
          reviewer_id?: string
          reviewer_notes?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_review_decisions_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_review_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_stakeholders: {
        Row: {
          added_by: string | null
          added_via: string
          check_intake_item_id: string
          created_at: string
          id: string
          partner_tenant_id: string | null
          stakeholder_account_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          added_by?: string | null
          added_via?: string
          check_intake_item_id: string
          created_at?: string
          id?: string
          partner_tenant_id?: string | null
          stakeholder_account_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          added_by?: string | null
          added_via?: string
          check_intake_item_id?: string
          created_at?: string
          id?: string
          partner_tenant_id?: string | null
          stakeholder_account_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_stakeholders_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_stakeholders_partner_tenant_id_fkey"
            columns: ["partner_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_stakeholders_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_stakeholders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      check_status_audit: {
        Row: {
          changed_at: string
          changed_by: string | null
          check_intake_item_id: string
          from_status: string | null
          id: string
          reason: string | null
          source: string
          to_status: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          check_intake_item_id: string
          from_status?: string | null
          id?: string
          reason?: string | null
          source?: string
          to_status: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          check_intake_item_id?: string
          from_status?: string | null
          id?: string
          reason?: string | null
          source?: string
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_status_audit_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      checkalt_config: {
        Row: {
          base_url: string | null
          business_unit: string | null
          cached_jwt: string | null
          cached_jwt_expires_at: string | null
          created_at: string
          default_enabled: boolean
          depositor_account_id: string | null
          fi_key: string | null
          id: string
          merchant: string | null
          notes: string | null
          singleton: boolean
          updated_at: string
          updated_by: string | null
          webhook_secret: string | null
        }
        Insert: {
          base_url?: string | null
          business_unit?: string | null
          cached_jwt?: string | null
          cached_jwt_expires_at?: string | null
          created_at?: string
          default_enabled?: boolean
          depositor_account_id?: string | null
          fi_key?: string | null
          id?: string
          merchant?: string | null
          notes?: string | null
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
          webhook_secret?: string | null
        }
        Update: {
          base_url?: string | null
          business_unit?: string | null
          cached_jwt?: string | null
          cached_jwt_expires_at?: string | null
          created_at?: string
          default_enabled?: boolean
          depositor_account_id?: string | null
          fi_key?: string | null
          id?: string
          merchant?: string | null
          notes?: string | null
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
          webhook_secret?: string | null
        }
        Relationships: []
      }
      checkalt_deposits: {
        Row: {
          amount: number | null
          approved_at: string | null
          approved_by: string | null
          check_intake_item_id: string | null
          checkalt_reference: string | null
          claim_check_id: string | null
          cleared_at: string | null
          created_at: string
          id: string
          last_polled_at: string | null
          last_status_payload: Json | null
          reject_code: number | null
          reject_notes: string | null
          return_reason: string | null
          returned_at: string | null
          status: string
          status_unresolved: boolean
          submitted_at: string | null
          submitted_by: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          approved_at?: string | null
          approved_by?: string | null
          check_intake_item_id?: string | null
          checkalt_reference?: string | null
          claim_check_id?: string | null
          cleared_at?: string | null
          created_at?: string
          id?: string
          last_polled_at?: string | null
          last_status_payload?: Json | null
          reject_code?: number | null
          reject_notes?: string | null
          return_reason?: string | null
          returned_at?: string | null
          status?: string
          status_unresolved?: boolean
          submitted_at?: string | null
          submitted_by?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          approved_at?: string | null
          approved_by?: string | null
          check_intake_item_id?: string | null
          checkalt_reference?: string | null
          claim_check_id?: string | null
          cleared_at?: string | null
          created_at?: string
          id?: string
          last_polled_at?: string | null
          last_status_payload?: Json | null
          reject_code?: number | null
          reject_notes?: string | null
          return_reason?: string | null
          returned_at?: string | null
          status?: string
          status_unresolved?: boolean
          submitted_at?: string | null
          submitted_by?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "checkalt_deposits_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      checkalt_tenant_accounts: {
        Row: {
          created_at: string
          deposit_account_number: string
          email: string
          enabled: boolean
          first_name: string
          id: string
          last_name: string
          last_register_payload: Json | null
          registered_at: string | null
          sso_user_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deposit_account_number: string
          email: string
          enabled?: boolean
          first_name: string
          id?: string
          last_name: string
          last_register_payload?: Json | null
          registered_at?: string | null
          sso_user_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deposit_account_number?: string
          email?: string
          enabled?: boolean
          first_name?: string
          id?: string
          last_name?: string
          last_register_payload?: Json | null
          registered_at?: string | null
          sso_user_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "checkalt_tenant_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      checkalt_webhook_events: {
        Row: {
          action: string | null
          checkalt_reference: string | null
          event_type: string | null
          id: string
          idempotency_key: string | null
          process_error: string | null
          processed: boolean
          processed_at: string | null
          raw_payload: Json
          received_at: string
          severity: string | null
          signature_valid: boolean | null
        }
        Insert: {
          action?: string | null
          checkalt_reference?: string | null
          event_type?: string | null
          id?: string
          idempotency_key?: string | null
          process_error?: string | null
          processed?: boolean
          processed_at?: string | null
          raw_payload: Json
          received_at?: string
          severity?: string | null
          signature_valid?: boolean | null
        }
        Update: {
          action?: string | null
          checkalt_reference?: string | null
          event_type?: string | null
          id?: string
          idempotency_key?: string | null
          process_error?: string | null
          processed?: boolean
          processed_at?: string | null
          raw_payload?: Json
          received_at?: string
          severity?: string | null
          signature_valid?: boolean | null
        }
        Relationships: []
      }
      claim_additional_contacts: {
        Row: {
          claim_id: string
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          claim_id: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          claim_id?: string
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_additional_contacts_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_additional_contacts_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_additional_contacts_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_adjusters: {
        Row: {
          adjuster_email: string | null
          adjuster_id: string | null
          adjuster_name: string
          adjuster_phone: string | null
          claim_id: string
          company: string | null
          created_at: string | null
          created_by: string | null
          id: string
          is_primary: boolean | null
          notes: string | null
        }
        Insert: {
          adjuster_email?: string | null
          adjuster_id?: string | null
          adjuster_name: string
          adjuster_phone?: string | null
          claim_id: string
          company?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_primary?: boolean | null
          notes?: string | null
        }
        Update: {
          adjuster_email?: string | null
          adjuster_id?: string | null
          adjuster_name?: string
          adjuster_phone?: string | null
          claim_id?: string
          company?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_primary?: boolean | null
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_adjusters_adjuster_id_fkey"
            columns: ["adjuster_id"]
            isOneToOne: false
            referencedRelation: "adjusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_adjusters_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_adjusters_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_adjusters_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_ai_conversations: {
        Row: {
          claim_id: string
          confidence_score: number | null
          content: string
          created_at: string
          id: string
          needs_review: boolean | null
          role: string
          source_citations: Json | null
          user_id: string | null
        }
        Insert: {
          claim_id: string
          confidence_score?: number | null
          content: string
          created_at?: string
          id?: string
          needs_review?: boolean | null
          role: string
          source_citations?: Json | null
          user_id?: string | null
        }
        Update: {
          claim_id?: string
          confidence_score?: number | null
          content?: string
          created_at?: string
          id?: string
          needs_review?: boolean | null
          role?: string
          source_citations?: Json | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_ai_conversations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_ai_conversations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_ai_conversations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_ai_pending_actions: {
        Row: {
          action_type: string
          ai_reasoning: string | null
          auto_executed: boolean | null
          auto_executed_at: string | null
          claim_id: string
          created_at: string
          draft_content: Json
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          trigger_email_id: string | null
          updated_at: string
        }
        Insert: {
          action_type: string
          ai_reasoning?: string | null
          auto_executed?: boolean | null
          auto_executed_at?: string | null
          claim_id: string
          created_at?: string
          draft_content: Json
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          trigger_email_id?: string | null
          updated_at?: string
        }
        Update: {
          action_type?: string
          ai_reasoning?: string | null
          auto_executed?: boolean | null
          auto_executed_at?: string | null
          claim_id?: string
          created_at?: string
          draft_content?: Json
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          trigger_email_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_ai_pending_actions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_ai_pending_actions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_ai_pending_actions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_ai_pending_actions_trigger_email_id_fkey"
            columns: ["trigger_email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_argument_map: {
        Row: {
          argument_category: string | null
          argument_text: string
          argument_type: string
          carrier_position_summary: string | null
          claim_id: string
          contradictions: Json | null
          created_at: string
          evidence_gaps: Json | null
          id: string
          knowledge_base_refs: Json | null
          rebuttal_confidence: number | null
          rebuttal_strategies: Json | null
          source_file_id: string | null
          source_file_name: string | null
          status: string | null
          strength_score: number | null
          supporting_citations: Json | null
          updated_at: string
        }
        Insert: {
          argument_category?: string | null
          argument_text: string
          argument_type: string
          carrier_position_summary?: string | null
          claim_id: string
          contradictions?: Json | null
          created_at?: string
          evidence_gaps?: Json | null
          id?: string
          knowledge_base_refs?: Json | null
          rebuttal_confidence?: number | null
          rebuttal_strategies?: Json | null
          source_file_id?: string | null
          source_file_name?: string | null
          status?: string | null
          strength_score?: number | null
          supporting_citations?: Json | null
          updated_at?: string
        }
        Update: {
          argument_category?: string | null
          argument_text?: string
          argument_type?: string
          carrier_position_summary?: string | null
          claim_id?: string
          contradictions?: Json | null
          created_at?: string
          evidence_gaps?: Json | null
          id?: string
          knowledge_base_refs?: Json | null
          rebuttal_confidence?: number | null
          rebuttal_strategies?: Json | null
          source_file_id?: string | null
          source_file_name?: string | null
          status?: string | null
          strength_score?: number | null
          supporting_citations?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_argument_map_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_argument_map_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_argument_map_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_argument_map_source_file_id_fkey"
            columns: ["source_file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_automations: {
        Row: {
          auto_complete_tasks: boolean | null
          auto_escalate_urgency: boolean | null
          auto_respond_without_approval: boolean | null
          autonomy_level: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          daily_action_limit: number | null
          darwin_source_mode:
            | Database["public"]["Enums"]["darwin_source_mode"]
            | null
          follow_up_current_count: number
          follow_up_enabled: boolean
          follow_up_interval_days: number
          follow_up_last_sent_at: string | null
          follow_up_max_count: number
          follow_up_next_at: string | null
          follow_up_stop_reason: string | null
          follow_up_stopped_at: string | null
          id: string
          is_enabled: boolean
          keyword_blockers: string[] | null
          rd_check_expected_by: string | null
          rd_check_follow_up_count: number
          rd_check_last_follow_up_at: string | null
          rd_check_next_follow_up_at: string | null
          rd_check_received_at: string | null
          rd_check_released_at: string | null
          rd_check_tracking_enabled: boolean
          rd_follow_up_current_count: number
          rd_follow_up_enabled: boolean
          rd_follow_up_interval_days: number
          rd_follow_up_last_sent_at: string | null
          rd_follow_up_max_count: number
          rd_follow_up_next_at: string | null
          rd_follow_up_stop_reason: string | null
          rd_follow_up_stopped_at: string | null
          settings: Json
          updated_at: string
        }
        Insert: {
          auto_complete_tasks?: boolean | null
          auto_escalate_urgency?: boolean | null
          auto_respond_without_approval?: boolean | null
          autonomy_level?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          daily_action_limit?: number | null
          darwin_source_mode?:
            | Database["public"]["Enums"]["darwin_source_mode"]
            | null
          follow_up_current_count?: number
          follow_up_enabled?: boolean
          follow_up_interval_days?: number
          follow_up_last_sent_at?: string | null
          follow_up_max_count?: number
          follow_up_next_at?: string | null
          follow_up_stop_reason?: string | null
          follow_up_stopped_at?: string | null
          id?: string
          is_enabled?: boolean
          keyword_blockers?: string[] | null
          rd_check_expected_by?: string | null
          rd_check_follow_up_count?: number
          rd_check_last_follow_up_at?: string | null
          rd_check_next_follow_up_at?: string | null
          rd_check_received_at?: string | null
          rd_check_released_at?: string | null
          rd_check_tracking_enabled?: boolean
          rd_follow_up_current_count?: number
          rd_follow_up_enabled?: boolean
          rd_follow_up_interval_days?: number
          rd_follow_up_last_sent_at?: string | null
          rd_follow_up_max_count?: number
          rd_follow_up_next_at?: string | null
          rd_follow_up_stop_reason?: string | null
          rd_follow_up_stopped_at?: string | null
          settings?: Json
          updated_at?: string
        }
        Update: {
          auto_complete_tasks?: boolean | null
          auto_escalate_urgency?: boolean | null
          auto_respond_without_approval?: boolean | null
          autonomy_level?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          daily_action_limit?: number | null
          darwin_source_mode?:
            | Database["public"]["Enums"]["darwin_source_mode"]
            | null
          follow_up_current_count?: number
          follow_up_enabled?: boolean
          follow_up_interval_days?: number
          follow_up_last_sent_at?: string | null
          follow_up_max_count?: number
          follow_up_next_at?: string | null
          follow_up_stop_reason?: string | null
          follow_up_stopped_at?: string | null
          id?: string
          is_enabled?: boolean
          keyword_blockers?: string[] | null
          rd_check_expected_by?: string | null
          rd_check_follow_up_count?: number
          rd_check_last_follow_up_at?: string | null
          rd_check_next_follow_up_at?: string | null
          rd_check_received_at?: string | null
          rd_check_released_at?: string | null
          rd_check_tracking_enabled?: boolean
          rd_follow_up_current_count?: number
          rd_follow_up_enabled?: boolean
          rd_follow_up_interval_days?: number
          rd_follow_up_last_sent_at?: string | null
          rd_follow_up_max_count?: number
          rd_follow_up_next_at?: string | null
          rd_follow_up_stop_reason?: string | null
          rd_follow_up_stopped_at?: string | null
          settings?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_automations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_automations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_automations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_carrier_deadlines: {
        Row: {
          bad_faith_potential: boolean | null
          carrier_response_date: string | null
          carrier_response_summary: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          days_overdue: number | null
          deadline_date: string
          deadline_type: string
          extension_reason: string | null
          extension_requested: boolean | null
          id: string
          is_business_days: boolean | null
          notes: string | null
          regulation_id: string | null
          status: string | null
          trigger_date: string
          trigger_description: string
          updated_at: string
        }
        Insert: {
          bad_faith_potential?: boolean | null
          carrier_response_date?: string | null
          carrier_response_summary?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          days_overdue?: number | null
          deadline_date: string
          deadline_type: string
          extension_reason?: string | null
          extension_requested?: boolean | null
          id?: string
          is_business_days?: boolean | null
          notes?: string | null
          regulation_id?: string | null
          status?: string | null
          trigger_date: string
          trigger_description: string
          updated_at?: string
        }
        Update: {
          bad_faith_potential?: boolean | null
          carrier_response_date?: string | null
          carrier_response_summary?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          days_overdue?: number | null
          deadline_date?: string
          deadline_type?: string
          extension_reason?: string | null
          extension_requested?: boolean | null
          id?: string
          is_business_days?: boolean | null
          notes?: string | null
          regulation_id?: string | null
          status?: string | null
          trigger_date?: string
          trigger_description?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_carrier_deadlines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_carrier_deadlines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_carrier_deadlines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_carrier_deadlines_regulation_id_fkey"
            columns: ["regulation_id"]
            isOneToOne: false
            referencedRelation: "state_insurance_regulations"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_causation_tests: {
        Row: {
          alternatives_considered: Json | null
          claim_id: string
          collateral_damage: Json | null
          competing_causes: Json | null
          created_at: string
          created_by: string | null
          damage_noticed_date: string | null
          damage_type: string
          decision: string | null
          decision_statement: string | null
          directional_indicators: Json | null
          event_date: string | null
          evidence_gaps: Json | null
          id: string
          manufacturer: string | null
          observations_notes: string | null
          pattern_dispersion: string | null
          peril_tested: string
          prior_repairs: string | null
          reasoning: Json | null
          roof_age: number | null
          score_breakdown: Json | null
          shingle_type: string | null
          total_score: number | null
          updated_at: string
          weather_evidence: string | null
        }
        Insert: {
          alternatives_considered?: Json | null
          claim_id: string
          collateral_damage?: Json | null
          competing_causes?: Json | null
          created_at?: string
          created_by?: string | null
          damage_noticed_date?: string | null
          damage_type: string
          decision?: string | null
          decision_statement?: string | null
          directional_indicators?: Json | null
          event_date?: string | null
          evidence_gaps?: Json | null
          id?: string
          manufacturer?: string | null
          observations_notes?: string | null
          pattern_dispersion?: string | null
          peril_tested: string
          prior_repairs?: string | null
          reasoning?: Json | null
          roof_age?: number | null
          score_breakdown?: Json | null
          shingle_type?: string | null
          total_score?: number | null
          updated_at?: string
          weather_evidence?: string | null
        }
        Update: {
          alternatives_considered?: Json | null
          claim_id?: string
          collateral_damage?: Json | null
          competing_causes?: Json | null
          created_at?: string
          created_by?: string | null
          damage_noticed_date?: string | null
          damage_type?: string
          decision?: string | null
          decision_statement?: string | null
          directional_indicators?: Json | null
          event_date?: string | null
          evidence_gaps?: Json | null
          id?: string
          manufacturer?: string | null
          observations_notes?: string | null
          pattern_dispersion?: string | null
          peril_tested?: string
          prior_repairs?: string | null
          reasoning?: Json | null
          roof_age?: number | null
          score_breakdown?: Json | null
          shingle_type?: string | null
          total_score?: number | null
          updated_at?: string
          weather_evidence?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_causation_tests_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_causation_tests_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_causation_tests_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_check_mortgage_draws: {
        Row: {
          amount: number | null
          check_id: string
          claim_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          draw_number: number
          draw_type: string
          id: string
          notes: string | null
          requested_at: string
          status: string
          updated_at: string
        }
        Insert: {
          amount?: number | null
          check_id: string
          claim_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          draw_number?: number
          draw_type?: string
          id?: string
          notes?: string | null
          requested_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number | null
          check_id?: string
          claim_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          draw_number?: number
          draw_type?: string
          id?: string
          notes?: string | null
          requested_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_check_mortgage_draws_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "claim_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_check_mortgage_draws_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_check_mortgage_draws_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_check_mortgage_draws_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_check_payments: {
        Row: {
          actum_consumer_unique: string | null
          actum_history_id: string | null
          actum_order_id: string | null
          auth_code: string | null
          check_amount: number
          check_intake_item_id: string
          created_at: string
          disbursement_batch_id: string | null
          id: string
          idempotence_key: string | null
          notes: string | null
          pa_fee_amount: number
          pa_fee_pct: number | null
          payment_amount: number
          recipient_stakeholder_account_id: string
          recipient_tenant_id: string
          return_code: string | null
          return_desc: string | null
          returned_at: string | null
          sender_tenant_id: string
          sender_user_id: string
          settled_at: string | null
          status: string
          submitted_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          actum_consumer_unique?: string | null
          actum_history_id?: string | null
          actum_order_id?: string | null
          auth_code?: string | null
          check_amount: number
          check_intake_item_id: string
          created_at?: string
          disbursement_batch_id?: string | null
          id?: string
          idempotence_key?: string | null
          notes?: string | null
          pa_fee_amount?: number
          pa_fee_pct?: number | null
          payment_amount: number
          recipient_stakeholder_account_id: string
          recipient_tenant_id: string
          return_code?: string | null
          return_desc?: string | null
          returned_at?: string | null
          sender_tenant_id: string
          sender_user_id: string
          settled_at?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          actum_consumer_unique?: string | null
          actum_history_id?: string | null
          actum_order_id?: string | null
          auth_code?: string | null
          check_amount?: number
          check_intake_item_id?: string
          created_at?: string
          disbursement_batch_id?: string | null
          id?: string
          idempotence_key?: string | null
          notes?: string | null
          pa_fee_amount?: number
          pa_fee_pct?: number | null
          payment_amount?: number
          recipient_stakeholder_account_id?: string
          recipient_tenant_id?: string
          return_code?: string | null
          return_desc?: string | null
          returned_at?: string | null
          sender_tenant_id?: string
          sender_user_id?: string
          settled_at?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_check_payments_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_check_payments_disbursement_batch_id_fkey"
            columns: ["disbursement_batch_id"]
            isOneToOne: false
            referencedRelation: "disbursement_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_check_payments_recipient_stakeholder_account_id_fkey"
            columns: ["recipient_stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_check_payments_recipient_tenant_id_fkey"
            columns: ["recipient_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_check_payments_sender_tenant_id_fkey"
            columns: ["sender_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_check_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_checks: {
        Row: {
          account_number: string | null
          amount: number
          carrier_name: string | null
          check_date: string
          check_intake_item_id: string | null
          check_number: string | null
          check_stage: Database["public"]["Enums"]["check_stage"]
          check_type: string
          checkalt_deposit_id: string | null
          claim_id: string
          cleared_status: string | null
          created_at: string | null
          created_by: string | null
          deposit_confirmation_number: string | null
          deposit_confirmed_amount: number | null
          deposit_confirmed_at: string | null
          deposit_confirmed_by: string | null
          deposit_method: string
          deposit_status: string | null
          eligibility_status: string | null
          endorsement_status: string | null
          id: string
          mortgage_final_released_at: string | null
          mortgage_flag: boolean | null
          mortgage_monitoring_type: string | null
          mortgage_received_at: string | null
          mortgage_sent_at: string | null
          mortgage_tracking_number: string | null
          notes: string | null
          ocr_needs_verification: boolean
          payee_line: string | null
          payment_direction_status: string | null
          received_date: string | null
          routing_number: string | null
          source: string | null
          updated_at: string | null
        }
        Insert: {
          account_number?: string | null
          amount: number
          carrier_name?: string | null
          check_date: string
          check_intake_item_id?: string | null
          check_number?: string | null
          check_stage?: Database["public"]["Enums"]["check_stage"]
          check_type: string
          checkalt_deposit_id?: string | null
          claim_id: string
          cleared_status?: string | null
          created_at?: string | null
          created_by?: string | null
          deposit_confirmation_number?: string | null
          deposit_confirmed_amount?: number | null
          deposit_confirmed_at?: string | null
          deposit_confirmed_by?: string | null
          deposit_method?: string
          deposit_status?: string | null
          eligibility_status?: string | null
          endorsement_status?: string | null
          id?: string
          mortgage_final_released_at?: string | null
          mortgage_flag?: boolean | null
          mortgage_monitoring_type?: string | null
          mortgage_received_at?: string | null
          mortgage_sent_at?: string | null
          mortgage_tracking_number?: string | null
          notes?: string | null
          ocr_needs_verification?: boolean
          payee_line?: string | null
          payment_direction_status?: string | null
          received_date?: string | null
          routing_number?: string | null
          source?: string | null
          updated_at?: string | null
        }
        Update: {
          account_number?: string | null
          amount?: number
          carrier_name?: string | null
          check_date?: string
          check_intake_item_id?: string | null
          check_number?: string | null
          check_stage?: Database["public"]["Enums"]["check_stage"]
          check_type?: string
          checkalt_deposit_id?: string | null
          claim_id?: string
          cleared_status?: string | null
          created_at?: string | null
          created_by?: string | null
          deposit_confirmation_number?: string | null
          deposit_confirmed_amount?: number | null
          deposit_confirmed_at?: string | null
          deposit_confirmed_by?: string | null
          deposit_method?: string
          deposit_status?: string | null
          eligibility_status?: string | null
          endorsement_status?: string | null
          id?: string
          mortgage_final_released_at?: string | null
          mortgage_flag?: boolean | null
          mortgage_monitoring_type?: string | null
          mortgage_received_at?: string | null
          mortgage_sent_at?: string | null
          mortgage_tracking_number?: string | null
          notes?: string | null
          ocr_needs_verification?: boolean
          payee_line?: string | null
          payment_direction_status?: string | null
          received_date?: string | null
          routing_number?: string | null
          source?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_checks_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: true
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_checks_checkalt_deposit_id_fkey"
            columns: ["checkalt_deposit_id"]
            isOneToOne: false
            referencedRelation: "checkalt_deposits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_communications_diary: {
        Row: {
          claim_id: string
          communication_date: string
          communication_type: string
          contact_company: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          contact_title: string | null
          created_at: string
          created_by: string | null
          deadlines_mentioned: string | null
          direction: string
          employee_id: string | null
          follow_up_date: string | null
          follow_up_required: boolean | null
          id: string
          promises_made: string | null
          recording_file_path: string | null
          summary: string
          updated_at: string
        }
        Insert: {
          claim_id: string
          communication_date?: string
          communication_type: string
          contact_company?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contact_title?: string | null
          created_at?: string
          created_by?: string | null
          deadlines_mentioned?: string | null
          direction: string
          employee_id?: string | null
          follow_up_date?: string | null
          follow_up_required?: boolean | null
          id?: string
          promises_made?: string | null
          recording_file_path?: string | null
          summary: string
          updated_at?: string
        }
        Update: {
          claim_id?: string
          communication_date?: string
          communication_type?: string
          contact_company?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contact_title?: string | null
          created_at?: string
          created_by?: string | null
          deadlines_mentioned?: string | null
          direction?: string
          employee_id?: string | null
          follow_up_date?: string | null
          follow_up_required?: boolean | null
          id?: string
          promises_made?: string | null
          recording_file_path?: string | null
          summary?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_communications_diary_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_communications_diary_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_communications_diary_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_context_pipelines: {
        Row: {
          claim_context: Json
          claim_id: string
          created_at: string
          created_by: string | null
          estimate_result: Json | null
          id: string
          stage: string
          status: string
          updated_at: string
        }
        Insert: {
          claim_context?: Json
          claim_id: string
          created_at?: string
          created_by?: string | null
          estimate_result?: Json | null
          id?: string
          stage?: string
          status?: string
          updated_at?: string
        }
        Update: {
          claim_context?: Json
          claim_id?: string
          created_at?: string
          created_by?: string | null
          estimate_result?: Json | null
          id?: string
          stage?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_context_pipelines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_context_pipelines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_context_pipelines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_contractors: {
        Row: {
          assigned_at: string | null
          claim_id: string
          contractor_id: string
          id: string
        }
        Insert: {
          assigned_at?: string | null
          claim_id: string
          contractor_id: string
          id?: string
        }
        Update: {
          assigned_at?: string | null
          claim_id?: string
          contractor_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_contractors_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_contractors_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_contractors_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_contradiction_detections: {
        Row: {
          carrier_position_a: string | null
          carrier_position_b: string | null
          claim_id: string
          contradiction_type: string
          created_at: string
          detected_at: string
          document_a_id: string | null
          document_a_name: string | null
          document_b_id: string | null
          document_b_name: string | null
          id: string
          rebuttal_value: string | null
          severity: string
        }
        Insert: {
          carrier_position_a?: string | null
          carrier_position_b?: string | null
          claim_id: string
          contradiction_type: string
          created_at?: string
          detected_at?: string
          document_a_id?: string | null
          document_a_name?: string | null
          document_b_id?: string | null
          document_b_name?: string | null
          id?: string
          rebuttal_value?: string | null
          severity?: string
        }
        Update: {
          carrier_position_a?: string | null
          carrier_position_b?: string | null
          claim_id?: string
          contradiction_type?: string
          created_at?: string
          detected_at?: string
          document_a_id?: string | null
          document_a_name?: string | null
          document_b_id?: string | null
          document_b_name?: string | null
          id?: string
          rebuttal_value?: string | null
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_contradiction_detections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_contradiction_detections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_contradiction_detections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_custom_field_values: {
        Row: {
          claim_id: string
          created_at: string
          custom_field_id: string
          id: string
          updated_at: string
          value: string | null
        }
        Insert: {
          claim_id: string
          created_at?: string
          custom_field_id: string
          id?: string
          updated_at?: string
          value?: string | null
        }
        Update: {
          claim_id?: string
          created_at?: string
          custom_field_id?: string
          id?: string
          updated_at?: string
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_custom_field_values_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_custom_field_values_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_custom_field_values_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_custom_field_values_custom_field_id_fkey"
            columns: ["custom_field_id"]
            isOneToOne: false
            referencedRelation: "custom_fields"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_deadlines: {
        Row: {
          claim_id: string
          created_at: string
          deadline_date: string
          deadline_type: string
          id: string
          notes: string | null
          regulation_reference: string | null
          resolved_at: string | null
          state_code: string
          status: string
          triggered_at: string | null
          updated_at: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          deadline_date: string
          deadline_type: string
          id?: string
          notes?: string | null
          regulation_reference?: string | null
          resolved_at?: string | null
          state_code: string
          status?: string
          triggered_at?: string | null
          updated_at?: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          deadline_date?: string
          deadline_type?: string
          id?: string
          notes?: string | null
          regulation_reference?: string | null
          resolved_at?: string | null
          state_code?: string
          status?: string
          triggered_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_deadlines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_deadlines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_deadlines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_disbursements: {
        Row: {
          amount: number | null
          check_id: string
          claim_id: string
          created_at: string
          id: string
          method: string | null
          notes: string | null
          payment_direction_id: string | null
          recipient_name: string | null
          recipient_type: string
          status: string
          updated_at: string
        }
        Insert: {
          amount?: number | null
          check_id: string
          claim_id: string
          created_at?: string
          id?: string
          method?: string | null
          notes?: string | null
          payment_direction_id?: string | null
          recipient_name?: string | null
          recipient_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number | null
          check_id?: string
          claim_id?: string
          created_at?: string
          id?: string
          method?: string | null
          notes?: string | null
          payment_direction_id?: string | null
          recipient_name?: string | null
          recipient_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_disbursements_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "claim_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_disbursements_payment_direction_id_fkey"
            columns: ["payment_direction_id"]
            isOneToOne: false
            referencedRelation: "check_payment_directions"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_document_chunks: {
        Row: {
          carrier_name: string | null
          chunk_index: number
          cited_denial_reasons: string[] | null
          cited_policy_sections: string[] | null
          claim_id: string
          content: string
          created_at: string
          decision_type:
            | Database["public"]["Enums"]["claim_doc_decision"]
            | null
          denial_rationale: string | null
          embedding: string | null
          evidence_type:
            | Database["public"]["Enums"]["claim_doc_evidence_type"]
            | null
          file_id: string | null
          id: string
          loss_date: string | null
          loss_type: Database["public"]["Enums"]["claim_doc_loss_type"] | null
          outcome_appraisal_invoked: boolean | null
          outcome_litigation: boolean | null
          outcome_paid_amount: number | null
          outcome_reopened: boolean | null
          outcome_resolution_type: string | null
          outcome_supplement_won: boolean | null
          policy_form: string | null
          scope_decisions: Json | null
          state_code: string | null
          trade: Database["public"]["Enums"]["claim_doc_trade"] | null
          updated_at: string
        }
        Insert: {
          carrier_name?: string | null
          chunk_index: number
          cited_denial_reasons?: string[] | null
          cited_policy_sections?: string[] | null
          claim_id: string
          content: string
          created_at?: string
          decision_type?:
            | Database["public"]["Enums"]["claim_doc_decision"]
            | null
          denial_rationale?: string | null
          embedding?: string | null
          evidence_type?:
            | Database["public"]["Enums"]["claim_doc_evidence_type"]
            | null
          file_id?: string | null
          id?: string
          loss_date?: string | null
          loss_type?: Database["public"]["Enums"]["claim_doc_loss_type"] | null
          outcome_appraisal_invoked?: boolean | null
          outcome_litigation?: boolean | null
          outcome_paid_amount?: number | null
          outcome_reopened?: boolean | null
          outcome_resolution_type?: string | null
          outcome_supplement_won?: boolean | null
          policy_form?: string | null
          scope_decisions?: Json | null
          state_code?: string | null
          trade?: Database["public"]["Enums"]["claim_doc_trade"] | null
          updated_at?: string
        }
        Update: {
          carrier_name?: string | null
          chunk_index?: number
          cited_denial_reasons?: string[] | null
          cited_policy_sections?: string[] | null
          claim_id?: string
          content?: string
          created_at?: string
          decision_type?:
            | Database["public"]["Enums"]["claim_doc_decision"]
            | null
          denial_rationale?: string | null
          embedding?: string | null
          evidence_type?:
            | Database["public"]["Enums"]["claim_doc_evidence_type"]
            | null
          file_id?: string | null
          id?: string
          loss_date?: string | null
          loss_type?: Database["public"]["Enums"]["claim_doc_loss_type"] | null
          outcome_appraisal_invoked?: boolean | null
          outcome_litigation?: boolean | null
          outcome_paid_amount?: number | null
          outcome_reopened?: boolean | null
          outcome_resolution_type?: string | null
          outcome_supplement_won?: boolean | null
          policy_form?: string | null
          scope_decisions?: Json | null
          state_code?: string | null
          trade?: Database["public"]["Enums"]["claim_doc_trade"] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_document_chunks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_chunks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_chunks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_document_chunks_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_document_dismantlers: {
        Row: {
          cached: boolean | null
          chunk_count: number | null
          claim_id: string
          contradictions: Json | null
          coverage_weaknesses: Json | null
          created_at: string
          document_type: string
          draft_rebuttal_language: string | null
          evidence_to_gather_next: Json | null
          failed_chunks: number | null
          id: string
          limitations: Json | null
          main_position: string | null
          model: string | null
          non_covered_theories: Json | null
          omissions: Json | null
          repairability_overreach: Json | null
          report_summary: string | null
          source_file_id: string | null
          source_file_name: string | null
          strongest_rebuttal_points: Json | null
          successful_chunks: number | null
          unsupported_assumptions: Json | null
          used_search: boolean | null
        }
        Insert: {
          cached?: boolean | null
          chunk_count?: number | null
          claim_id: string
          contradictions?: Json | null
          coverage_weaknesses?: Json | null
          created_at?: string
          document_type?: string
          draft_rebuttal_language?: string | null
          evidence_to_gather_next?: Json | null
          failed_chunks?: number | null
          id?: string
          limitations?: Json | null
          main_position?: string | null
          model?: string | null
          non_covered_theories?: Json | null
          omissions?: Json | null
          repairability_overreach?: Json | null
          report_summary?: string | null
          source_file_id?: string | null
          source_file_name?: string | null
          strongest_rebuttal_points?: Json | null
          successful_chunks?: number | null
          unsupported_assumptions?: Json | null
          used_search?: boolean | null
        }
        Update: {
          cached?: boolean | null
          chunk_count?: number | null
          claim_id?: string
          contradictions?: Json | null
          coverage_weaknesses?: Json | null
          created_at?: string
          document_type?: string
          draft_rebuttal_language?: string | null
          evidence_to_gather_next?: Json | null
          failed_chunks?: number | null
          id?: string
          limitations?: Json | null
          main_position?: string | null
          model?: string | null
          non_covered_theories?: Json | null
          omissions?: Json | null
          repairability_overreach?: Json | null
          report_summary?: string | null
          source_file_id?: string | null
          source_file_name?: string | null
          strongest_rebuttal_points?: Json | null
          successful_chunks?: number | null
          unsupported_assumptions?: Json | null
          used_search?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_document_dismantlers_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_dismantlers_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_dismantlers_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_document_intelligence: {
        Row: {
          building_components: Json | null
          cause_of_loss: string | null
          citations: Json | null
          claim_file_id: string
          claim_id: string
          code_references: Json | null
          confidence_score: number | null
          contradictions: Json | null
          coverage_position: string | null
          created_at: string | null
          denial_reasons: Json | null
          document_subtype: string | null
          document_type: string
          estimate_totals: Json | null
          exclusions_cited: Json | null
          extracted_facts: Json | null
          id: string
          key_dates: Json | null
          key_entities: Json | null
          manufacturer_references: Json | null
          recipient: string | null
          scope_positions: Json | null
          segment_id: string | null
          sender: string | null
          source_scope: string
          summary: string | null
          testing_missing: Json | null
          testing_performed: Json | null
          updated_at: string | null
        }
        Insert: {
          building_components?: Json | null
          cause_of_loss?: string | null
          citations?: Json | null
          claim_file_id: string
          claim_id: string
          code_references?: Json | null
          confidence_score?: number | null
          contradictions?: Json | null
          coverage_position?: string | null
          created_at?: string | null
          denial_reasons?: Json | null
          document_subtype?: string | null
          document_type: string
          estimate_totals?: Json | null
          exclusions_cited?: Json | null
          extracted_facts?: Json | null
          id?: string
          key_dates?: Json | null
          key_entities?: Json | null
          manufacturer_references?: Json | null
          recipient?: string | null
          scope_positions?: Json | null
          segment_id?: string | null
          sender?: string | null
          source_scope?: string
          summary?: string | null
          testing_missing?: Json | null
          testing_performed?: Json | null
          updated_at?: string | null
        }
        Update: {
          building_components?: Json | null
          cause_of_loss?: string | null
          citations?: Json | null
          claim_file_id?: string
          claim_id?: string
          code_references?: Json | null
          confidence_score?: number | null
          contradictions?: Json | null
          coverage_position?: string | null
          created_at?: string | null
          denial_reasons?: Json | null
          document_subtype?: string | null
          document_type?: string
          estimate_totals?: Json | null
          exclusions_cited?: Json | null
          extracted_facts?: Json | null
          id?: string
          key_dates?: Json | null
          key_entities?: Json | null
          manufacturer_references?: Json | null
          recipient?: string | null
          scope_positions?: Json | null
          segment_id?: string | null
          sender?: string | null
          source_scope?: string
          summary?: string | null
          testing_missing?: Json | null
          testing_performed?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_document_intelligence_claim_file_id_fkey"
            columns: ["claim_file_id"]
            isOneToOne: true
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_document_intelligence_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_intelligence_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_intelligence_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_document_intelligence_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "claim_file_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_document_meaning: {
        Row: {
          carrier_arguments: Json
          claim_id: string
          confidence_score: number | null
          contradictions: Json
          coverage_position: Json
          created_at: string
          deadlines: Json
          document_classification: string | null
          document_type: string
          file_id: string
          financial_position: Json
          id: string
          meaning_version: string
          missing_evidence: Json
          raw_model_output: Json
          recommended_response: Json
          requested_items: Json
          response_required: boolean
          segment_id: string | null
          source_scope: string
          source_summary: string | null
          strategic_weight: string | null
          updated_at: string
          urgency: string | null
        }
        Insert: {
          carrier_arguments?: Json
          claim_id: string
          confidence_score?: number | null
          contradictions?: Json
          coverage_position?: Json
          created_at?: string
          deadlines?: Json
          document_classification?: string | null
          document_type: string
          file_id: string
          financial_position?: Json
          id?: string
          meaning_version?: string
          missing_evidence?: Json
          raw_model_output?: Json
          recommended_response?: Json
          requested_items?: Json
          response_required?: boolean
          segment_id?: string | null
          source_scope?: string
          source_summary?: string | null
          strategic_weight?: string | null
          updated_at?: string
          urgency?: string | null
        }
        Update: {
          carrier_arguments?: Json
          claim_id?: string
          confidence_score?: number | null
          contradictions?: Json
          coverage_position?: Json
          created_at?: string
          deadlines?: Json
          document_classification?: string | null
          document_type?: string
          file_id?: string
          financial_position?: Json
          id?: string
          meaning_version?: string
          missing_evidence?: Json
          raw_model_output?: Json
          recommended_response?: Json
          requested_items?: Json
          response_required?: boolean
          segment_id?: string | null
          source_scope?: string
          source_summary?: string | null
          strategic_weight?: string | null
          updated_at?: string
          urgency?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_document_meaning_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_meaning_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_document_meaning_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_document_meaning_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_document_meaning_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "claim_file_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_estimate_analysis: {
        Row: {
          analysis_type: string
          carrier_estimate_file_id: string | null
          carrier_total: number | null
          claim_id: string
          code_upgrade_gaps: Json | null
          confidence_score: number | null
          contractor_estimate_file_id: string | null
          contractor_total: number | null
          created_at: string
          created_by: string | null
          darwin_recommended_total: number | null
          difference_amount: number | null
          id: string
          op_gaps: Json | null
          pricing_gaps: Json | null
          quantity_gaps: Json | null
          rebuttal_narrative: string | null
          scope_gaps: Json | null
          structured_findings: Json | null
          supplement_recommendations: Json | null
          updated_at: string
        }
        Insert: {
          analysis_type?: string
          carrier_estimate_file_id?: string | null
          carrier_total?: number | null
          claim_id: string
          code_upgrade_gaps?: Json | null
          confidence_score?: number | null
          contractor_estimate_file_id?: string | null
          contractor_total?: number | null
          created_at?: string
          created_by?: string | null
          darwin_recommended_total?: number | null
          difference_amount?: number | null
          id?: string
          op_gaps?: Json | null
          pricing_gaps?: Json | null
          quantity_gaps?: Json | null
          rebuttal_narrative?: string | null
          scope_gaps?: Json | null
          structured_findings?: Json | null
          supplement_recommendations?: Json | null
          updated_at?: string
        }
        Update: {
          analysis_type?: string
          carrier_estimate_file_id?: string | null
          carrier_total?: number | null
          claim_id?: string
          code_upgrade_gaps?: Json | null
          confidence_score?: number | null
          contractor_estimate_file_id?: string | null
          contractor_total?: number | null
          created_at?: string
          created_by?: string | null
          darwin_recommended_total?: number | null
          difference_amount?: number | null
          id?: string
          op_gaps?: Json | null
          pricing_gaps?: Json | null
          quantity_gaps?: Json | null
          rebuttal_narrative?: string | null
          scope_gaps?: Json | null
          structured_findings?: Json | null
          supplement_recommendations?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_estimate_analysis_carrier_estimate_file_id_fkey"
            columns: ["carrier_estimate_file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_estimate_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_estimate_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_estimate_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_estimate_analysis_contractor_estimate_file_id_fkey"
            columns: ["contractor_estimate_file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_events: {
        Row: {
          actor: string | null
          claim_id: string
          created_at: string
          date_confidence: number | null
          date_evidence: string | null
          date_source: string
          dispute_tag: string | null
          doc_type: string | null
          event_type: string
          id: string
          importance_score: number | null
          is_editable: boolean | null
          is_manual: boolean | null
          is_pinned: boolean | null
          metadata_json: Json
          occurred_at: string
          source_artifact_id: string | null
          source_artifact_type: string | null
          summary: string | null
          supports_escalation: boolean | null
          supports_rebuttal: boolean | null
          updated_at: string
        }
        Insert: {
          actor?: string | null
          claim_id: string
          created_at?: string
          date_confidence?: number | null
          date_evidence?: string | null
          date_source?: string
          dispute_tag?: string | null
          doc_type?: string | null
          event_type: string
          id?: string
          importance_score?: number | null
          is_editable?: boolean | null
          is_manual?: boolean | null
          is_pinned?: boolean | null
          metadata_json?: Json
          occurred_at: string
          source_artifact_id?: string | null
          source_artifact_type?: string | null
          summary?: string | null
          supports_escalation?: boolean | null
          supports_rebuttal?: boolean | null
          updated_at?: string
        }
        Update: {
          actor?: string | null
          claim_id?: string
          created_at?: string
          date_confidence?: number | null
          date_evidence?: string | null
          date_source?: string
          dispute_tag?: string | null
          doc_type?: string | null
          event_type?: string
          id?: string
          importance_score?: number | null
          is_editable?: boolean | null
          is_manual?: boolean | null
          is_pinned?: boolean | null
          metadata_json?: Json
          occurred_at?: string
          source_artifact_id?: string | null
          source_artifact_type?: string | null
          summary?: string | null
          supports_escalation?: boolean | null
          supports_rebuttal?: boolean | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_expenses: {
        Row: {
          amount: number
          category: string | null
          claim_id: string
          created_at: string | null
          created_by: string | null
          description: string
          expense_date: string
          id: string
          is_paid: boolean | null
          notes: string | null
          paid_date: string | null
          paid_to: string | null
          payment_method: string | null
          updated_at: string | null
        }
        Insert: {
          amount: number
          category?: string | null
          claim_id: string
          created_at?: string | null
          created_by?: string | null
          description: string
          expense_date: string
          id?: string
          is_paid?: boolean | null
          notes?: string | null
          paid_date?: string | null
          paid_to?: string | null
          payment_method?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number
          category?: string | null
          claim_id?: string
          created_at?: string | null
          created_by?: string | null
          description?: string
          expense_date?: string
          id?: string
          is_paid?: boolean | null
          notes?: string | null
          paid_date?: string | null
          paid_to?: string | null
          payment_method?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_expenses_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_expenses_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_expenses_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_fees: {
        Row: {
          adjuster_fee_amount: number
          adjuster_fee_percentage: number
          claim_id: string
          company_fee_amount: number
          company_fee_percentage: number
          contractor_fee_amount: number
          contractor_fee_percentage: number
          created_at: string | null
          created_by: string | null
          id: string
          notes: string | null
          referrer_fee_amount: number
          referrer_fee_percentage: number
          updated_at: string | null
        }
        Insert: {
          adjuster_fee_amount?: number
          adjuster_fee_percentage?: number
          claim_id: string
          company_fee_amount?: number
          company_fee_percentage?: number
          contractor_fee_amount?: number
          contractor_fee_percentage?: number
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          referrer_fee_amount?: number
          referrer_fee_percentage?: number
          updated_at?: string | null
        }
        Update: {
          adjuster_fee_amount?: number
          adjuster_fee_percentage?: number
          claim_id?: string
          company_fee_amount?: number
          company_fee_percentage?: number
          contractor_fee_amount?: number
          contractor_fee_percentage?: number
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          referrer_fee_amount?: number
          referrer_fee_percentage?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_fees_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_fees_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_fees_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_file_segments: {
        Row: {
          automation_safe: boolean
          claim_id: string
          classification_candidates: Json
          classification_confidence: number | null
          classification_reasoning: Json
          clean_text: string | null
          created_at: string
          document_family: string | null
          end_page: number | null
          extracted_text: string | null
          file_id: string
          id: string
          review_required: boolean
          segment_classification: string | null
          segment_index: number
          segment_label: string | null
          source_method: string
          start_page: number | null
          text_excerpt: string | null
          updated_at: string
        }
        Insert: {
          automation_safe?: boolean
          claim_id: string
          classification_candidates?: Json
          classification_confidence?: number | null
          classification_reasoning?: Json
          clean_text?: string | null
          created_at?: string
          document_family?: string | null
          end_page?: number | null
          extracted_text?: string | null
          file_id: string
          id?: string
          review_required?: boolean
          segment_classification?: string | null
          segment_index: number
          segment_label?: string | null
          source_method?: string
          start_page?: number | null
          text_excerpt?: string | null
          updated_at?: string
        }
        Update: {
          automation_safe?: boolean
          claim_id?: string
          classification_candidates?: Json
          classification_confidence?: number | null
          classification_reasoning?: Json
          clean_text?: string | null
          created_at?: string
          document_family?: string | null
          end_page?: number | null
          extracted_text?: string | null
          file_id?: string
          id?: string
          review_required?: boolean
          segment_classification?: string | null
          segment_index?: number
          segment_label?: string | null
          source_method?: string
          start_page?: number | null
          text_excerpt?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_file_segments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_file_segments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_file_segments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_file_segments_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_files: {
        Row: {
          automation_safe: boolean
          claim_id: string
          classification_candidates: Json
          classification_confidence: number | null
          classification_metadata: Json | null
          classification_method: string | null
          classification_reasoning: Json
          classification_review_required: boolean
          clean_text: string | null
          confidence_score: number | null
          darwin_processed_at: string | null
          document_classification: string | null
          document_family: string | null
          document_subtype: string | null
          document_summary: string | null
          document_type: string | null
          email_id: string | null
          extracted_text: string | null
          extraction_method: string | null
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          folder_id: string | null
          has_virtual_segments: boolean
          id: string
          is_latest_version: boolean | null
          is_mixed_document: boolean
          is_scanned: boolean | null
          needs_reprocessing: boolean | null
          needs_text_backfill: boolean
          ocr_processed_at: string | null
          packet_analysis: Json
          packet_dominant_classification: string | null
          packet_mixed_confidence: number | null
          packet_page_count: number | null
          packet_review_required: boolean
          page_count: number | null
          parent_file_id: string | null
          processed_at: string | null
          processed_by_darwin: boolean | null
          processing_error: string | null
          ready_for_analysis: boolean | null
          segment_count: number
          segmentation_status: string | null
          segmentation_summary: Json
          source: string | null
          text_quality_status: string | null
          uploaded_at: string | null
          uploaded_by: string | null
          version: number | null
          version_label: string | null
        }
        Insert: {
          automation_safe?: boolean
          claim_id: string
          classification_candidates?: Json
          classification_confidence?: number | null
          classification_metadata?: Json | null
          classification_method?: string | null
          classification_reasoning?: Json
          classification_review_required?: boolean
          clean_text?: string | null
          confidence_score?: number | null
          darwin_processed_at?: string | null
          document_classification?: string | null
          document_family?: string | null
          document_subtype?: string | null
          document_summary?: string | null
          document_type?: string | null
          email_id?: string | null
          extracted_text?: string | null
          extraction_method?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          folder_id?: string | null
          has_virtual_segments?: boolean
          id?: string
          is_latest_version?: boolean | null
          is_mixed_document?: boolean
          is_scanned?: boolean | null
          needs_reprocessing?: boolean | null
          needs_text_backfill?: boolean
          ocr_processed_at?: string | null
          packet_analysis?: Json
          packet_dominant_classification?: string | null
          packet_mixed_confidence?: number | null
          packet_page_count?: number | null
          packet_review_required?: boolean
          page_count?: number | null
          parent_file_id?: string | null
          processed_at?: string | null
          processed_by_darwin?: boolean | null
          processing_error?: string | null
          ready_for_analysis?: boolean | null
          segment_count?: number
          segmentation_status?: string | null
          segmentation_summary?: Json
          source?: string | null
          text_quality_status?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
          version?: number | null
          version_label?: string | null
        }
        Update: {
          automation_safe?: boolean
          claim_id?: string
          classification_candidates?: Json
          classification_confidence?: number | null
          classification_metadata?: Json | null
          classification_method?: string | null
          classification_reasoning?: Json
          classification_review_required?: boolean
          clean_text?: string | null
          confidence_score?: number | null
          darwin_processed_at?: string | null
          document_classification?: string | null
          document_family?: string | null
          document_subtype?: string | null
          document_summary?: string | null
          document_type?: string | null
          email_id?: string | null
          extracted_text?: string | null
          extraction_method?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          folder_id?: string | null
          has_virtual_segments?: boolean
          id?: string
          is_latest_version?: boolean | null
          is_mixed_document?: boolean
          is_scanned?: boolean | null
          needs_reprocessing?: boolean | null
          needs_text_backfill?: boolean
          ocr_processed_at?: string | null
          packet_analysis?: Json
          packet_dominant_classification?: string | null
          packet_mixed_confidence?: number | null
          packet_page_count?: number | null
          packet_review_required?: boolean
          page_count?: number | null
          parent_file_id?: string | null
          processed_at?: string | null
          processed_by_darwin?: boolean | null
          processing_error?: string | null
          ready_for_analysis?: boolean | null
          segment_count?: number
          segmentation_status?: string | null
          segmentation_summary?: Json
          source?: string | null
          text_quality_status?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
          version?: number | null
          version_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_files_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_files_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_files_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_files_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_files_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "claim_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_files_parent_file_id_fkey"
            columns: ["parent_file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_folders: {
        Row: {
          claim_id: string
          created_at: string | null
          created_by: string | null
          display_order: number | null
          id: string
          is_predefined: boolean | null
          name: string
          parent_folder_id: string | null
        }
        Insert: {
          claim_id: string
          created_at?: string | null
          created_by?: string | null
          display_order?: number | null
          id?: string
          is_predefined?: boolean | null
          name: string
          parent_folder_id?: string | null
        }
        Update: {
          claim_id?: string
          created_at?: string | null
          created_by?: string | null
          display_order?: number | null
          id?: string
          is_predefined?: boolean | null
          name?: string
          parent_folder_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_folders_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_folders_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_folders_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_folders_parent_folder_id_fkey"
            columns: ["parent_folder_id"]
            isOneToOne: false
            referencedRelation: "claim_folders"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_followup_log: {
        Row: {
          claim_id: string
          id: string
          notes: string | null
          resolved_at: string | null
          status: string
          trigger_reason: string
          triggered_at: string
        }
        Insert: {
          claim_id: string
          id?: string
          notes?: string | null
          resolved_at?: string | null
          status?: string
          trigger_reason: string
          triggered_at?: string
        }
        Update: {
          claim_id?: string
          id?: string
          notes?: string | null
          resolved_at?: string | null
          status?: string
          trigger_reason?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_followup_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_followup_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_followup_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_hidden_loss_checks: {
        Row: {
          checked_at: string | null
          checked_by: string | null
          checklist_item_id: string | null
          claim_id: string
          created_at: string
          custom_item_name: string | null
          damage_description: string | null
          estimated_cost: number | null
          id: string
          is_checked: boolean | null
          is_damage_found: boolean | null
          notes: string | null
          photo_file_paths: string[] | null
          updated_at: string
        }
        Insert: {
          checked_at?: string | null
          checked_by?: string | null
          checklist_item_id?: string | null
          claim_id: string
          created_at?: string
          custom_item_name?: string | null
          damage_description?: string | null
          estimated_cost?: number | null
          id?: string
          is_checked?: boolean | null
          is_damage_found?: boolean | null
          notes?: string | null
          photo_file_paths?: string[] | null
          updated_at?: string
        }
        Update: {
          checked_at?: string | null
          checked_by?: string | null
          checklist_item_id?: string | null
          claim_id?: string
          created_at?: string
          custom_item_name?: string | null
          damage_description?: string | null
          estimated_cost?: number | null
          id?: string
          is_checked?: boolean | null
          is_damage_found?: boolean | null
          notes?: string | null
          photo_file_paths?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_hidden_loss_checks_checklist_item_id_fkey"
            columns: ["checklist_item_id"]
            isOneToOne: false
            referencedRelation: "hidden_loss_checklist_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_hidden_loss_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_hidden_loss_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_hidden_loss_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_home_inventory: {
        Row: {
          actual_cash_value: number | null
          age_confidence_score: number | null
          age_years: number | null
          ai_confidence: number | null
          attributes: Json | null
          brand_confirmed: boolean
          category: string | null
          claim_id: string
          comparable_url: string | null
          condition_before_loss: string | null
          created_at: string
          created_by: string | null
          damage_description: string | null
          depreciation_rate: number | null
          evidence_json: Json | null
          id: string
          is_total_loss: boolean | null
          item_description: string | null
          item_name: string
          label_photo_path: string | null
          manufacturer: string | null
          model_confirmed: boolean
          model_number: string | null
          needs_age_review: boolean | null
          needs_review: boolean
          notes: string | null
          original_purchase_date: string | null
          original_purchase_price: number | null
          photo_file_paths: string[] | null
          price_confirmed: boolean
          pricing_rationale: string | null
          pricing_source: string | null
          purchase_date_best: string | null
          purchase_date_high: string | null
          purchase_date_low: string | null
          quantity: number | null
          receipt_file_path: string | null
          replacement_cost: number | null
          replacement_link: string | null
          room_name: string
          serial_number: string | null
          source: string
          source_photo_id: string | null
          updated_at: string
        }
        Insert: {
          actual_cash_value?: number | null
          age_confidence_score?: number | null
          age_years?: number | null
          ai_confidence?: number | null
          attributes?: Json | null
          brand_confirmed?: boolean
          category?: string | null
          claim_id: string
          comparable_url?: string | null
          condition_before_loss?: string | null
          created_at?: string
          created_by?: string | null
          damage_description?: string | null
          depreciation_rate?: number | null
          evidence_json?: Json | null
          id?: string
          is_total_loss?: boolean | null
          item_description?: string | null
          item_name: string
          label_photo_path?: string | null
          manufacturer?: string | null
          model_confirmed?: boolean
          model_number?: string | null
          needs_age_review?: boolean | null
          needs_review?: boolean
          notes?: string | null
          original_purchase_date?: string | null
          original_purchase_price?: number | null
          photo_file_paths?: string[] | null
          price_confirmed?: boolean
          pricing_rationale?: string | null
          pricing_source?: string | null
          purchase_date_best?: string | null
          purchase_date_high?: string | null
          purchase_date_low?: string | null
          quantity?: number | null
          receipt_file_path?: string | null
          replacement_cost?: number | null
          replacement_link?: string | null
          room_name: string
          serial_number?: string | null
          source?: string
          source_photo_id?: string | null
          updated_at?: string
        }
        Update: {
          actual_cash_value?: number | null
          age_confidence_score?: number | null
          age_years?: number | null
          ai_confidence?: number | null
          attributes?: Json | null
          brand_confirmed?: boolean
          category?: string | null
          claim_id?: string
          comparable_url?: string | null
          condition_before_loss?: string | null
          created_at?: string
          created_by?: string | null
          damage_description?: string | null
          depreciation_rate?: number | null
          evidence_json?: Json | null
          id?: string
          is_total_loss?: boolean | null
          item_description?: string | null
          item_name?: string
          label_photo_path?: string | null
          manufacturer?: string | null
          model_confirmed?: boolean
          model_number?: string | null
          needs_age_review?: boolean | null
          needs_review?: boolean
          notes?: string | null
          original_purchase_date?: string | null
          original_purchase_price?: number | null
          photo_file_paths?: string[] | null
          price_confirmed?: boolean
          pricing_rationale?: string | null
          pricing_source?: string | null
          purchase_date_best?: string | null
          purchase_date_high?: string | null
          purchase_date_low?: string | null
          quantity?: number | null
          receipt_file_path?: string | null
          replacement_cost?: number | null
          replacement_link?: string | null
          room_name?: string
          serial_number?: string | null
          source?: string
          source_photo_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_home_inventory_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_home_inventory_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_home_inventory_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_home_inventory_source_photo_id_fkey"
            columns: ["source_photo_id"]
            isOneToOne: false
            referencedRelation: "claim_photos"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_intelligence_cache: {
        Row: {
          cache_type: string
          claim_id: string
          created_at: string
          id: string
          payload: Json
          subkey: string
          updated_at: string
          version: number
        }
        Insert: {
          cache_type: string
          claim_id: string
          created_at?: string
          id?: string
          payload: Json
          subkey?: string
          updated_at?: string
          version?: number
        }
        Update: {
          cache_type?: string
          claim_id?: string
          created_at?: string
          id?: string
          payload?: Json
          subkey?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "claim_intelligence_cache_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_intelligence_cache_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_intelligence_cache_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_intelligence_summary: {
        Row: {
          carrier_weakest_argument: Json | null
          change_details: Json | null
          change_reason: string | null
          claim_id: string
          confidence_factors: Json | null
          confidence_score: number | null
          created_at: string | null
          evidence_confidence: number | null
          financial_confidence: number | null
          id: string
          intelligence_sources: Json | null
          largest_recovery_opportunity: Json | null
          learning_confidence: number | null
          missing_evidence: Json | null
          most_important_issue: string | null
          pre_scores: Json | null
          previous_summary_id: string | null
          raw_summary: string | null
          rebuttal_confidence: number | null
          recommended_next_action: Json | null
          strategy_confidence: number | null
          strongest_evidence: Json | null
          trigger_event: string | null
          trigger_metadata: Json | null
          updated_at: string | null
          version: number
        }
        Insert: {
          carrier_weakest_argument?: Json | null
          change_details?: Json | null
          change_reason?: string | null
          claim_id: string
          confidence_factors?: Json | null
          confidence_score?: number | null
          created_at?: string | null
          evidence_confidence?: number | null
          financial_confidence?: number | null
          id?: string
          intelligence_sources?: Json | null
          largest_recovery_opportunity?: Json | null
          learning_confidence?: number | null
          missing_evidence?: Json | null
          most_important_issue?: string | null
          pre_scores?: Json | null
          previous_summary_id?: string | null
          raw_summary?: string | null
          rebuttal_confidence?: number | null
          recommended_next_action?: Json | null
          strategy_confidence?: number | null
          strongest_evidence?: Json | null
          trigger_event?: string | null
          trigger_metadata?: Json | null
          updated_at?: string | null
          version?: number
        }
        Update: {
          carrier_weakest_argument?: Json | null
          change_details?: Json | null
          change_reason?: string | null
          claim_id?: string
          confidence_factors?: Json | null
          confidence_score?: number | null
          created_at?: string | null
          evidence_confidence?: number | null
          financial_confidence?: number | null
          id?: string
          intelligence_sources?: Json | null
          largest_recovery_opportunity?: Json | null
          learning_confidence?: number | null
          missing_evidence?: Json | null
          most_important_issue?: string | null
          pre_scores?: Json | null
          previous_summary_id?: string | null
          raw_summary?: string | null
          rebuttal_confidence?: number | null
          recommended_next_action?: Json | null
          strategy_confidence?: number | null
          strongest_evidence?: Json | null
          trigger_event?: string | null
          trigger_metadata?: Json | null
          updated_at?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "claim_intelligence_summary_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_intelligence_summary_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_intelligence_summary_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_intelligence_summary_previous_summary_id_fkey"
            columns: ["previous_summary_id"]
            isOneToOne: false
            referencedRelation: "claim_intelligence_summary"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_intelligence_version: {
        Row: {
          claim_id: string
          last_bumped_reason: string | null
          updated_at: string
          version: number
        }
        Insert: {
          claim_id: string
          last_bumped_reason?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          claim_id?: string
          last_bumped_reason?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "claim_intelligence_version_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_intelligence_version_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_intelligence_version_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_knowledge_library: {
        Row: {
          applicability_tags: string[] | null
          authority_level: number
          content: string
          created_at: string
          dispute_type: string | null
          id: string
          jurisdiction: string | null
          loss_type: string | null
          material: string | null
          source_type: string
          state: string | null
          tags: string[] | null
          title: string
          topic: string
          trade: string | null
          updated_at: string
        }
        Insert: {
          applicability_tags?: string[] | null
          authority_level?: number
          content: string
          created_at?: string
          dispute_type?: string | null
          id?: string
          jurisdiction?: string | null
          loss_type?: string | null
          material?: string | null
          source_type?: string
          state?: string | null
          tags?: string[] | null
          title: string
          topic: string
          trade?: string | null
          updated_at?: string
        }
        Update: {
          applicability_tags?: string[] | null
          authority_level?: number
          content?: string
          created_at?: string
          dispute_type?: string | null
          id?: string
          jurisdiction?: string | null
          loss_type?: string | null
          material?: string | null
          source_type?: string
          state?: string | null
          tags?: string[] | null
          title?: string
          topic?: string
          trade?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      claim_line_item_justifications: {
        Row: {
          carrier_facing_text: string | null
          claim_id: string
          code_support: Json | null
          confidence_score: number | null
          created_at: string
          estimate_line_id: string | null
          id: string
          inline_note: string | null
          manufacturer_support: Json | null
          missing_evidence_json: Json | null
          normalized_item: string
          output_mode: string | null
          policy_support: Json | null
          support_strength: string | null
          updated_at: string
        }
        Insert: {
          carrier_facing_text?: string | null
          claim_id: string
          code_support?: Json | null
          confidence_score?: number | null
          created_at?: string
          estimate_line_id?: string | null
          id?: string
          inline_note?: string | null
          manufacturer_support?: Json | null
          missing_evidence_json?: Json | null
          normalized_item: string
          output_mode?: string | null
          policy_support?: Json | null
          support_strength?: string | null
          updated_at?: string
        }
        Update: {
          carrier_facing_text?: string | null
          claim_id?: string
          code_support?: Json | null
          confidence_score?: number | null
          created_at?: string
          estimate_line_id?: string | null
          id?: string
          inline_note?: string | null
          manufacturer_support?: Json | null
          missing_evidence_json?: Json | null
          normalized_item?: string
          output_mode?: string | null
          policy_support?: Json | null
          support_strength?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_line_item_justifications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_line_item_justifications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_line_item_justifications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_loss_of_use_expenses: {
        Row: {
          amount: number
          claim_id: string
          created_at: string
          created_by: string | null
          denial_reason: string | null
          description: string
          expense_category: string
          expense_date: string
          id: string
          is_paid: boolean | null
          is_reimbursed: boolean | null
          is_submitted_to_insurer: boolean | null
          notes: string | null
          paid_date: string | null
          receipt_file_name: string | null
          receipt_file_path: string | null
          reimbursed_amount: number | null
          reimbursed_date: string | null
          submitted_date: string | null
          updated_at: string
          vendor_name: string | null
        }
        Insert: {
          amount: number
          claim_id: string
          created_at?: string
          created_by?: string | null
          denial_reason?: string | null
          description: string
          expense_category: string
          expense_date: string
          id?: string
          is_paid?: boolean | null
          is_reimbursed?: boolean | null
          is_submitted_to_insurer?: boolean | null
          notes?: string | null
          paid_date?: string | null
          receipt_file_name?: string | null
          receipt_file_path?: string | null
          reimbursed_amount?: number | null
          reimbursed_date?: string | null
          submitted_date?: string | null
          updated_at?: string
          vendor_name?: string | null
        }
        Update: {
          amount?: number
          claim_id?: string
          created_at?: string
          created_by?: string | null
          denial_reason?: string | null
          description?: string
          expense_category?: string
          expense_date?: string
          id?: string
          is_paid?: boolean | null
          is_reimbursed?: boolean | null
          is_submitted_to_insurer?: boolean | null
          notes?: string | null
          paid_date?: string | null
          receipt_file_name?: string | null
          receipt_file_path?: string | null
          reimbursed_amount?: number | null
          reimbursed_date?: string | null
          submitted_date?: string | null
          updated_at?: string
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_loss_of_use_expenses_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_loss_of_use_expenses_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_loss_of_use_expenses_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_master_state: {
        Row: {
          claim_id: string
          state_json: Json
          updated_at: string
        }
        Insert: {
          claim_id: string
          state_json?: Json
          updated_at?: string
        }
        Update: {
          claim_id?: string
          state_json?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_master_state_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_master_state_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_master_state_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_microtasks: {
        Row: {
          assigned_to: string | null
          claim_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_at: string | null
          id: string
          is_blocking: boolean
          priority: string
          status: string
          surfaced_on_board: boolean
          task_type: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          claim_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          is_blocking?: boolean
          priority?: string
          status?: string
          surfaced_on_board?: boolean
          task_type?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          claim_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_at?: string | null
          id?: string
          is_blocking?: boolean
          priority?: string
          status?: string
          surfaced_on_board?: boolean
          task_type?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_microtasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_microtasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_microtasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_normal_bills: {
        Row: {
          category: string
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          label: string
          monthly_amount: number
          notes: string | null
          updated_at: string
        }
        Insert: {
          category: string
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          label: string
          monthly_amount?: number
          notes?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string
          monthly_amount?: number
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_normal_bills_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_normal_bills_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_normal_bills_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_operational_state: {
        Row: {
          blocking_task_count: number
          claim_id: string
          contradiction_flag: boolean
          days_since_last_activity: number | null
          follow_up_status: string
          high_exposure_flag: boolean
          immediate_task_count: number
          last_activity_at: string | null
          lifecycle_stage: string
          next_best_action: string | null
          next_best_action_confidence: number | null
          pressure_score: number | null
          priority_rank: number | null
          stale_flag: boolean
          updated_at: string
        }
        Insert: {
          blocking_task_count?: number
          claim_id: string
          contradiction_flag?: boolean
          days_since_last_activity?: number | null
          follow_up_status?: string
          high_exposure_flag?: boolean
          immediate_task_count?: number
          last_activity_at?: string | null
          lifecycle_stage?: string
          next_best_action?: string | null
          next_best_action_confidence?: number | null
          pressure_score?: number | null
          priority_rank?: number | null
          stale_flag?: boolean
          updated_at?: string
        }
        Update: {
          blocking_task_count?: number
          claim_id?: string
          contradiction_flag?: boolean
          days_since_last_activity?: number | null
          follow_up_status?: string
          high_exposure_flag?: boolean
          immediate_task_count?: number
          last_activity_at?: string | null
          lifecycle_stage?: string
          next_best_action?: string | null
          next_best_action_confidence?: number | null
          pressure_score?: number | null
          priority_rank?: number | null
          stale_flag?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_operational_state_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_operational_state_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_operational_state_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_outcome_events: {
        Row: {
          carrier: string
          claim_id: string
          close_date: string | null
          coverage_reversal: boolean | null
          created_at: string
          decision_type: string | null
          delta_amount: number | null
          denial_rationales: string[] | null
          evidence_types_present: string[] | null
          final_paid: number | null
          first_offer: number | null
          id: string
          loss_type: string | null
          policy_form: string | null
          resolution_type: string | null
          state_code: string | null
          tactics_present: string[] | null
          trade: string | null
          updated_at: string
        }
        Insert: {
          carrier: string
          claim_id: string
          close_date?: string | null
          coverage_reversal?: boolean | null
          created_at?: string
          decision_type?: string | null
          delta_amount?: number | null
          denial_rationales?: string[] | null
          evidence_types_present?: string[] | null
          final_paid?: number | null
          first_offer?: number | null
          id?: string
          loss_type?: string | null
          policy_form?: string | null
          resolution_type?: string | null
          state_code?: string | null
          tactics_present?: string[] | null
          trade?: string | null
          updated_at?: string
        }
        Update: {
          carrier?: string
          claim_id?: string
          close_date?: string | null
          coverage_reversal?: boolean | null
          created_at?: string
          decision_type?: string | null
          delta_amount?: number | null
          denial_rationales?: string[] | null
          evidence_types_present?: string[] | null
          final_paid?: number | null
          first_offer?: number | null
          id?: string
          loss_type?: string | null
          policy_form?: string | null
          resolution_type?: string | null
          state_code?: string | null
          tactics_present?: string[] | null
          trade?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_outcome_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcome_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcome_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_outcome_learning: {
        Row: {
          carrier: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          denial_rationale: string | null
          evidence_patterns: Json | null
          final_settlement: number | null
          id: string
          initial_carrier_offer: number | null
          key_turning_point: string | null
          lessons_learned: string | null
          loss_type: string | null
          outcome: string | null
          recovery_delta: number | null
          resolution_timeline_days: number | null
          reusable_language: Json | null
          state_code: string | null
          strategy_sequence: Json | null
          tags: string[] | null
          winning_arguments: Json | null
        }
        Insert: {
          carrier?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          denial_rationale?: string | null
          evidence_patterns?: Json | null
          final_settlement?: number | null
          id?: string
          initial_carrier_offer?: number | null
          key_turning_point?: string | null
          lessons_learned?: string | null
          loss_type?: string | null
          outcome?: string | null
          recovery_delta?: number | null
          resolution_timeline_days?: number | null
          reusable_language?: Json | null
          state_code?: string | null
          strategy_sequence?: Json | null
          tags?: string[] | null
          winning_arguments?: Json | null
        }
        Update: {
          carrier?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          denial_rationale?: string | null
          evidence_patterns?: Json | null
          final_settlement?: number | null
          id?: string
          initial_carrier_offer?: number | null
          key_turning_point?: string | null
          lessons_learned?: string | null
          loss_type?: string | null
          outcome?: string | null
          recovery_delta?: number | null
          resolution_timeline_days?: number | null
          reusable_language?: Json | null
          state_code?: string | null
          strategy_sequence?: Json | null
          tags?: string[] | null
          winning_arguments?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_outcome_learning_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcome_learning_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcome_learning_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_outcome_predictions: {
        Row: {
          analysis_notes: string | null
          claim_id: string
          comparable_claims: Json | null
          created_at: string
          created_by: string | null
          id: string
          model_version: string | null
          opportunity_factors: Json | null
          predicted_settlement_high: number | null
          predicted_settlement_likely: number | null
          predicted_settlement_low: number | null
          predicted_timeline_days: number | null
          risk_factors: Json | null
          settlement_probability: number | null
        }
        Insert: {
          analysis_notes?: string | null
          claim_id: string
          comparable_claims?: Json | null
          created_at?: string
          created_by?: string | null
          id?: string
          model_version?: string | null
          opportunity_factors?: Json | null
          predicted_settlement_high?: number | null
          predicted_settlement_likely?: number | null
          predicted_settlement_low?: number | null
          predicted_timeline_days?: number | null
          risk_factors?: Json | null
          settlement_probability?: number | null
        }
        Update: {
          analysis_notes?: string | null
          claim_id?: string
          comparable_claims?: Json | null
          created_at?: string
          created_by?: string | null
          id?: string
          model_version?: string | null
          opportunity_factors?: Json | null
          predicted_settlement_high?: number | null
          predicted_settlement_likely?: number | null
          predicted_settlement_low?: number | null
          predicted_timeline_days?: number | null
          risk_factors?: Json | null
          settlement_probability?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_outcome_predictions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcome_predictions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcome_predictions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_outcomes: {
        Row: {
          bad_faith_alleged: boolean | null
          carrier_reversal_occurred: boolean | null
          claim_id: string
          created_at: string
          created_by: string | null
          days_to_final_settlement: number | null
          days_to_first_payment: number | null
          effective_evidence: Json | null
          failed_arguments: Json | null
          final_litigation_readiness: number | null
          final_pressure_index: number | null
          final_settlement: number | null
          final_wsi: number | null
          id: string
          initial_estimate: number | null
          key_leverage_points: Json | null
          litigation_filed: boolean | null
          missing_evidence_impact: string | null
          notes: string | null
          predicted_carrier_move_snapshot: Json | null
          prediction_accuracy_flag: boolean | null
          recovery_percentage: number | null
          resolution_date: string | null
          resolution_type: string | null
          settlement_variance: number | null
          supplements_approved: number | null
          total_claimed_amount: number | null
          total_supplements_submitted: number | null
          updated_at: string
          winning_arguments: Json | null
        }
        Insert: {
          bad_faith_alleged?: boolean | null
          carrier_reversal_occurred?: boolean | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          days_to_final_settlement?: number | null
          days_to_first_payment?: number | null
          effective_evidence?: Json | null
          failed_arguments?: Json | null
          final_litigation_readiness?: number | null
          final_pressure_index?: number | null
          final_settlement?: number | null
          final_wsi?: number | null
          id?: string
          initial_estimate?: number | null
          key_leverage_points?: Json | null
          litigation_filed?: boolean | null
          missing_evidence_impact?: string | null
          notes?: string | null
          predicted_carrier_move_snapshot?: Json | null
          prediction_accuracy_flag?: boolean | null
          recovery_percentage?: number | null
          resolution_date?: string | null
          resolution_type?: string | null
          settlement_variance?: number | null
          supplements_approved?: number | null
          total_claimed_amount?: number | null
          total_supplements_submitted?: number | null
          updated_at?: string
          winning_arguments?: Json | null
        }
        Update: {
          bad_faith_alleged?: boolean | null
          carrier_reversal_occurred?: boolean | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          days_to_final_settlement?: number | null
          days_to_first_payment?: number | null
          effective_evidence?: Json | null
          failed_arguments?: Json | null
          final_litigation_readiness?: number | null
          final_pressure_index?: number | null
          final_settlement?: number | null
          final_wsi?: number | null
          id?: string
          initial_estimate?: number | null
          key_leverage_points?: Json | null
          litigation_filed?: boolean | null
          missing_evidence_impact?: string | null
          notes?: string | null
          predicted_carrier_move_snapshot?: Json | null
          prediction_accuracy_flag?: boolean | null
          recovery_percentage?: number | null
          resolution_date?: string | null
          resolution_type?: string | null
          settlement_variance?: number | null
          supplements_approved?: number | null
          total_claimed_amount?: number | null
          total_supplements_submitted?: number | null
          updated_at?: string
          winning_arguments?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_outcomes_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcomes_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_outcomes_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_partner_assignments: {
        Row: {
          assigned_at: string | null
          assigned_by: string | null
          claim_id: string
          id: string
          linked_workspace_id: string
          sales_rep_email: string | null
          sales_rep_id: string | null
          sales_rep_name: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_by?: string | null
          claim_id: string
          id?: string
          linked_workspace_id: string
          sales_rep_email?: string | null
          sales_rep_id?: string | null
          sales_rep_name: string
        }
        Update: {
          assigned_at?: string | null
          assigned_by?: string | null
          claim_id?: string
          id?: string
          linked_workspace_id?: string
          sales_rep_email?: string | null
          sales_rep_id?: string | null
          sales_rep_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_partner_assignments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_partner_assignments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_partner_assignments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_partner_assignments_linked_workspace_id_fkey"
            columns: ["linked_workspace_id"]
            isOneToOne: false
            referencedRelation: "linked_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_payments: {
        Row: {
          amount: number
          check_intake_item_id: string | null
          check_number: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          direction: string | null
          id: string
          notes: string | null
          payment_date: string
          payment_method: string
          recipient_id: string | null
          recipient_type: string
          updated_at: string
        }
        Insert: {
          amount: number
          check_intake_item_id?: string | null
          check_number?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          direction?: string | null
          id?: string
          notes?: string | null
          payment_date: string
          payment_method: string
          recipient_id?: string | null
          recipient_type: string
          updated_at?: string
        }
        Update: {
          amount?: number
          check_intake_item_id?: string | null
          check_number?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          direction?: string | null
          id?: string
          notes?: string | null
          payment_date?: string
          payment_method?: string
          recipient_id?: string | null
          recipient_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_payments_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_payments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_payments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_payments_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_performance_attribution: {
        Row: {
          carrier_name: string | null
          claim_id: string
          created_at: string
          days_to_recovery: number | null
          escalation_types: string[] | null
          escalation_used: boolean | null
          final_velocity: number | null
          gap_recovery_pct: number | null
          id: string
          loss_type: string | null
          resistance_peak_score: number | null
          revenue_captured: number | null
          state_code: string | null
          strategy_used: string | null
          updated_at: string
        }
        Insert: {
          carrier_name?: string | null
          claim_id: string
          created_at?: string
          days_to_recovery?: number | null
          escalation_types?: string[] | null
          escalation_used?: boolean | null
          final_velocity?: number | null
          gap_recovery_pct?: number | null
          id?: string
          loss_type?: string | null
          resistance_peak_score?: number | null
          revenue_captured?: number | null
          state_code?: string | null
          strategy_used?: string | null
          updated_at?: string
        }
        Update: {
          carrier_name?: string | null
          claim_id?: string
          created_at?: string
          days_to_recovery?: number | null
          escalation_types?: string[] | null
          escalation_used?: boolean | null
          final_velocity?: number | null
          gap_recovery_pct?: number | null
          id?: string
          loss_type?: string | null
          resistance_peak_score?: number | null
          revenue_captured?: number | null
          state_code?: string | null
          strategy_used?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_performance_attribution_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_performance_attribution_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_performance_attribution_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_photo_findings: {
        Row: {
          area: string | null
          carrier_contradiction: string | null
          causation_link: string | null
          claim_id: string
          code_trigger_ref: string | null
          confidence: number | null
          created_at: string
          damage_description: string | null
          evidence_strength: string | null
          finding_type: string
          id: string
          material_type: string | null
          photo_id: string | null
          photo_url: string | null
          scope_relevance: string | null
          severity: string | null
          source_analysis_id: string | null
          structured_data: Json | null
        }
        Insert: {
          area?: string | null
          carrier_contradiction?: string | null
          causation_link?: string | null
          claim_id: string
          code_trigger_ref?: string | null
          confidence?: number | null
          created_at?: string
          damage_description?: string | null
          evidence_strength?: string | null
          finding_type: string
          id?: string
          material_type?: string | null
          photo_id?: string | null
          photo_url?: string | null
          scope_relevance?: string | null
          severity?: string | null
          source_analysis_id?: string | null
          structured_data?: Json | null
        }
        Update: {
          area?: string | null
          carrier_contradiction?: string | null
          causation_link?: string | null
          claim_id?: string
          code_trigger_ref?: string | null
          confidence?: number | null
          created_at?: string
          damage_description?: string | null
          evidence_strength?: string | null
          finding_type?: string
          id?: string
          material_type?: string | null
          photo_id?: string | null
          photo_url?: string | null
          scope_relevance?: string | null
          severity?: string | null
          source_analysis_id?: string | null
          structured_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_photo_findings_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_photo_findings_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_photo_findings_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_photos: {
        Row: {
          ai_analysis_summary: string | null
          ai_analyzed_at: string | null
          ai_condition_notes: string | null
          ai_condition_rating: string | null
          ai_detected_damages: Json | null
          ai_loss_type_consistency: string | null
          ai_loss_type_consistency_notes: string | null
          ai_material_type: string | null
          annotated_file_path: string | null
          annotations: Json | null
          before_after_pair_id: string | null
          before_after_type: string | null
          category: string | null
          claim_id: string
          created_at: string | null
          description: string | null
          file_name: string
          file_path: string
          file_size: number | null
          id: string
          taken_at: string | null
          updated_at: string | null
          uploaded_by: string | null
        }
        Insert: {
          ai_analysis_summary?: string | null
          ai_analyzed_at?: string | null
          ai_condition_notes?: string | null
          ai_condition_rating?: string | null
          ai_detected_damages?: Json | null
          ai_loss_type_consistency?: string | null
          ai_loss_type_consistency_notes?: string | null
          ai_material_type?: string | null
          annotated_file_path?: string | null
          annotations?: Json | null
          before_after_pair_id?: string | null
          before_after_type?: string | null
          category?: string | null
          claim_id: string
          created_at?: string | null
          description?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          id?: string
          taken_at?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Update: {
          ai_analysis_summary?: string | null
          ai_analyzed_at?: string | null
          ai_condition_notes?: string | null
          ai_condition_rating?: string | null
          ai_detected_damages?: Json | null
          ai_loss_type_consistency?: string | null
          ai_loss_type_consistency_notes?: string | null
          ai_material_type?: string | null
          annotated_file_path?: string | null
          annotations?: Json | null
          before_after_pair_id?: string | null
          before_after_type?: string | null
          category?: string | null
          claim_id?: string
          created_at?: string | null
          description?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          id?: string
          taken_at?: string | null
          updated_at?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_photos_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_photos_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_photos_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_policy_analysis: {
        Row: {
          analyzed_at: string | null
          claim_id: string
          contradictions_found: Json | null
          coverage_limits: Json | null
          created_at: string | null
          exclusions: Json | null
          id: string
          policy_file_id: string | null
          policy_summary: string | null
          special_conditions: Json | null
          updated_at: string | null
        }
        Insert: {
          analyzed_at?: string | null
          claim_id: string
          contradictions_found?: Json | null
          coverage_limits?: Json | null
          created_at?: string | null
          exclusions?: Json | null
          id?: string
          policy_file_id?: string | null
          policy_summary?: string | null
          special_conditions?: Json | null
          updated_at?: string | null
        }
        Update: {
          analyzed_at?: string | null
          claim_id?: string
          contradictions_found?: Json | null
          coverage_limits?: Json | null
          created_at?: string | null
          exclusions?: Json | null
          id?: string
          policy_file_id?: string | null
          policy_summary?: string | null
          special_conditions?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_policy_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_policy_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_policy_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_policy_analysis_policy_file_id_fkey"
            columns: ["policy_file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_predictive_analysis: {
        Row: {
          actual_outcome: string | null
          basis: Json | null
          claim_id: string
          confidence: number | null
          created_at: string
          data_basis_count: number | null
          id: string
          model_type: string | null
          predicted_timeline: string | null
          prediction: string
          prediction_type: string
          resolved_at: string | null
          was_accurate: boolean | null
        }
        Insert: {
          actual_outcome?: string | null
          basis?: Json | null
          claim_id: string
          confidence?: number | null
          created_at?: string
          data_basis_count?: number | null
          id?: string
          model_type?: string | null
          predicted_timeline?: string | null
          prediction: string
          prediction_type: string
          resolved_at?: string | null
          was_accurate?: boolean | null
        }
        Update: {
          actual_outcome?: string | null
          basis?: Json | null
          claim_id?: string
          confidence?: number | null
          created_at?: string
          data_basis_count?: number | null
          id?: string
          model_type?: string | null
          predicted_timeline?: string | null
          prediction?: string
          prediction_type?: string
          resolved_at?: string | null
          was_accurate?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_predictive_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_predictive_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_predictive_analysis_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_roof_measurements: {
        Row: {
          address: string
          ai_notes: string | null
          aspect_ratio: number | null
          calibration_adjustment_factor: number | null
          candidate_footprints: Json | null
          claim_id: string
          confidence_score: number | null
          confirmation_attachments: Json | null
          confirmation_basis: string | null
          confirmation_level: string | null
          confirmation_notes: string | null
          confirmation_strength_score: number | null
          confirmed_at: string | null
          confirmed_by: string | null
          correction_factor_used: number | null
          created_at: string
          created_by: string | null
          data_sources: string[] | null
          dominant_axis_bearing: number | null
          dominant_axis_length_ft: number | null
          dominant_pitch: string | null
          eave_lf: number | null
          edge_classifications: Json | null
          estimated_roof_area_sqft: number | null
          facet_count: number | null
          facet_decomposition: Json | null
          field_authority: Json | null
          field_confidence: Json | null
          field_sources: Json | null
          footprint_area_sqft: number | null
          footprint_perimeter_ft: number | null
          footprint_polygon: Json | null
          geocoded_lat: number | null
          geocoded_lng: number | null
          geometry_metadata: Json | null
          geometry_quality_score: number | null
          hip_lf: number | null
          hip_valley_candidates: Json | null
          id: string
          imagery_analysis: Json | null
          imagery_date: string | null
          imagery_source: string | null
          inferred_roof_form: string | null
          manually_confirmed: boolean
          overhang_config: Json | null
          overlay_image_url: string | null
          perpendicular_axis_length_ft: number | null
          pitch_band: string | null
          pitch_type: string
          planar_area_gain_sqft: number | null
          pre_tuning_values: Json | null
          provisional_complexity_uplift_used: number | null
          rake_lf: number | null
          raw_geojson: Json | null
          review_required: boolean
          ridge_candidates: Json | null
          ridge_lf: number | null
          roof_form_confidence: number | null
          roof_form_reasoning: string | null
          roof_mass_count: number | null
          roof_mass_decomposition: Json | null
          roof_mass_polygons: Json | null
          roof_planar_area_sqft: number | null
          roof_polygon_geojson: Json | null
          roof_shape_conflict: boolean | null
          roof_shape_conflict_reason: string | null
          selected_candidate_index: number | null
          shape_conflicted_roof_area_sqft: number | null
          shape_conflicted_squares: number | null
          slope_factor_used: number | null
          squares: number | null
          suggested_roof_outline_notes: string | null
          suggested_roof_polygon_confidence: number | null
          suggested_roof_polygon_geojson: Json | null
          suggested_roof_polygon_source: string | null
          suppression_records: Json | null
          tuning_applied: Json | null
          updated_at: string
          user_drawn_at: string | null
          user_drawn_by: string | null
          user_drawn_planar_area_sqft: number | null
          user_drawn_roof_area_sqft: number | null
          user_drawn_roof_polygon_geojson: Json | null
          user_drawn_squares: number | null
          valley_lf: number | null
          vision_classifications: Json | null
        }
        Insert: {
          address: string
          ai_notes?: string | null
          aspect_ratio?: number | null
          calibration_adjustment_factor?: number | null
          candidate_footprints?: Json | null
          claim_id: string
          confidence_score?: number | null
          confirmation_attachments?: Json | null
          confirmation_basis?: string | null
          confirmation_level?: string | null
          confirmation_notes?: string | null
          confirmation_strength_score?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          correction_factor_used?: number | null
          created_at?: string
          created_by?: string | null
          data_sources?: string[] | null
          dominant_axis_bearing?: number | null
          dominant_axis_length_ft?: number | null
          dominant_pitch?: string | null
          eave_lf?: number | null
          edge_classifications?: Json | null
          estimated_roof_area_sqft?: number | null
          facet_count?: number | null
          facet_decomposition?: Json | null
          field_authority?: Json | null
          field_confidence?: Json | null
          field_sources?: Json | null
          footprint_area_sqft?: number | null
          footprint_perimeter_ft?: number | null
          footprint_polygon?: Json | null
          geocoded_lat?: number | null
          geocoded_lng?: number | null
          geometry_metadata?: Json | null
          geometry_quality_score?: number | null
          hip_lf?: number | null
          hip_valley_candidates?: Json | null
          id?: string
          imagery_analysis?: Json | null
          imagery_date?: string | null
          imagery_source?: string | null
          inferred_roof_form?: string | null
          manually_confirmed?: boolean
          overhang_config?: Json | null
          overlay_image_url?: string | null
          perpendicular_axis_length_ft?: number | null
          pitch_band?: string | null
          pitch_type?: string
          planar_area_gain_sqft?: number | null
          pre_tuning_values?: Json | null
          provisional_complexity_uplift_used?: number | null
          rake_lf?: number | null
          raw_geojson?: Json | null
          review_required?: boolean
          ridge_candidates?: Json | null
          ridge_lf?: number | null
          roof_form_confidence?: number | null
          roof_form_reasoning?: string | null
          roof_mass_count?: number | null
          roof_mass_decomposition?: Json | null
          roof_mass_polygons?: Json | null
          roof_planar_area_sqft?: number | null
          roof_polygon_geojson?: Json | null
          roof_shape_conflict?: boolean | null
          roof_shape_conflict_reason?: string | null
          selected_candidate_index?: number | null
          shape_conflicted_roof_area_sqft?: number | null
          shape_conflicted_squares?: number | null
          slope_factor_used?: number | null
          squares?: number | null
          suggested_roof_outline_notes?: string | null
          suggested_roof_polygon_confidence?: number | null
          suggested_roof_polygon_geojson?: Json | null
          suggested_roof_polygon_source?: string | null
          suppression_records?: Json | null
          tuning_applied?: Json | null
          updated_at?: string
          user_drawn_at?: string | null
          user_drawn_by?: string | null
          user_drawn_planar_area_sqft?: number | null
          user_drawn_roof_area_sqft?: number | null
          user_drawn_roof_polygon_geojson?: Json | null
          user_drawn_squares?: number | null
          valley_lf?: number | null
          vision_classifications?: Json | null
        }
        Update: {
          address?: string
          ai_notes?: string | null
          aspect_ratio?: number | null
          calibration_adjustment_factor?: number | null
          candidate_footprints?: Json | null
          claim_id?: string
          confidence_score?: number | null
          confirmation_attachments?: Json | null
          confirmation_basis?: string | null
          confirmation_level?: string | null
          confirmation_notes?: string | null
          confirmation_strength_score?: number | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          correction_factor_used?: number | null
          created_at?: string
          created_by?: string | null
          data_sources?: string[] | null
          dominant_axis_bearing?: number | null
          dominant_axis_length_ft?: number | null
          dominant_pitch?: string | null
          eave_lf?: number | null
          edge_classifications?: Json | null
          estimated_roof_area_sqft?: number | null
          facet_count?: number | null
          facet_decomposition?: Json | null
          field_authority?: Json | null
          field_confidence?: Json | null
          field_sources?: Json | null
          footprint_area_sqft?: number | null
          footprint_perimeter_ft?: number | null
          footprint_polygon?: Json | null
          geocoded_lat?: number | null
          geocoded_lng?: number | null
          geometry_metadata?: Json | null
          geometry_quality_score?: number | null
          hip_lf?: number | null
          hip_valley_candidates?: Json | null
          id?: string
          imagery_analysis?: Json | null
          imagery_date?: string | null
          imagery_source?: string | null
          inferred_roof_form?: string | null
          manually_confirmed?: boolean
          overhang_config?: Json | null
          overlay_image_url?: string | null
          perpendicular_axis_length_ft?: number | null
          pitch_band?: string | null
          pitch_type?: string
          planar_area_gain_sqft?: number | null
          pre_tuning_values?: Json | null
          provisional_complexity_uplift_used?: number | null
          rake_lf?: number | null
          raw_geojson?: Json | null
          review_required?: boolean
          ridge_candidates?: Json | null
          ridge_lf?: number | null
          roof_form_confidence?: number | null
          roof_form_reasoning?: string | null
          roof_mass_count?: number | null
          roof_mass_decomposition?: Json | null
          roof_mass_polygons?: Json | null
          roof_planar_area_sqft?: number | null
          roof_polygon_geojson?: Json | null
          roof_shape_conflict?: boolean | null
          roof_shape_conflict_reason?: string | null
          selected_candidate_index?: number | null
          shape_conflicted_roof_area_sqft?: number | null
          shape_conflicted_squares?: number | null
          slope_factor_used?: number | null
          squares?: number | null
          suggested_roof_outline_notes?: string | null
          suggested_roof_polygon_confidence?: number | null
          suggested_roof_polygon_geojson?: Json | null
          suggested_roof_polygon_source?: string | null
          suppression_records?: Json | null
          tuning_applied?: Json | null
          updated_at?: string
          user_drawn_at?: string | null
          user_drawn_by?: string | null
          user_drawn_planar_area_sqft?: number | null
          user_drawn_roof_area_sqft?: number | null
          user_drawn_roof_polygon_geojson?: Json | null
          user_drawn_squares?: number | null
          valley_lf?: number | null
          vision_classifications?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_roof_measurements_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_roof_measurements_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_roof_measurements_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_roof_outline_edits: {
        Row: {
          created_at: string
          created_by: string | null
          edit_source: string
          id: string
          new_planar_area_sqft: number | null
          new_polygon_geojson: Json | null
          prior_planar_area_sqft: number | null
          prior_polygon_geojson: Json | null
          roof_measurement_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          edit_source: string
          id?: string
          new_planar_area_sqft?: number | null
          new_polygon_geojson?: Json | null
          prior_planar_area_sqft?: number | null
          prior_polygon_geojson?: Json | null
          roof_measurement_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          edit_source?: string
          id?: string
          new_planar_area_sqft?: number | null
          new_polygon_geojson?: Json | null
          prior_planar_area_sqft?: number | null
          prior_polygon_geojson?: Json | null
          roof_measurement_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_roof_outline_edits_roof_measurement_id_fkey"
            columns: ["roof_measurement_id"]
            isOneToOne: false
            referencedRelation: "claim_roof_measurements"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_roof_validations: {
        Row: {
          accuracy_grade: string | null
          actual_dominant_pitch: string | null
          actual_eave_lf: number | null
          actual_facet_count: number | null
          actual_footprint_area_sqft: number | null
          actual_hip_lf: number | null
          actual_rake_lf: number | null
          actual_ridge_lf: number | null
          actual_roof_area_sqft: number | null
          actual_roof_form: string | null
          actual_squares: number | null
          actual_valley_lf: number | null
          candidate_count: number | null
          claim_id: string
          created_at: string
          created_by: string | null
          darwin_confidence_score: number | null
          darwin_dominant_pitch: string | null
          darwin_eave_lf: number | null
          darwin_facet_count: number | null
          darwin_footprint_area_sqft: number | null
          darwin_geometry_quality_score: number | null
          darwin_hip_lf: number | null
          darwin_rake_lf: number | null
          darwin_ridge_lf: number | null
          darwin_roof_area_sqft: number | null
          darwin_roof_form: string | null
          darwin_squares: number | null
          darwin_valley_lf: number | null
          delta_eave_lf: number | null
          delta_footprint_area: number | null
          delta_hip_lf: number | null
          delta_rake_lf: number | null
          delta_ridge_lf: number | null
          delta_roof_area: number | null
          delta_squares: number | null
          delta_valley_lf: number | null
          estimate_id: string
          facet_count_match: boolean | null
          failure_patterns: Json | null
          geometry_source: string | null
          geometry_source_score: number | null
          id: string
          overall_accuracy_score: number | null
          pct_delta_eave_lf: number | null
          pct_delta_footprint_area: number | null
          pct_delta_hip_lf: number | null
          pct_delta_rake_lf: number | null
          pct_delta_ridge_lf: number | null
          pct_delta_roof_area: number | null
          pct_delta_squares: number | null
          pct_delta_valley_lf: number | null
          pitch_match: boolean | null
          roof_form_match: boolean | null
          source_date: string | null
          source_document_url: string | null
          source_name: string | null
          source_type: string
          staff_notes: string | null
          updated_at: string
        }
        Insert: {
          accuracy_grade?: string | null
          actual_dominant_pitch?: string | null
          actual_eave_lf?: number | null
          actual_facet_count?: number | null
          actual_footprint_area_sqft?: number | null
          actual_hip_lf?: number | null
          actual_rake_lf?: number | null
          actual_ridge_lf?: number | null
          actual_roof_area_sqft?: number | null
          actual_roof_form?: string | null
          actual_squares?: number | null
          actual_valley_lf?: number | null
          candidate_count?: number | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          darwin_confidence_score?: number | null
          darwin_dominant_pitch?: string | null
          darwin_eave_lf?: number | null
          darwin_facet_count?: number | null
          darwin_footprint_area_sqft?: number | null
          darwin_geometry_quality_score?: number | null
          darwin_hip_lf?: number | null
          darwin_rake_lf?: number | null
          darwin_ridge_lf?: number | null
          darwin_roof_area_sqft?: number | null
          darwin_roof_form?: string | null
          darwin_squares?: number | null
          darwin_valley_lf?: number | null
          delta_eave_lf?: number | null
          delta_footprint_area?: number | null
          delta_hip_lf?: number | null
          delta_rake_lf?: number | null
          delta_ridge_lf?: number | null
          delta_roof_area?: number | null
          delta_squares?: number | null
          delta_valley_lf?: number | null
          estimate_id: string
          facet_count_match?: boolean | null
          failure_patterns?: Json | null
          geometry_source?: string | null
          geometry_source_score?: number | null
          id?: string
          overall_accuracy_score?: number | null
          pct_delta_eave_lf?: number | null
          pct_delta_footprint_area?: number | null
          pct_delta_hip_lf?: number | null
          pct_delta_rake_lf?: number | null
          pct_delta_ridge_lf?: number | null
          pct_delta_roof_area?: number | null
          pct_delta_squares?: number | null
          pct_delta_valley_lf?: number | null
          pitch_match?: boolean | null
          roof_form_match?: boolean | null
          source_date?: string | null
          source_document_url?: string | null
          source_name?: string | null
          source_type?: string
          staff_notes?: string | null
          updated_at?: string
        }
        Update: {
          accuracy_grade?: string | null
          actual_dominant_pitch?: string | null
          actual_eave_lf?: number | null
          actual_facet_count?: number | null
          actual_footprint_area_sqft?: number | null
          actual_hip_lf?: number | null
          actual_rake_lf?: number | null
          actual_ridge_lf?: number | null
          actual_roof_area_sqft?: number | null
          actual_roof_form?: string | null
          actual_squares?: number | null
          actual_valley_lf?: number | null
          candidate_count?: number | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          darwin_confidence_score?: number | null
          darwin_dominant_pitch?: string | null
          darwin_eave_lf?: number | null
          darwin_facet_count?: number | null
          darwin_footprint_area_sqft?: number | null
          darwin_geometry_quality_score?: number | null
          darwin_hip_lf?: number | null
          darwin_rake_lf?: number | null
          darwin_ridge_lf?: number | null
          darwin_roof_area_sqft?: number | null
          darwin_roof_form?: string | null
          darwin_squares?: number | null
          darwin_valley_lf?: number | null
          delta_eave_lf?: number | null
          delta_footprint_area?: number | null
          delta_hip_lf?: number | null
          delta_rake_lf?: number | null
          delta_ridge_lf?: number | null
          delta_roof_area?: number | null
          delta_squares?: number | null
          delta_valley_lf?: number | null
          estimate_id?: string
          facet_count_match?: boolean | null
          failure_patterns?: Json | null
          geometry_source?: string | null
          geometry_source_score?: number | null
          id?: string
          overall_accuracy_score?: number | null
          pct_delta_eave_lf?: number | null
          pct_delta_footprint_area?: number | null
          pct_delta_hip_lf?: number | null
          pct_delta_rake_lf?: number | null
          pct_delta_ridge_lf?: number | null
          pct_delta_roof_area?: number | null
          pct_delta_squares?: number | null
          pct_delta_valley_lf?: number | null
          pitch_match?: boolean | null
          roof_form_match?: boolean | null
          source_date?: string | null
          source_document_url?: string | null
          source_name?: string | null
          source_type?: string
          staff_notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      claim_scenario_simulations: {
        Row: {
          claim_id: string
          confidence_score: number | null
          created_at: string
          data_basis_count: number | null
          id: string
          model_type: string | null
          projected_litigation_delta: number | null
          projected_pressure_delta: number | null
          projected_wsi_delta: number | null
          result_explanation: string | null
          result_litigation_readiness: number | null
          result_pressure_index: number | null
          result_win_probability_range: string | null
          result_wsi: number | null
          scenario_action: string
          scenario_label: string
        }
        Insert: {
          claim_id: string
          confidence_score?: number | null
          created_at?: string
          data_basis_count?: number | null
          id?: string
          model_type?: string | null
          projected_litigation_delta?: number | null
          projected_pressure_delta?: number | null
          projected_wsi_delta?: number | null
          result_explanation?: string | null
          result_litigation_readiness?: number | null
          result_pressure_index?: number | null
          result_win_probability_range?: string | null
          result_wsi?: number | null
          scenario_action: string
          scenario_label: string
        }
        Update: {
          claim_id?: string
          confidence_score?: number | null
          created_at?: string
          data_basis_count?: number | null
          id?: string
          model_type?: string | null
          projected_litigation_delta?: number | null
          projected_pressure_delta?: number | null
          projected_wsi_delta?: number | null
          result_explanation?: string | null
          result_litigation_readiness?: number | null
          result_pressure_index?: number | null
          result_win_probability_range?: string | null
          result_wsi?: number | null
          scenario_action?: string
          scenario_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_scenario_simulations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_scenario_simulations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_scenario_simulations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_settlements: {
        Row: {
          ale_non_recoverable_depreciation: number | null
          ale_rcv: number | null
          ale_recoverable_depreciation: number | null
          claim_id: string
          created_at: string | null
          created_by: string | null
          deductible: number
          estimate_amount: number | null
          id: string
          non_recoverable_depreciation: number
          notes: string | null
          other_structures_deductible: number | null
          other_structures_non_recoverable_depreciation: number | null
          other_structures_rcv: number | null
          other_structures_recoverable_depreciation: number | null
          pa_estimate_amount: number | null
          personal_property_non_recoverable_depreciation: number | null
          personal_property_rcv: number | null
          personal_property_recoverable_depreciation: number | null
          prior_offer: number | null
          pwi_deductible: number | null
          pwi_non_recoverable_depreciation: number | null
          pwi_rcv: number | null
          pwi_recoverable_depreciation: number | null
          recoverable_depreciation: number
          replacement_cost_value: number
          total_settlement: number | null
          updated_at: string | null
        }
        Insert: {
          ale_non_recoverable_depreciation?: number | null
          ale_rcv?: number | null
          ale_recoverable_depreciation?: number | null
          claim_id: string
          created_at?: string | null
          created_by?: string | null
          deductible?: number
          estimate_amount?: number | null
          id?: string
          non_recoverable_depreciation?: number
          notes?: string | null
          other_structures_deductible?: number | null
          other_structures_non_recoverable_depreciation?: number | null
          other_structures_rcv?: number | null
          other_structures_recoverable_depreciation?: number | null
          pa_estimate_amount?: number | null
          personal_property_non_recoverable_depreciation?: number | null
          personal_property_rcv?: number | null
          personal_property_recoverable_depreciation?: number | null
          prior_offer?: number | null
          pwi_deductible?: number | null
          pwi_non_recoverable_depreciation?: number | null
          pwi_rcv?: number | null
          pwi_recoverable_depreciation?: number | null
          recoverable_depreciation?: number
          replacement_cost_value?: number
          total_settlement?: number | null
          updated_at?: string | null
        }
        Update: {
          ale_non_recoverable_depreciation?: number | null
          ale_rcv?: number | null
          ale_recoverable_depreciation?: number | null
          claim_id?: string
          created_at?: string | null
          created_by?: string | null
          deductible?: number
          estimate_amount?: number | null
          id?: string
          non_recoverable_depreciation?: number
          notes?: string | null
          other_structures_deductible?: number | null
          other_structures_non_recoverable_depreciation?: number | null
          other_structures_rcv?: number | null
          other_structures_recoverable_depreciation?: number | null
          pa_estimate_amount?: number | null
          personal_property_non_recoverable_depreciation?: number | null
          personal_property_rcv?: number | null
          personal_property_recoverable_depreciation?: number | null
          prior_offer?: number | null
          pwi_deductible?: number | null
          pwi_non_recoverable_depreciation?: number | null
          pwi_rcv?: number | null
          pwi_recoverable_depreciation?: number | null
          recoverable_depreciation?: number
          replacement_cost_value?: number
          total_settlement?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_settlements_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_settlements_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_settlements_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_staff: {
        Row: {
          assigned_at: string | null
          claim_id: string
          id: string
          staff_id: string
        }
        Insert: {
          assigned_at?: string | null
          claim_id: string
          id?: string
          staff_id: string
        }
        Update: {
          assigned_at?: string | null
          claim_id?: string
          id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_staff_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_staff_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_staff_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_statuses: {
        Row: {
          color: string | null
          created_at: string | null
          display_order: number
          gradient: string | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          color?: string | null
          created_at?: string | null
          display_order?: number
          gradient?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          color?: string | null
          created_at?: string | null
          display_order?: number
          gradient?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      claim_strategic_insights: {
        Row: {
          analysis_version: string | null
          auto_refresh_enabled: boolean | null
          carrier_conduct_risk_score: number | null
          claim_id: string
          confidence_scores: Json | null
          counter_strategies: Json | null
          coverage_strength_score: number | null
          coverage_triggers_detected: Json | null
          created_at: string
          documentation_holes: Json | null
          evidence_gaps: Json | null
          evidence_quality_score: number | null
          id: string
          last_analyzed_at: string
          leverage_points: Json | null
          leverage_score: number | null
          litigation_readiness_factors: Json | null
          litigation_readiness_score: number | null
          matched_playbooks: Json | null
          model_type: string | null
          overall_health_score: number | null
          predicted_carrier_move: Json | null
          pressure_index_factors: Json | null
          pressure_index_level: string | null
          pressure_index_score: number | null
          procedural_compliance_score: number | null
          raw_inputs: Json | null
          recommended_next_moves: Json | null
          scenario_simulations: Json | null
          senior_pa_opinion: string | null
          strategic_memo: Json | null
          timeline_risk_score: number | null
          updated_at: string
          warnings: Json | null
          weight_version: string | null
          wsi_components: Json | null
          wsi_score: number | null
        }
        Insert: {
          analysis_version?: string | null
          auto_refresh_enabled?: boolean | null
          carrier_conduct_risk_score?: number | null
          claim_id: string
          confidence_scores?: Json | null
          counter_strategies?: Json | null
          coverage_strength_score?: number | null
          coverage_triggers_detected?: Json | null
          created_at?: string
          documentation_holes?: Json | null
          evidence_gaps?: Json | null
          evidence_quality_score?: number | null
          id?: string
          last_analyzed_at?: string
          leverage_points?: Json | null
          leverage_score?: number | null
          litigation_readiness_factors?: Json | null
          litigation_readiness_score?: number | null
          matched_playbooks?: Json | null
          model_type?: string | null
          overall_health_score?: number | null
          predicted_carrier_move?: Json | null
          pressure_index_factors?: Json | null
          pressure_index_level?: string | null
          pressure_index_score?: number | null
          procedural_compliance_score?: number | null
          raw_inputs?: Json | null
          recommended_next_moves?: Json | null
          scenario_simulations?: Json | null
          senior_pa_opinion?: string | null
          strategic_memo?: Json | null
          timeline_risk_score?: number | null
          updated_at?: string
          warnings?: Json | null
          weight_version?: string | null
          wsi_components?: Json | null
          wsi_score?: number | null
        }
        Update: {
          analysis_version?: string | null
          auto_refresh_enabled?: boolean | null
          carrier_conduct_risk_score?: number | null
          claim_id?: string
          confidence_scores?: Json | null
          counter_strategies?: Json | null
          coverage_strength_score?: number | null
          coverage_triggers_detected?: Json | null
          created_at?: string
          documentation_holes?: Json | null
          evidence_gaps?: Json | null
          evidence_quality_score?: number | null
          id?: string
          last_analyzed_at?: string
          leverage_points?: Json | null
          leverage_score?: number | null
          litigation_readiness_factors?: Json | null
          litigation_readiness_score?: number | null
          matched_playbooks?: Json | null
          model_type?: string | null
          overall_health_score?: number | null
          predicted_carrier_move?: Json | null
          pressure_index_factors?: Json | null
          pressure_index_level?: string | null
          pressure_index_score?: number | null
          procedural_compliance_score?: number | null
          raw_inputs?: Json | null
          recommended_next_moves?: Json | null
          scenario_simulations?: Json | null
          senior_pa_opinion?: string | null
          strategic_memo?: Json | null
          timeline_risk_score?: number | null
          updated_at?: string
          warnings?: Json | null
          weight_version?: string | null
          wsi_components?: Json | null
          wsi_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_strategic_insights_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_strategic_insights_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_strategic_insights_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_strategic_snapshots: {
        Row: {
          claim_id: string
          confidence_scores: Json | null
          created_at: string
          drift_reason: string | null
          id: string
          litigation_readiness: number | null
          predicted_move: Json | null
          pressure_index: number | null
          pressure_level: string | null
          raw_inputs: Json | null
          strategic_drift_flag: boolean | null
          weight_version: string | null
          wsi: number | null
        }
        Insert: {
          claim_id: string
          confidence_scores?: Json | null
          created_at?: string
          drift_reason?: string | null
          id?: string
          litigation_readiness?: number | null
          predicted_move?: Json | null
          pressure_index?: number | null
          pressure_level?: string | null
          raw_inputs?: Json | null
          strategic_drift_flag?: boolean | null
          weight_version?: string | null
          wsi?: number | null
        }
        Update: {
          claim_id?: string
          confidence_scores?: Json | null
          created_at?: string
          drift_reason?: string | null
          id?: string
          litigation_readiness?: number | null
          predicted_move?: Json | null
          pressure_index?: number | null
          pressure_level?: string | null
          raw_inputs?: Json | null
          strategic_drift_flag?: boolean | null
          weight_version?: string | null
          wsi?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_strategic_snapshots_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_strategic_snapshots_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_strategic_snapshots_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_strategy_simulations: {
        Row: {
          carrier_behavior_factors: Json | null
          claim_facts_snapshot: Json | null
          claim_id: string
          created_at: string
          created_by: string | null
          cross_claim_support: Json | null
          evidence_completeness_pct: number | null
          id: string
          is_recommended: boolean | null
          predicted_recovery_delta: number | null
          predicted_timeline_days: number | null
          rationale: string
          recommended_action: string
          required_missing_evidence: Json | null
          risk_level: string | null
          score: number
          strategy_type: string
        }
        Insert: {
          carrier_behavior_factors?: Json | null
          claim_facts_snapshot?: Json | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          cross_claim_support?: Json | null
          evidence_completeness_pct?: number | null
          id?: string
          is_recommended?: boolean | null
          predicted_recovery_delta?: number | null
          predicted_timeline_days?: number | null
          rationale: string
          recommended_action: string
          required_missing_evidence?: Json | null
          risk_level?: string | null
          score?: number
          strategy_type: string
        }
        Update: {
          carrier_behavior_factors?: Json | null
          claim_facts_snapshot?: Json | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          cross_claim_support?: Json | null
          evidence_completeness_pct?: number | null
          id?: string
          is_recommended?: boolean | null
          predicted_recovery_delta?: number | null
          predicted_timeline_days?: number | null
          rationale?: string
          recommended_action?: string
          required_missing_evidence?: Json | null
          risk_level?: string | null
          score?: number
          strategy_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_strategy_simulations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_strategy_simulations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_strategy_simulations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_sub_statuses: {
        Row: {
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          name: string
          parent_status_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          name: string
          parent_status_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          name?: string
          parent_status_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_sub_statuses_parent_status_id_fkey"
            columns: ["parent_status_id"]
            isOneToOne: false
            referencedRelation: "claim_statuses"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_thesis_objects: {
        Row: {
          anticipated_pushback: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          cross_claim_lessons: Json | null
          evidence_map: Json
          id: string
          industry_notes_used: Json | null
          is_locked: boolean
          last_deltas_reviewed_at: string | null
          last_memory_snapshot: Json | null
          locked_at: string | null
          locked_by: string | null
          pipeline_version: string | null
          primary_carrier_error: string
          primary_cause_of_loss: string
          primary_coverage_theory: string
          pushback_counter: string | null
          updated_at: string
          web_search_performed: boolean | null
          web_search_results: Json | null
        }
        Insert: {
          anticipated_pushback?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          cross_claim_lessons?: Json | null
          evidence_map?: Json
          id?: string
          industry_notes_used?: Json | null
          is_locked?: boolean
          last_deltas_reviewed_at?: string | null
          last_memory_snapshot?: Json | null
          locked_at?: string | null
          locked_by?: string | null
          pipeline_version?: string | null
          primary_carrier_error: string
          primary_cause_of_loss: string
          primary_coverage_theory: string
          pushback_counter?: string | null
          updated_at?: string
          web_search_performed?: boolean | null
          web_search_results?: Json | null
        }
        Update: {
          anticipated_pushback?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          cross_claim_lessons?: Json | null
          evidence_map?: Json
          id?: string
          industry_notes_used?: Json | null
          is_locked?: boolean
          last_deltas_reviewed_at?: string | null
          last_memory_snapshot?: Json | null
          locked_at?: string | null
          locked_by?: string | null
          pipeline_version?: string | null
          primary_carrier_error?: string
          primary_cause_of_loss?: string
          primary_coverage_theory?: string
          pushback_counter?: string | null
          updated_at?: string
          web_search_performed?: boolean | null
          web_search_results?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_thesis_objects_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_thesis_objects_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_thesis_objects_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_updates: {
        Row: {
          claim_id: string
          content: string
          created_at: string | null
          id: string
          recipients: Json | null
          update_type: string | null
          user_id: string | null
        }
        Insert: {
          claim_id: string
          content: string
          created_at?: string | null
          id?: string
          recipients?: Json | null
          update_type?: string | null
          user_id?: string | null
        }
        Update: {
          claim_id?: string
          content?: string
          created_at?: string | null
          id?: string
          recipients?: Json | null
          update_type?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claim_updates_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_updates_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_updates_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_violation_detections: {
        Row: {
          claim_id: string
          created_at: string
          days_exceeded: number | null
          description: string
          detected_at: string
          id: string
          recommended_action: string | null
          severity: string
          source_event_ids: string[] | null
          statute_reference: string | null
          violation_type: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          days_exceeded?: number | null
          description: string
          detected_at?: string
          id?: string
          recommended_action?: string | null
          severity?: string
          source_event_ids?: string[] | null
          statute_reference?: string | null
          violation_type: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          days_exceeded?: number | null
          description?: string
          detected_at?: string
          id?: string
          recommended_action?: string | null
          severity?: string
          source_event_ids?: string[] | null
          statute_reference?: string | null
          violation_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_violation_detections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_violation_detections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_violation_detections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_warnings_log: {
        Row: {
          action_recommendation: string | null
          action_taken: string | null
          claim_id: string
          context: Json | null
          created_at: string
          dismiss_reason: string | null
          dismissed_at: string | null
          dismissed_by: string | null
          id: string
          is_dismissed: boolean | null
          is_resolved: boolean | null
          message: string
          precedent_claim_ids: string[] | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          shown_in_context: string | null
          source: string
          suggested_action: string | null
          times_shown: number | null
          title: string
          trigger_context: string | null
          warning_type: string
        }
        Insert: {
          action_recommendation?: string | null
          action_taken?: string | null
          claim_id: string
          context?: Json | null
          created_at?: string
          dismiss_reason?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          id?: string
          is_dismissed?: boolean | null
          is_resolved?: boolean | null
          message: string
          precedent_claim_ids?: string[] | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          shown_in_context?: string | null
          source?: string
          suggested_action?: string | null
          times_shown?: number | null
          title: string
          trigger_context?: string | null
          warning_type: string
        }
        Update: {
          action_recommendation?: string | null
          action_taken?: string | null
          claim_id?: string
          context?: Json | null
          created_at?: string
          dismiss_reason?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          id?: string
          is_dismissed?: boolean | null
          is_resolved?: boolean | null
          message?: string
          precedent_claim_ids?: string[] | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          shown_in_context?: string | null
          source?: string
          suggested_action?: string | null
          times_shown?: number | null
          title?: string
          trigger_context?: string | null
          warning_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_warnings_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_warnings_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "claim_warnings_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claims: {
        Row: {
          adjuster_email: string | null
          adjuster_name: string | null
          adjuster_phone: string | null
          ale_limit: number | null
          automation_mode: Database["public"]["Enums"]["automation_mode"]
          automation_resume_at: string | null
          claim_amount: number | null
          claim_email_id: string | null
          claim_number: string | null
          claim_tracking_number: string | null
          client_id: string | null
          construction_status: string | null
          contract_pdf_path: string | null
          created_at: string | null
          date_claim_filed: string | null
          deductible: number | null
          dwelling_limit: number | null
          esign_audit_url: string | null
          esign_completed_at: string | null
          esign_document_id: string | null
          esign_error_message: string | null
          esign_provider: string | null
          esign_sent_at: string | null
          esign_signing_link: string | null
          esign_status: string | null
          fedex_tracking_number: string | null
          fraud_flag: boolean | null
          fraud_flag_reason: string | null
          fraud_flagged_at: string | null
          fraud_flagged_by: string | null
          geocoded_at: string | null
          id: string
          insurance_company: string | null
          insurance_company_id: string | null
          insurance_email: string | null
          insurance_phone: string | null
          is_closed: boolean
          is_guided_mode: boolean
          jobnimbus_job_id: string | null
          last_activity_at: string | null
          latest_signature_request_id: string | null
          latitude: number | null
          loan_number: string | null
          longitude: number | null
          loss_date: string | null
          loss_description: string | null
          loss_type: string | null
          loss_type_id: string | null
          mortgage_company_id: string | null
          mortgage_portal_password: string | null
          mortgage_portal_site: string | null
          mortgage_portal_username: string | null
          org_id: string | null
          other_structures_limit: number | null
          partner_assigned_user_email: string | null
          partner_assigned_user_id: string | null
          partner_assigned_user_name: string | null
          partner_construction_status: string | null
          personal_property_limit: number | null
          policy_number: string | null
          policyholder_address: string | null
          policyholder_email: string | null
          policyholder_name: string | null
          policyholder_phone: string | null
          referrer_id: string | null
          retention_purge_after: string | null
          signature_cc_email: string | null
          signed_pdf_url: string | null
          ssn_last_four: string | null
          state_code: string | null
          status: string | null
          sub_status_id: string | null
          updated_at: string | null
          workspace_id: string | null
        }
        Insert: {
          adjuster_email?: string | null
          adjuster_name?: string | null
          adjuster_phone?: string | null
          ale_limit?: number | null
          automation_mode?: Database["public"]["Enums"]["automation_mode"]
          automation_resume_at?: string | null
          claim_amount?: number | null
          claim_email_id?: string | null
          claim_number?: string | null
          claim_tracking_number?: string | null
          client_id?: string | null
          construction_status?: string | null
          contract_pdf_path?: string | null
          created_at?: string | null
          date_claim_filed?: string | null
          deductible?: number | null
          dwelling_limit?: number | null
          esign_audit_url?: string | null
          esign_completed_at?: string | null
          esign_document_id?: string | null
          esign_error_message?: string | null
          esign_provider?: string | null
          esign_sent_at?: string | null
          esign_signing_link?: string | null
          esign_status?: string | null
          fedex_tracking_number?: string | null
          fraud_flag?: boolean | null
          fraud_flag_reason?: string | null
          fraud_flagged_at?: string | null
          fraud_flagged_by?: string | null
          geocoded_at?: string | null
          id?: string
          insurance_company?: string | null
          insurance_company_id?: string | null
          insurance_email?: string | null
          insurance_phone?: string | null
          is_closed?: boolean
          is_guided_mode?: boolean
          jobnimbus_job_id?: string | null
          last_activity_at?: string | null
          latest_signature_request_id?: string | null
          latitude?: number | null
          loan_number?: string | null
          longitude?: number | null
          loss_date?: string | null
          loss_description?: string | null
          loss_type?: string | null
          loss_type_id?: string | null
          mortgage_company_id?: string | null
          mortgage_portal_password?: string | null
          mortgage_portal_site?: string | null
          mortgage_portal_username?: string | null
          org_id?: string | null
          other_structures_limit?: number | null
          partner_assigned_user_email?: string | null
          partner_assigned_user_id?: string | null
          partner_assigned_user_name?: string | null
          partner_construction_status?: string | null
          personal_property_limit?: number | null
          policy_number?: string | null
          policyholder_address?: string | null
          policyholder_email?: string | null
          policyholder_name?: string | null
          policyholder_phone?: string | null
          referrer_id?: string | null
          retention_purge_after?: string | null
          signature_cc_email?: string | null
          signed_pdf_url?: string | null
          ssn_last_four?: string | null
          state_code?: string | null
          status?: string | null
          sub_status_id?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Update: {
          adjuster_email?: string | null
          adjuster_name?: string | null
          adjuster_phone?: string | null
          ale_limit?: number | null
          automation_mode?: Database["public"]["Enums"]["automation_mode"]
          automation_resume_at?: string | null
          claim_amount?: number | null
          claim_email_id?: string | null
          claim_number?: string | null
          claim_tracking_number?: string | null
          client_id?: string | null
          construction_status?: string | null
          contract_pdf_path?: string | null
          created_at?: string | null
          date_claim_filed?: string | null
          deductible?: number | null
          dwelling_limit?: number | null
          esign_audit_url?: string | null
          esign_completed_at?: string | null
          esign_document_id?: string | null
          esign_error_message?: string | null
          esign_provider?: string | null
          esign_sent_at?: string | null
          esign_signing_link?: string | null
          esign_status?: string | null
          fedex_tracking_number?: string | null
          fraud_flag?: boolean | null
          fraud_flag_reason?: string | null
          fraud_flagged_at?: string | null
          fraud_flagged_by?: string | null
          geocoded_at?: string | null
          id?: string
          insurance_company?: string | null
          insurance_company_id?: string | null
          insurance_email?: string | null
          insurance_phone?: string | null
          is_closed?: boolean
          is_guided_mode?: boolean
          jobnimbus_job_id?: string | null
          last_activity_at?: string | null
          latest_signature_request_id?: string | null
          latitude?: number | null
          loan_number?: string | null
          longitude?: number | null
          loss_date?: string | null
          loss_description?: string | null
          loss_type?: string | null
          loss_type_id?: string | null
          mortgage_company_id?: string | null
          mortgage_portal_password?: string | null
          mortgage_portal_site?: string | null
          mortgage_portal_username?: string | null
          org_id?: string | null
          other_structures_limit?: number | null
          partner_assigned_user_email?: string | null
          partner_assigned_user_id?: string | null
          partner_assigned_user_name?: string | null
          partner_construction_status?: string | null
          personal_property_limit?: number | null
          policy_number?: string | null
          policyholder_address?: string | null
          policyholder_email?: string | null
          policyholder_name?: string | null
          policyholder_phone?: string | null
          referrer_id?: string | null
          retention_purge_after?: string | null
          signature_cc_email?: string | null
          signed_pdf_url?: string | null
          ssn_last_four?: string | null
          state_code?: string | null
          status?: string | null
          sub_status_id?: string | null
          updated_at?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "claims_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_insurance_company_id_fkey"
            columns: ["insurance_company_id"]
            isOneToOne: false
            referencedRelation: "insurance_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_latest_signature_request_id_fkey"
            columns: ["latest_signature_request_id"]
            isOneToOne: false
            referencedRelation: "signature_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_loss_type_id_fkey"
            columns: ["loss_type_id"]
            isOneToOne: false
            referencedRelation: "loss_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_mortgage_company_id_fkey"
            columns: ["mortgage_company_id"]
            isOneToOne: false
            referencedRelation: "mortgage_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_referrer_id_fkey"
            columns: ["referrer_id"]
            isOneToOne: false
            referencedRelation: "referrers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_sub_status_id_fkey"
            columns: ["sub_status_id"]
            isOneToOne: false
            referencedRelation: "claim_sub_statuses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      clawdbot_config: {
        Row: {
          active: boolean | null
          clawdbot_endpoint: string | null
          created_at: string
          id: string
          notification_preferences: Json | null
          updated_at: string
          user_id: string
          webhook_secret: string
        }
        Insert: {
          active?: boolean | null
          clawdbot_endpoint?: string | null
          created_at?: string
          id?: string
          notification_preferences?: Json | null
          updated_at?: string
          user_id: string
          webhook_secret: string
        }
        Update: {
          active?: boolean | null
          clawdbot_endpoint?: string | null
          created_at?: string
          id?: string
          notification_preferences?: Json | null
          updated_at?: string
          user_id?: string
          webhook_secret?: string
        }
        Relationships: []
      }
      clawdbot_message_log: {
        Row: {
          action_type: string | null
          claim_id: string | null
          created_at: string
          direction: string
          id: string
          message_content: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          action_type?: string | null
          claim_id?: string | null
          created_at?: string
          direction: string
          id?: string
          message_content: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          action_type?: string | null
          claim_id?: string | null
          created_at?: string
          direction?: string
          id?: string
          message_content?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "clawdbot_message_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "clawdbot_message_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "clawdbot_message_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      client_portal_pins: {
        Row: {
          client_name: string | null
          created_at: string
          id: string
          pin: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_name?: string | null
          created_at?: string
          id?: string
          pin: string
          updated_at?: string
          user_id: string
        }
        Update: {
          client_name?: string | null
          created_at?: string
          id?: string
          pin?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_portal_pins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          city: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
          policy_number: string | null
          state: string | null
          street: string | null
          stripe_account_id: string | null
          updated_at: string | null
          user_id: string | null
          zip_code: string | null
        }
        Insert: {
          city?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          policy_number?: string | null
          state?: string | null
          street?: string | null
          stripe_account_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          zip_code?: string | null
        }
        Update: {
          city?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          policy_number?: string | null
          state?: string | null
          street?: string | null
          stripe_account_id?: string | null
          updated_at?: string | null
          user_id?: string | null
          zip_code?: string | null
        }
        Relationships: []
      }
      company_branding: {
        Row: {
          automation_exclude_claims_older_than_days: number | null
          automation_exclude_statuses: string[] | null
          automations_enabled: boolean | null
          company_address: string | null
          company_email: string | null
          company_name: string | null
          company_phone: string | null
          created_at: string
          endorsement_email_body: string | null
          endorsement_email_button_color: string | null
          endorsement_email_header_color: string | null
          endorsement_email_subject: string | null
          endorsement_reminder_body: string | null
          endorsement_reminder_subject: string | null
          esign_date_height: number | null
          esign_date_page: number | null
          esign_date_width: number | null
          esign_date_x: number | null
          esign_date_y: number | null
          esign_email_body: string | null
          esign_email_button_color: string | null
          esign_email_header_color: string | null
          esign_email_subject: string | null
          esign_signature_height: number | null
          esign_signature_page: number | null
          esign_signature_width: number | null
          esign_signature_x: number | null
          esign_signature_y: number | null
          id: string
          letterhead_url: string | null
          online_check_writer_bank_account_id: string | null
          updated_at: string
          zapier_webhook_url: string | null
        }
        Insert: {
          automation_exclude_claims_older_than_days?: number | null
          automation_exclude_statuses?: string[] | null
          automations_enabled?: boolean | null
          company_address?: string | null
          company_email?: string | null
          company_name?: string | null
          company_phone?: string | null
          created_at?: string
          endorsement_email_body?: string | null
          endorsement_email_button_color?: string | null
          endorsement_email_header_color?: string | null
          endorsement_email_subject?: string | null
          endorsement_reminder_body?: string | null
          endorsement_reminder_subject?: string | null
          esign_date_height?: number | null
          esign_date_page?: number | null
          esign_date_width?: number | null
          esign_date_x?: number | null
          esign_date_y?: number | null
          esign_email_body?: string | null
          esign_email_button_color?: string | null
          esign_email_header_color?: string | null
          esign_email_subject?: string | null
          esign_signature_height?: number | null
          esign_signature_page?: number | null
          esign_signature_width?: number | null
          esign_signature_x?: number | null
          esign_signature_y?: number | null
          id?: string
          letterhead_url?: string | null
          online_check_writer_bank_account_id?: string | null
          updated_at?: string
          zapier_webhook_url?: string | null
        }
        Update: {
          automation_exclude_claims_older_than_days?: number | null
          automation_exclude_statuses?: string[] | null
          automations_enabled?: boolean | null
          company_address?: string | null
          company_email?: string | null
          company_name?: string | null
          company_phone?: string | null
          created_at?: string
          endorsement_email_body?: string | null
          endorsement_email_button_color?: string | null
          endorsement_email_header_color?: string | null
          endorsement_email_subject?: string | null
          endorsement_reminder_body?: string | null
          endorsement_reminder_subject?: string | null
          esign_date_height?: number | null
          esign_date_page?: number | null
          esign_date_width?: number | null
          esign_date_x?: number | null
          esign_date_y?: number | null
          esign_email_body?: string | null
          esign_email_button_color?: string | null
          esign_email_header_color?: string | null
          esign_email_subject?: string | null
          esign_signature_height?: number | null
          esign_signature_page?: number | null
          esign_signature_width?: number | null
          esign_signature_x?: number | null
          esign_signature_y?: number | null
          id?: string
          letterhead_url?: string | null
          online_check_writer_bank_account_id?: string | null
          updated_at?: string
          zapier_webhook_url?: string | null
        }
        Relationships: []
      }
      contractor_claim_invites: {
        Row: {
          claim_id: string
          contractor_id: string
          created_at: string
          id: string
          invited_by: string | null
          message: string | null
          org_id: string
          responded_at: string | null
          status: string
          token: string
          updated_at: string
        }
        Insert: {
          claim_id: string
          contractor_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          message?: string | null
          org_id: string
          responded_at?: string | null
          status?: string
          token?: string
          updated_at?: string
        }
        Update: {
          claim_id?: string
          contractor_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          message?: string | null
          org_id?: string
          responded_at?: string | null
          status?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contractor_claim_invites_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "contractor_claim_invites_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "contractor_claim_invites_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_claim_invites_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor_directory_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_claim_invites_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_claim_invites_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      contractor_documents: {
        Row: {
          contractor_id: string
          created_at: string
          document_name: string
          document_type: string
          expiration_date: string | null
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          id: string
          notes: string | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          contractor_id: string
          created_at?: string
          document_name: string
          document_type: string
          expiration_date?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          contractor_id?: string
          created_at?: string
          document_name?: string
          document_type?: string
          expiration_date?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      contractor_profiles: {
        Row: {
          admin_disbursed_verified: boolean
          avatar_url: string | null
          bio: string | null
          coi_expires_at: string | null
          created_at: string
          directory_opt_in: boolean
          display_name: string
          has_open_disputes: boolean
          home_base_lat: number | null
          home_base_lng: number | null
          id: string
          is_directory_listed: boolean
          license_number: string | null
          pro_approved_at: string | null
          pro_approved_by: string | null
          service_metros: string[]
          service_radius_miles: number | null
          service_states: string[]
          service_zip_prefixes: string[]
          tier: string
          trades: string[]
          updated_at: string
          user_id: string
          verification_notes: string | null
          verified_at: string | null
        }
        Insert: {
          admin_disbursed_verified?: boolean
          avatar_url?: string | null
          bio?: string | null
          coi_expires_at?: string | null
          created_at?: string
          directory_opt_in?: boolean
          display_name: string
          has_open_disputes?: boolean
          home_base_lat?: number | null
          home_base_lng?: number | null
          id?: string
          is_directory_listed?: boolean
          license_number?: string | null
          pro_approved_at?: string | null
          pro_approved_by?: string | null
          service_metros?: string[]
          service_radius_miles?: number | null
          service_states?: string[]
          service_zip_prefixes?: string[]
          tier?: string
          trades?: string[]
          updated_at?: string
          user_id: string
          verification_notes?: string | null
          verified_at?: string | null
        }
        Update: {
          admin_disbursed_verified?: boolean
          avatar_url?: string | null
          bio?: string | null
          coi_expires_at?: string | null
          created_at?: string
          directory_opt_in?: boolean
          display_name?: string
          has_open_disputes?: boolean
          home_base_lat?: number | null
          home_base_lng?: number | null
          id?: string
          is_directory_listed?: boolean
          license_number?: string | null
          pro_approved_at?: string | null
          pro_approved_by?: string | null
          service_metros?: string[]
          service_radius_miles?: number | null
          service_states?: string[]
          service_zip_prefixes?: string[]
          tier?: string
          trades?: string[]
          updated_at?: string
          user_id?: string
          verification_notes?: string | null
          verified_at?: string | null
        }
        Relationships: []
      }
      contractor_reviews: {
        Row: {
          author_user_id: string | null
          claim_id: string | null
          comment: string | null
          contractor_id: string
          created_at: string
          id: string
          org_id: string
          rating: number
          updated_at: string
        }
        Insert: {
          author_user_id?: string | null
          claim_id?: string | null
          comment?: string | null
          contractor_id: string
          created_at?: string
          id?: string
          org_id: string
          rating: number
          updated_at?: string
        }
        Update: {
          author_user_id?: string | null
          claim_id?: string | null
          comment?: string | null
          contractor_id?: string
          created_at?: string
          id?: string
          org_id?: string
          rating?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contractor_reviews_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "contractor_reviews_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "contractor_reviews_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_reviews_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor_directory_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_reviews_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractor_reviews_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      counter_arguments: {
        Row: {
          created_at: string
          created_by: string | null
          denial_category: string
          denial_keywords: string[] | null
          denial_reason: string
          id: string
          is_active: boolean | null
          legal_citations: string | null
          rebuttal_template: string
          success_rate: number | null
          updated_at: string
          usage_count: number | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          denial_category: string
          denial_keywords?: string[] | null
          denial_reason: string
          id?: string
          is_active?: boolean | null
          legal_citations?: string | null
          rebuttal_template: string
          success_rate?: number | null
          updated_at?: string
          usage_count?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          denial_category?: string
          denial_keywords?: string[] | null
          denial_reason?: string
          id?: string
          is_active?: boolean | null
          legal_citations?: string | null
          rebuttal_template?: string
          success_rate?: number | null
          updated_at?: string
          usage_count?: number | null
        }
        Relationships: []
      }
      custom_fields: {
        Row: {
          created_at: string
          created_by: string | null
          display_order: number | null
          field_type: string
          id: string
          is_active: boolean | null
          is_required: boolean | null
          label: string
          name: string
          options: Json | null
          updated_at: string
          visible_on_statuses: string[] | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          display_order?: number | null
          field_type: string
          id?: string
          is_active?: boolean | null
          is_required?: boolean | null
          label: string
          name: string
          options?: Json | null
          updated_at?: string
          visible_on_statuses?: string[] | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          display_order?: number | null
          field_type?: string
          id?: string
          is_active?: boolean | null
          is_required?: boolean | null
          label?: string
          name?: string
          options?: Json | null
          updated_at?: string
          visible_on_statuses?: string[] | null
        }
        Relationships: []
      }
      darwin_action_log: {
        Row: {
          action_details: Json | null
          action_type: string
          claim_id: string | null
          created_by: string | null
          error_message: string | null
          executed_at: string | null
          id: string
          result: string | null
          trigger_source: string | null
          was_auto_executed: boolean | null
        }
        Insert: {
          action_details?: Json | null
          action_type: string
          claim_id?: string | null
          created_by?: string | null
          error_message?: string | null
          executed_at?: string | null
          id?: string
          result?: string | null
          trigger_source?: string | null
          was_auto_executed?: boolean | null
        }
        Update: {
          action_details?: Json | null
          action_type?: string
          claim_id?: string | null
          created_by?: string | null
          error_message?: string | null
          executed_at?: string | null
          id?: string
          result?: string | null
          trigger_source?: string | null
          was_auto_executed?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "darwin_action_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_action_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_action_log_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_analysis_results: {
        Row: {
          analysis_type: string
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          input_summary: string | null
          metadata: Json | null
          pdf_file_name: string | null
          result: string
        }
        Insert: {
          analysis_type: string
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          input_summary?: string | null
          metadata?: Json | null
          pdf_file_name?: string | null
          result: string
        }
        Update: {
          analysis_type?: string
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          input_summary?: string | null
          metadata?: Json | null
          pdf_file_name?: string | null
          result?: string
        }
        Relationships: [
          {
            foreignKeyName: "darwin_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_declared_position_audit_logs: {
        Row: {
          action: string
          after_json: Json | null
          before_json: Json | null
          claim_id: string
          created_at: string
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          after_json?: Json | null
          before_json?: Json | null
          claim_id: string
          created_at?: string
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          after_json?: Json | null
          before_json?: Json | null
          claim_id?: string
          created_at?: string
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      darwin_declared_positions: {
        Row: {
          carrier_dependency_statement: string | null
          carrier_evidence_rebutted: Json
          claim_id: string
          claim_type: string | null
          confidence_level: string | null
          coverage_trigger_theory: string | null
          created_at: string
          created_by: string | null
          decisive_contradiction: string | null
          drift_risk: string | null
          id: string
          key_supporting_evidence: Json
          known_weaknesses: Json
          lock_status: string
          master_position_statement: string | null
          missing_inputs: string[] | null
          missing_proof_needed: Json
          observed_damage_condition: string | null
          policy_standard_support: Json
          position_locked: boolean
          position_strength_label: string | null
          position_strength_score: number | null
          primary_carrier_error: string | null
          primary_cause_of_loss: string | null
          primary_coverage_theory: string | null
          primary_loss_mechanism: string | null
          provisional_reason: string | null
          reasoning_complete: boolean
          requested_remedy: string | null
          risk_flags: string[] | null
          specific_carrier_failure: string | null
          strategic_notes: string | null
          updated_at: string
        }
        Insert: {
          carrier_dependency_statement?: string | null
          carrier_evidence_rebutted?: Json
          claim_id: string
          claim_type?: string | null
          confidence_level?: string | null
          coverage_trigger_theory?: string | null
          created_at?: string
          created_by?: string | null
          decisive_contradiction?: string | null
          drift_risk?: string | null
          id?: string
          key_supporting_evidence?: Json
          known_weaknesses?: Json
          lock_status?: string
          master_position_statement?: string | null
          missing_inputs?: string[] | null
          missing_proof_needed?: Json
          observed_damage_condition?: string | null
          policy_standard_support?: Json
          position_locked?: boolean
          position_strength_label?: string | null
          position_strength_score?: number | null
          primary_carrier_error?: string | null
          primary_cause_of_loss?: string | null
          primary_coverage_theory?: string | null
          primary_loss_mechanism?: string | null
          provisional_reason?: string | null
          reasoning_complete?: boolean
          requested_remedy?: string | null
          risk_flags?: string[] | null
          specific_carrier_failure?: string | null
          strategic_notes?: string | null
          updated_at?: string
        }
        Update: {
          carrier_dependency_statement?: string | null
          carrier_evidence_rebutted?: Json
          claim_id?: string
          claim_type?: string | null
          confidence_level?: string | null
          coverage_trigger_theory?: string | null
          created_at?: string
          created_by?: string | null
          decisive_contradiction?: string | null
          drift_risk?: string | null
          id?: string
          key_supporting_evidence?: Json
          known_weaknesses?: Json
          lock_status?: string
          master_position_statement?: string | null
          missing_inputs?: string[] | null
          missing_proof_needed?: Json
          observed_damage_condition?: string | null
          policy_standard_support?: Json
          position_locked?: boolean
          position_strength_label?: string | null
          position_strength_score?: number | null
          primary_carrier_error?: string | null
          primary_cause_of_loss?: string | null
          primary_coverage_theory?: string | null
          primary_loss_mechanism?: string | null
          provisional_reason?: string | null
          reasoning_complete?: boolean
          requested_remedy?: string | null
          risk_flags?: string[] | null
          specific_carrier_failure?: string | null
          strategic_notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "darwin_declared_positions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_declared_positions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_declared_positions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_estimate_lines: {
        Row: {
          acv_total: number | null
          carrier_quantity: number | null
          carrier_total: number | null
          carrier_unit_price: number | null
          category: string
          claim_id: string
          code_reference: string | null
          created_at: string | null
          depreciation_amount: number | null
          depreciation_pct: number | null
          description: string
          id: string
          include_overhead: boolean | null
          include_profit: boolean | null
          is_accepted: boolean | null
          is_suggested: boolean | null
          notes: string | null
          overhead_pct: number | null
          profit_pct: number | null
          quantity: number
          rationale: string | null
          rcv_total: number | null
          reason_tag: string | null
          rebuttal_strength_score: number | null
          recovery_impact_rank: number | null
          sort_order: number | null
          source: string | null
          source_analysis_id: string | null
          trade: string | null
          unit: string | null
          unit_price: number
          updated_at: string | null
          used_in_rebuttal: boolean | null
          variance_amount: number | null
        }
        Insert: {
          acv_total?: number | null
          carrier_quantity?: number | null
          carrier_total?: number | null
          carrier_unit_price?: number | null
          category?: string
          claim_id: string
          code_reference?: string | null
          created_at?: string | null
          depreciation_amount?: number | null
          depreciation_pct?: number | null
          description: string
          id?: string
          include_overhead?: boolean | null
          include_profit?: boolean | null
          is_accepted?: boolean | null
          is_suggested?: boolean | null
          notes?: string | null
          overhead_pct?: number | null
          profit_pct?: number | null
          quantity?: number
          rationale?: string | null
          rcv_total?: number | null
          reason_tag?: string | null
          rebuttal_strength_score?: number | null
          recovery_impact_rank?: number | null
          sort_order?: number | null
          source?: string | null
          source_analysis_id?: string | null
          trade?: string | null
          unit?: string | null
          unit_price?: number
          updated_at?: string | null
          used_in_rebuttal?: boolean | null
          variance_amount?: number | null
        }
        Update: {
          acv_total?: number | null
          carrier_quantity?: number | null
          carrier_total?: number | null
          carrier_unit_price?: number | null
          category?: string
          claim_id?: string
          code_reference?: string | null
          created_at?: string | null
          depreciation_amount?: number | null
          depreciation_pct?: number | null
          description?: string
          id?: string
          include_overhead?: boolean | null
          include_profit?: boolean | null
          is_accepted?: boolean | null
          is_suggested?: boolean | null
          notes?: string | null
          overhead_pct?: number | null
          profit_pct?: number | null
          quantity?: number
          rationale?: string | null
          rcv_total?: number | null
          reason_tag?: string | null
          rebuttal_strength_score?: number | null
          recovery_impact_rank?: number | null
          sort_order?: number | null
          source?: string | null
          source_analysis_id?: string | null
          trade?: string | null
          unit?: string | null
          unit_price?: number
          updated_at?: string | null
          used_in_rebuttal?: boolean | null
          variance_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "darwin_estimate_lines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_estimate_lines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_estimate_lines_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_feedback_events: {
        Row: {
          actual_outcome: string | null
          actual_recovery_delta: number | null
          claim_id: string | null
          created_at: string
          feedback_detail: string | null
          feedback_type: string
          id: string
          output_id: string | null
          output_snapshot: Json | null
          output_type: string
          user_id: string | null
        }
        Insert: {
          actual_outcome?: string | null
          actual_recovery_delta?: number | null
          claim_id?: string | null
          created_at?: string
          feedback_detail?: string | null
          feedback_type: string
          id?: string
          output_id?: string | null
          output_snapshot?: Json | null
          output_type: string
          user_id?: string | null
        }
        Update: {
          actual_outcome?: string | null
          actual_recovery_delta?: number | null
          claim_id?: string | null
          created_at?: string
          feedback_detail?: string | null
          feedback_type?: string
          id?: string
          output_id?: string | null
          output_snapshot?: Json | null
          output_type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "darwin_feedback_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_feedback_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_feedback_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_health_checks: {
        Row: {
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          result: Json
          status: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          result?: Json
          status?: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          result?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "darwin_health_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_health_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_health_checks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_jobs: {
        Row: {
          claimed_by: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          heartbeat_at: string | null
          id: string
          job_type: string
          started_at: string | null
          status: string
          ttl_seconds: number
          updated_at: string
        }
        Insert: {
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          job_type: string
          started_at?: string | null
          status?: string
          ttl_seconds?: number
          updated_at?: string
        }
        Update: {
          claimed_by?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          heartbeat_at?: string | null
          id?: string
          job_type?: string
          started_at?: string | null
          status?: string
          ttl_seconds?: number
          updated_at?: string
        }
        Relationships: []
      }
      darwin_roof_tuning_heuristics: {
        Row: {
          action_type: string
          adjustment_absolute: number | null
          adjustment_factor: number | null
          adjustment_field: string | null
          auto_derived: boolean
          avg_accuracy_score: number | null
          avg_pct_delta: number | null
          common_failures: Json | null
          conflict_group: string | null
          created_at: string
          created_by: string | null
          effective_from: string | null
          evidence_summary: string | null
          expires_at: string | null
          failure_rate: number | null
          governance_notes: string | null
          governance_status: string
          heuristic_key: string
          heuristic_type: string
          id: string
          is_active: boolean
          last_computed_at: string | null
          last_validation_support_at: string | null
          manually_overridden: boolean
          max_adjustment_factor: number
          max_confidence_penalty: number
          median_pct_delta: number | null
          min_adjustment_factor: number
          min_sample_size: number
          priority: number
          sample_size: number
          segment_aspect_ratio_max: number | null
          segment_aspect_ratio_min: number | null
          segment_carrier: string | null
          segment_confidence_max: number | null
          segment_confidence_min: number | null
          segment_geometry_source: string | null
          segment_quality_score_max: number | null
          segment_quality_score_min: number | null
          segment_region: string | null
          segment_roof_form: string | null
          shadow_mode: boolean
          shadow_mode_hits: number
          shadow_mode_min_hits: number
          shadow_mode_predicted_impacts: Json | null
          shadow_mode_promoted_at: string | null
          staleness_days: number
          suppress_below_confidence: number | null
          suppress_field: string | null
          updated_at: string
          validation_ids: Json | null
        }
        Insert: {
          action_type?: string
          adjustment_absolute?: number | null
          adjustment_factor?: number | null
          adjustment_field?: string | null
          auto_derived?: boolean
          avg_accuracy_score?: number | null
          avg_pct_delta?: number | null
          common_failures?: Json | null
          conflict_group?: string | null
          created_at?: string
          created_by?: string | null
          effective_from?: string | null
          evidence_summary?: string | null
          expires_at?: string | null
          failure_rate?: number | null
          governance_notes?: string | null
          governance_status?: string
          heuristic_key: string
          heuristic_type?: string
          id?: string
          is_active?: boolean
          last_computed_at?: string | null
          last_validation_support_at?: string | null
          manually_overridden?: boolean
          max_adjustment_factor?: number
          max_confidence_penalty?: number
          median_pct_delta?: number | null
          min_adjustment_factor?: number
          min_sample_size?: number
          priority?: number
          sample_size?: number
          segment_aspect_ratio_max?: number | null
          segment_aspect_ratio_min?: number | null
          segment_carrier?: string | null
          segment_confidence_max?: number | null
          segment_confidence_min?: number | null
          segment_geometry_source?: string | null
          segment_quality_score_max?: number | null
          segment_quality_score_min?: number | null
          segment_region?: string | null
          segment_roof_form?: string | null
          shadow_mode?: boolean
          shadow_mode_hits?: number
          shadow_mode_min_hits?: number
          shadow_mode_predicted_impacts?: Json | null
          shadow_mode_promoted_at?: string | null
          staleness_days?: number
          suppress_below_confidence?: number | null
          suppress_field?: string | null
          updated_at?: string
          validation_ids?: Json | null
        }
        Update: {
          action_type?: string
          adjustment_absolute?: number | null
          adjustment_factor?: number | null
          adjustment_field?: string | null
          auto_derived?: boolean
          avg_accuracy_score?: number | null
          avg_pct_delta?: number | null
          common_failures?: Json | null
          conflict_group?: string | null
          created_at?: string
          created_by?: string | null
          effective_from?: string | null
          evidence_summary?: string | null
          expires_at?: string | null
          failure_rate?: number | null
          governance_notes?: string | null
          governance_status?: string
          heuristic_key?: string
          heuristic_type?: string
          id?: string
          is_active?: boolean
          last_computed_at?: string | null
          last_validation_support_at?: string | null
          manually_overridden?: boolean
          max_adjustment_factor?: number
          max_confidence_penalty?: number
          median_pct_delta?: number | null
          min_adjustment_factor?: number
          min_sample_size?: number
          priority?: number
          sample_size?: number
          segment_aspect_ratio_max?: number | null
          segment_aspect_ratio_min?: number | null
          segment_carrier?: string | null
          segment_confidence_max?: number | null
          segment_confidence_min?: number | null
          segment_geometry_source?: string | null
          segment_quality_score_max?: number | null
          segment_quality_score_min?: number | null
          segment_region?: string | null
          segment_roof_form?: string | null
          shadow_mode?: boolean
          shadow_mode_hits?: number
          shadow_mode_min_hits?: number
          shadow_mode_predicted_impacts?: Json | null
          shadow_mode_promoted_at?: string | null
          staleness_days?: number
          suppress_below_confidence?: number | null
          suppress_field?: string | null
          updated_at?: string
          validation_ids?: Json | null
        }
        Relationships: []
      }
      darwin_sms_activity: {
        Row: {
          action_type: string | null
          approved_at: string | null
          approved_by: string | null
          claim_id: string | null
          created_at: string
          darwin_response: string | null
          direction: string
          error_message: string | null
          id: string
          message_text: string
          metadata: Json | null
          needs_approval: boolean | null
          parsed_intent: string | null
          phone_number: string
          result_id: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          action_type?: string | null
          approved_at?: string | null
          approved_by?: string | null
          claim_id?: string | null
          created_at?: string
          darwin_response?: string | null
          direction: string
          error_message?: string | null
          id?: string
          message_text: string
          metadata?: Json | null
          needs_approval?: boolean | null
          parsed_intent?: string | null
          phone_number: string
          result_id?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          action_type?: string | null
          approved_at?: string | null
          approved_by?: string | null
          claim_id?: string | null
          created_at?: string
          darwin_response?: string | null
          direction?: string
          error_message?: string | null
          id?: string
          message_text?: string
          metadata?: Json | null
          needs_approval?: boolean | null
          parsed_intent?: string | null
          phone_number?: string
          result_id?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "darwin_sms_activity_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_sms_activity_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "darwin_sms_activity_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_sms_settings: {
        Row: {
          auto_send_roles: string[] | null
          created_at: string
          id: string
          org_id: string
          send_mode: string
          updated_at: string
        }
        Insert: {
          auto_send_roles?: string[] | null
          created_at?: string
          id?: string
          org_id: string
          send_mode?: string
          updated_at?: string
        }
        Update: {
          auto_send_roles?: string[] | null
          created_at?: string
          id?: string
          org_id?: string
          send_mode?: string
          updated_at?: string
        }
        Relationships: []
      }
      deposit_attachments: {
        Row: {
          attachment_type: string
          created_at: string
          deposit_item_id: string
          file_name: string
          file_path: string
          file_size: number | null
          id: string
          notes: string | null
          uploaded_by: string | null
        }
        Insert: {
          attachment_type: string
          created_at?: string
          deposit_item_id: string
          file_name: string
          file_path: string
          file_size?: number | null
          id?: string
          notes?: string | null
          uploaded_by?: string | null
        }
        Update: {
          attachment_type?: string
          created_at?: string
          deposit_item_id?: string
          file_name?: string
          file_path?: string
          file_size?: number | null
          id?: string
          notes?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_attachments_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_attachments_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_attachments_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_attachments_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
        ]
      }
      deposit_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          amount: number | null
          batch_id: string | null
          created_at: string
          deposit_item_id: string | null
          id: string
          new_values: Json | null
          notes: string | null
          old_values: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          amount?: number | null
          batch_id?: string | null
          created_at?: string
          deposit_item_id?: string | null
          id?: string
          new_values?: Json | null
          notes?: string | null
          old_values?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          amount?: number | null
          batch_id?: string | null
          created_at?: string
          deposit_item_id?: string | null
          id?: string
          new_values?: Json | null
          notes?: string | null
          old_values?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_audit_log_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "deposit_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_audit_log_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_audit_log_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_audit_log_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_audit_log_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
        ]
      }
      deposit_automation_runs: {
        Row: {
          completed_at: string | null
          created_at: string | null
          deliveries_sent: number | null
          digests_generated: number | null
          duration_ms: number | null
          error_summary: string | null
          escalations_created: number | null
          id: string
          idempotency_key: string | null
          overload_flags: Json | null
          refresh_count: number | null
          run_date: string
          run_type: string
          started_at: string
          status: string
          steps_completed: Json | null
          steps_failed: Json | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          deliveries_sent?: number | null
          digests_generated?: number | null
          duration_ms?: number | null
          error_summary?: string | null
          escalations_created?: number | null
          id?: string
          idempotency_key?: string | null
          overload_flags?: Json | null
          refresh_count?: number | null
          run_date?: string
          run_type?: string
          started_at?: string
          status?: string
          steps_completed?: Json | null
          steps_failed?: Json | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          deliveries_sent?: number | null
          digests_generated?: number | null
          duration_ms?: number | null
          error_summary?: string | null
          escalations_created?: number | null
          id?: string
          idempotency_key?: string | null
          overload_flags?: Json | null
          refresh_count?: number | null
          run_date?: string
          run_type?: string
          started_at?: string
          status?: string
          steps_completed?: Json | null
          steps_failed?: Json | null
        }
        Relationships: []
      }
      deposit_automation_settings: {
        Row: {
          description: string | null
          id: string
          setting_key: string
          setting_value: Json
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          description?: string | null
          id?: string
          setting_key: string
          setting_value: Json
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          description?: string | null
          id?: string
          setting_key?: string
          setting_value?: Json
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      deposit_batches: {
        Row: {
          batch_number: string
          cleared_amount: number
          cleared_at: string | null
          created_at: string
          created_by: string | null
          failed_amount: number
          id: string
          notes: string | null
          provider: Database["public"]["Enums"]["deposit_provider"]
          status: Database["public"]["Enums"]["deposit_batch_status"]
          submitted_at: string | null
          total_amount: number
          total_items: number
          updated_at: string
        }
        Insert: {
          batch_number?: string
          cleared_amount?: number
          cleared_at?: string | null
          created_at?: string
          created_by?: string | null
          failed_amount?: number
          id?: string
          notes?: string | null
          provider: Database["public"]["Enums"]["deposit_provider"]
          status?: Database["public"]["Enums"]["deposit_batch_status"]
          submitted_at?: string | null
          total_amount?: number
          total_items?: number
          updated_at?: string
        }
        Update: {
          batch_number?: string
          cleared_amount?: number
          cleared_at?: string | null
          created_at?: string
          created_by?: string | null
          failed_amount?: number
          id?: string
          notes?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"]
          status?: Database["public"]["Enums"]["deposit_batch_status"]
          submitted_at?: string | null
          total_amount?: number
          total_items?: number
          updated_at?: string
        }
        Relationships: []
      }
      deposit_daily_digest: {
        Row: {
          closeout_ready_count: number | null
          digest_date: string
          digest_type: string
          generated_at: string
          generated_by: string | null
          id: string
          open_exceptions_count: number | null
          owner_workloads: Json | null
          sla_breaches_count: number | null
          summary: Json
          total_open_amount: number | null
          total_open_items: number | null
          unreconciled_cash: number | null
          unsynced_count: number | null
        }
        Insert: {
          closeout_ready_count?: number | null
          digest_date?: string
          digest_type?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          open_exceptions_count?: number | null
          owner_workloads?: Json | null
          sla_breaches_count?: number | null
          summary?: Json
          total_open_amount?: number | null
          total_open_items?: number | null
          unreconciled_cash?: number | null
          unsynced_count?: number | null
        }
        Update: {
          closeout_ready_count?: number | null
          digest_date?: string
          digest_type?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          open_exceptions_count?: number | null
          owner_workloads?: Json | null
          sla_breaches_count?: number | null
          summary?: Json
          total_open_amount?: number | null
          total_open_items?: number | null
          unreconciled_cash?: number | null
          unsynced_count?: number | null
        }
        Relationships: []
      }
      deposit_digest_delivery_log: {
        Row: {
          delivered_at: string | null
          delivery_method: string
          digest_id: string | null
          error_message: string | null
          id: string
          read_at: string | null
          recipient_id: string
          resent_at: string | null
          resent_by: string | null
        }
        Insert: {
          delivered_at?: string | null
          delivery_method?: string
          digest_id?: string | null
          error_message?: string | null
          id?: string
          read_at?: string | null
          recipient_id: string
          resent_at?: string | null
          resent_by?: string | null
        }
        Update: {
          delivered_at?: string | null
          delivery_method?: string
          digest_id?: string | null
          error_message?: string | null
          id?: string
          read_at?: string | null
          recipient_id?: string
          resent_at?: string | null
          resent_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_digest_delivery_log_digest_id_fkey"
            columns: ["digest_id"]
            isOneToOne: false
            referencedRelation: "deposit_daily_digest"
            referencedColumns: ["id"]
          },
        ]
      }
      deposit_escalation_events: {
        Row: {
          created_at: string | null
          deposit_item_id: string | null
          escalated_to: string | null
          escalation_type: string
          exception_id: string | null
          id: string
          is_resolved: boolean | null
          message: string | null
          resolved_at: string | null
          resolved_by: string | null
          rule_id: string | null
        }
        Insert: {
          created_at?: string | null
          deposit_item_id?: string | null
          escalated_to?: string | null
          escalation_type: string
          exception_id?: string | null
          id?: string
          is_resolved?: boolean | null
          message?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          rule_id?: string | null
        }
        Update: {
          created_at?: string | null
          deposit_item_id?: string | null
          escalated_to?: string | null
          escalation_type?: string
          exception_id?: string | null
          id?: string
          is_resolved?: boolean | null
          message?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          rule_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_escalation_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_escalation_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_escalation_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_escalation_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
          {
            foreignKeyName: "deposit_escalation_events_exception_id_fkey"
            columns: ["exception_id"]
            isOneToOne: false
            referencedRelation: "deposit_exceptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_escalation_events_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "deposit_escalation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      deposit_escalation_rules: {
        Row: {
          auto_flag: boolean | null
          auto_reassign: boolean | null
          created_at: string | null
          escalate_to_role: string | null
          id: string
          is_active: boolean | null
          notification_message: string | null
          priority: number | null
          rule_name: string
          threshold_amount: number | null
          threshold_days: number | null
          trigger_type: string
          updated_at: string | null
        }
        Insert: {
          auto_flag?: boolean | null
          auto_reassign?: boolean | null
          created_at?: string | null
          escalate_to_role?: string | null
          id?: string
          is_active?: boolean | null
          notification_message?: string | null
          priority?: number | null
          rule_name: string
          threshold_amount?: number | null
          threshold_days?: number | null
          trigger_type: string
          updated_at?: string | null
        }
        Update: {
          auto_flag?: boolean | null
          auto_reassign?: boolean | null
          created_at?: string | null
          escalate_to_role?: string | null
          id?: string
          is_active?: boolean | null
          notification_message?: string | null
          priority?: number | null
          rule_name?: string
          threshold_amount?: number | null
          threshold_days?: number | null
          trigger_type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      deposit_exceptions: {
        Row: {
          assigned_at: string | null
          created_at: string
          deposit_item_id: string
          description: string
          exception_code: string | null
          exception_type: string
          id: string
          owner_id: string | null
          provider: Database["public"]["Enums"]["deposit_provider"] | null
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
        }
        Insert: {
          assigned_at?: string | null
          created_at?: string
          deposit_item_id: string
          description: string
          exception_code?: string | null
          exception_type: string
          id?: string
          owner_id?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
        }
        Update: {
          assigned_at?: string | null
          created_at?: string
          deposit_item_id?: string
          description?: string
          exception_code?: string | null
          exception_type?: string
          id?: string
          owner_id?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "deposit_exceptions_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_exceptions_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_exceptions_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_exceptions_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
        ]
      }
      deposit_items: {
        Row: {
          accounting_synced_at: string | null
          amount: number
          bank_confirmed_at: string | null
          bank_confirmed_by: string | null
          bank_reference: string | null
          batch_id: string | null
          carrier_name: string | null
          check_id: string
          check_number: string | null
          claim_id: string | null
          cleared_at: string | null
          closeout_at: string | null
          closeout_by: string | null
          closeout_complete: boolean
          created_at: string
          deposit_slip_number: string | null
          exception_code: string | null
          exception_reason: string | null
          id: string
          idempotency_key: string
          increase_account_id: string | null
          increase_check_deposit_id: string | null
          increase_last_synced_at: string | null
          increase_raw_response: Json | null
          increase_status: string | null
          increase_submitted_at: string | null
          last_synced_at: string | null
          next_action: string | null
          next_action_generated_at: string | null
          next_action_reason: string | null
          nsf_flag: boolean | null
          owner_assigned_at: string | null
          owner_id: string | null
          provider: Database["public"]["Enums"]["deposit_provider"] | null
          provider_payload: Json | null
          provider_reference: string | null
          provider_response: Json | null
          provider_status_raw: Json | null
          reconciled_amount: number | null
          reconciled_at: string | null
          reconciled_by: string | null
          return_reason: string | null
          status: Database["public"]["Enums"]["deposit_item_status"]
          submitted_at: string | null
          updated_at: string
          variance_amount: number | null
          variance_reason: string | null
        }
        Insert: {
          accounting_synced_at?: string | null
          amount: number
          bank_confirmed_at?: string | null
          bank_confirmed_by?: string | null
          bank_reference?: string | null
          batch_id?: string | null
          carrier_name?: string | null
          check_id: string
          check_number?: string | null
          claim_id?: string | null
          cleared_at?: string | null
          closeout_at?: string | null
          closeout_by?: string | null
          closeout_complete?: boolean
          created_at?: string
          deposit_slip_number?: string | null
          exception_code?: string | null
          exception_reason?: string | null
          id?: string
          idempotency_key?: string
          increase_account_id?: string | null
          increase_check_deposit_id?: string | null
          increase_last_synced_at?: string | null
          increase_raw_response?: Json | null
          increase_status?: string | null
          increase_submitted_at?: string | null
          last_synced_at?: string | null
          next_action?: string | null
          next_action_generated_at?: string | null
          next_action_reason?: string | null
          nsf_flag?: boolean | null
          owner_assigned_at?: string | null
          owner_id?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          provider_payload?: Json | null
          provider_reference?: string | null
          provider_response?: Json | null
          provider_status_raw?: Json | null
          reconciled_amount?: number | null
          reconciled_at?: string | null
          reconciled_by?: string | null
          return_reason?: string | null
          status?: Database["public"]["Enums"]["deposit_item_status"]
          submitted_at?: string | null
          updated_at?: string
          variance_amount?: number | null
          variance_reason?: string | null
        }
        Update: {
          accounting_synced_at?: string | null
          amount?: number
          bank_confirmed_at?: string | null
          bank_confirmed_by?: string | null
          bank_reference?: string | null
          batch_id?: string | null
          carrier_name?: string | null
          check_id?: string
          check_number?: string | null
          claim_id?: string | null
          cleared_at?: string | null
          closeout_at?: string | null
          closeout_by?: string | null
          closeout_complete?: boolean
          created_at?: string
          deposit_slip_number?: string | null
          exception_code?: string | null
          exception_reason?: string | null
          id?: string
          idempotency_key?: string
          increase_account_id?: string | null
          increase_check_deposit_id?: string | null
          increase_last_synced_at?: string | null
          increase_raw_response?: Json | null
          increase_status?: string | null
          increase_submitted_at?: string | null
          last_synced_at?: string | null
          next_action?: string | null
          next_action_generated_at?: string | null
          next_action_reason?: string | null
          nsf_flag?: boolean | null
          owner_assigned_at?: string | null
          owner_id?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          provider_payload?: Json | null
          provider_reference?: string | null
          provider_response?: Json | null
          provider_status_raw?: Json | null
          reconciled_amount?: number | null
          reconciled_at?: string | null
          reconciled_by?: string | null
          return_reason?: string | null
          status?: Database["public"]["Enums"]["deposit_item_status"]
          submitted_at?: string | null
          updated_at?: string
          variance_amount?: number | null
          variance_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "deposit_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_items_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: true
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
        ]
      }
      deposit_manager_snapshots: {
        Row: {
          created_at: string
          exception_data: Json
          id: string
          kpi_data: Json
          owner_data: Json
          queue_data: Json
          snapshot_date: string
          snapshot_type: string
        }
        Insert: {
          created_at?: string
          exception_data?: Json
          id?: string
          kpi_data?: Json
          owner_data?: Json
          queue_data?: Json
          snapshot_date?: string
          snapshot_type?: string
        }
        Update: {
          created_at?: string
          exception_data?: Json
          id?: string
          kpi_data?: Json
          owner_data?: Json
          queue_data?: Json
          snapshot_date?: string
          snapshot_type?: string
        }
        Relationships: []
      }
      deposit_notification_prefs: {
        Row: {
          created_at: string | null
          digest_frequency: string
          id: string
          notify_closeout_ready: boolean | null
          notify_exception_assigned: boolean | null
          notify_rebalance: boolean | null
          notify_sla_breach: boolean | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          digest_frequency?: string
          id?: string
          notify_closeout_ready?: boolean | null
          notify_exception_assigned?: boolean | null
          notify_rebalance?: boolean | null
          notify_sla_breach?: boolean | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          digest_frequency?: string
          id?: string
          notify_closeout_ready?: boolean | null
          notify_exception_assigned?: boolean | null
          notify_rebalance?: boolean | null
          notify_sla_breach?: boolean | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      deposit_pending_approvals: {
        Row: {
          approval_type: string
          created_at: string | null
          description: string | null
          id: string
          item_count: number | null
          payload: Json
          requested_at: string | null
          requested_by: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          total_amount: number | null
        }
        Insert: {
          approval_type: string
          created_at?: string | null
          description?: string | null
          id?: string
          item_count?: number | null
          payload?: Json
          requested_at?: string | null
          requested_by: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          total_amount?: number | null
        }
        Update: {
          approval_type?: string
          created_at?: string | null
          description?: string | null
          id?: string
          item_count?: number | null
          payload?: Json
          requested_at?: string | null
          requested_by?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          total_amount?: number | null
        }
        Relationships: []
      }
      deposit_provider_attempts: {
        Row: {
          attempt_number: number
          completed_at: string | null
          created_at: string
          deposit_item_id: string
          error_message: string | null
          id: string
          idempotency_key: string
          provider: Database["public"]["Enums"]["deposit_provider"]
          request_payload: Json | null
          response_code: number | null
          response_payload: Json | null
          started_at: string
          status: string
        }
        Insert: {
          attempt_number?: number
          completed_at?: string | null
          created_at?: string
          deposit_item_id: string
          error_message?: string | null
          id?: string
          idempotency_key: string
          provider: Database["public"]["Enums"]["deposit_provider"]
          request_payload?: Json | null
          response_code?: number | null
          response_payload?: Json | null
          started_at?: string
          status?: string
        }
        Update: {
          attempt_number?: number
          completed_at?: string | null
          created_at?: string
          deposit_item_id?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string
          provider?: Database["public"]["Enums"]["deposit_provider"]
          request_payload?: Json | null
          response_code?: number | null
          response_payload?: Json | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "deposit_provider_attempts_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_provider_attempts_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_provider_attempts_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_provider_attempts_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
        ]
      }
      deposit_provider_config: {
        Row: {
          capabilities: Json | null
          config: Json | null
          created_at: string
          display_name: string
          id: string
          is_active: boolean
          is_stubbed: boolean
          provider: string
          updated_at: string
        }
        Insert: {
          capabilities?: Json | null
          config?: Json | null
          created_at?: string
          display_name: string
          id?: string
          is_active?: boolean
          is_stubbed?: boolean
          provider: string
          updated_at?: string
        }
        Update: {
          capabilities?: Json | null
          config?: Json | null
          created_at?: string
          display_name?: string
          id?: string
          is_active?: boolean
          is_stubbed?: boolean
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      deposit_webhook_events: {
        Row: {
          created_at: string
          deposit_item_id: string | null
          event_id: string | null
          event_type: string
          id: string
          idempotency_key: string | null
          payload: Json
          processed: boolean
          processed_at: string | null
          provider: Database["public"]["Enums"]["deposit_provider"]
          replay_of: string | null
        }
        Insert: {
          created_at?: string
          deposit_item_id?: string | null
          event_id?: string | null
          event_type: string
          id?: string
          idempotency_key?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
          provider: Database["public"]["Enums"]["deposit_provider"]
          replay_of?: string | null
        }
        Update: {
          created_at?: string
          deposit_item_id?: string | null
          event_id?: string | null
          event_type?: string
          id?: string
          idempotency_key?: string | null
          payload?: Json
          processed?: boolean
          processed_at?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"]
          replay_of?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deposit_webhook_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_webhook_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_webhook_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_webhook_events_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
          {
            foreignKeyName: "deposit_webhook_events_replay_of_fkey"
            columns: ["replay_of"]
            isOneToOne: false
            referencedRelation: "deposit_webhook_events"
            referencedColumns: ["id"]
          },
        ]
      }
      disbursement_batches: {
        Row: {
          available_amount: number
          check_amount: number
          check_intake_item_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string
          debit_account_id: string | null
          debit_actum_history_id: string | null
          debit_actum_order_id: string | null
          debit_status: string | null
          delivery_speed: string | null
          deposit_item_id: string | null
          id: string
          notes: string | null
          reserve_held: number
          reserve_released_at: string | null
          status: string
          submitted_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          available_amount: number
          check_amount: number
          check_intake_item_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by: string
          debit_account_id?: string | null
          debit_actum_history_id?: string | null
          debit_actum_order_id?: string | null
          debit_status?: string | null
          delivery_speed?: string | null
          deposit_item_id?: string | null
          id?: string
          notes?: string | null
          reserve_held?: number
          reserve_released_at?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          available_amount?: number
          check_amount?: number
          check_intake_item_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string
          debit_account_id?: string | null
          debit_actum_history_id?: string | null
          debit_actum_order_id?: string | null
          debit_status?: string | null
          delivery_speed?: string | null
          deposit_item_id?: string | null
          id?: string
          notes?: string | null
          reserve_held?: number
          reserve_released_at?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disbursement_batches_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_batches_debit_account_id_fkey"
            columns: ["debit_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_batches_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_aging_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_batches_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_batches_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_queue_scored"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_batches_deposit_item_id_fkey"
            columns: ["deposit_item_id"]
            isOneToOne: false
            referencedRelation: "deposit_reminder_queue"
            referencedColumns: ["deposit_item_id"]
          },
          {
            foreignKeyName: "disbursement_batches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      disbursement_splits: {
        Row: {
          actum_consumer_unique: string | null
          actum_history_id: string | null
          actum_order_id: string | null
          amount: number
          batch_id: string
          created_at: string
          external_check_number: string | null
          external_notes: string | null
          id: string
          idempotence_key: string | null
          method: string
          pct_of_total: number | null
          recipient_name: string | null
          recipient_type: string | null
          return_code: string | null
          return_desc: string | null
          returned_at: string | null
          settled_at: string | null
          stakeholder_account_id: string | null
          status: string
          submitted_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          actum_consumer_unique?: string | null
          actum_history_id?: string | null
          actum_order_id?: string | null
          amount: number
          batch_id: string
          created_at?: string
          external_check_number?: string | null
          external_notes?: string | null
          id?: string
          idempotence_key?: string | null
          method?: string
          pct_of_total?: number | null
          recipient_name?: string | null
          recipient_type?: string | null
          return_code?: string | null
          return_desc?: string | null
          returned_at?: string | null
          settled_at?: string | null
          stakeholder_account_id?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          actum_consumer_unique?: string | null
          actum_history_id?: string | null
          actum_order_id?: string | null
          amount?: number
          batch_id?: string
          created_at?: string
          external_check_number?: string | null
          external_notes?: string | null
          id?: string
          idempotence_key?: string | null
          method?: string
          pct_of_total?: number | null
          recipient_name?: string | null
          recipient_type?: string | null
          return_code?: string | null
          return_desc?: string | null
          returned_at?: string | null
          settled_at?: string | null
          stakeholder_account_id?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disbursement_splits_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "disbursement_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_splits_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disbursement_splits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      document_analysis_results: {
        Row: {
          carrier_name: string | null
          carrier_position: string | null
          claim_id: string
          claim_number_detected: string | null
          coverage_impact: string | null
          created_at: string
          created_by: string | null
          denial_rationales: string[] | null
          document_date: string | null
          document_type: string
          evidence_gaps: Json | null
          evidence_pack_type: string | null
          file_id: string | null
          file_name: string
          full_analysis: string | null
          id: string
          loss_type: string | null
          next_step: string | null
          precedent_claim_ids: string[] | null
          precedent_summary: Json | null
          source_mode: string | null
          state_code: string | null
          trade: string | null
          updated_at: string
        }
        Insert: {
          carrier_name?: string | null
          carrier_position?: string | null
          claim_id: string
          claim_number_detected?: string | null
          coverage_impact?: string | null
          created_at?: string
          created_by?: string | null
          denial_rationales?: string[] | null
          document_date?: string | null
          document_type: string
          evidence_gaps?: Json | null
          evidence_pack_type?: string | null
          file_id?: string | null
          file_name: string
          full_analysis?: string | null
          id?: string
          loss_type?: string | null
          next_step?: string | null
          precedent_claim_ids?: string[] | null
          precedent_summary?: Json | null
          source_mode?: string | null
          state_code?: string | null
          trade?: string | null
          updated_at?: string
        }
        Update: {
          carrier_name?: string | null
          carrier_position?: string | null
          claim_id?: string
          claim_number_detected?: string | null
          coverage_impact?: string | null
          created_at?: string
          created_by?: string | null
          denial_rationales?: string[] | null
          document_date?: string | null
          document_type?: string
          evidence_gaps?: Json | null
          evidence_pack_type?: string | null
          file_id?: string | null
          file_name?: string
          full_analysis?: string | null
          id?: string
          loss_type?: string | null
          next_step?: string | null
          precedent_claim_ids?: string[] | null
          precedent_summary?: Json | null
          source_mode?: string | null
          state_code?: string | null
          trade?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "document_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "document_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_analysis_results_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      document_intelligence_queue: {
        Row: {
          attempts: number
          claim_id: string
          completed_at: string | null
          created_at: string
          file_id: string
          id: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          run_after: string
          segment_id: string | null
          source_scope: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claim_id: string
          completed_at?: string | null
          created_at?: string
          file_id: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          run_after?: string
          segment_id?: string | null
          source_scope?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claim_id?: string
          completed_at?: string | null
          created_at?: string
          file_id?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          run_after?: string
          segment_id?: string | null
          source_scope?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_intelligence_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "document_intelligence_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "document_intelligence_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_intelligence_queue_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: true
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_intelligence_queue_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "claim_file_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      document_meaning_queue: {
        Row: {
          attempts: number
          claim_id: string
          completed_at: string | null
          created_at: string
          file_id: string
          id: string
          intelligence_id: string | null
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          run_after: string
          segment_id: string | null
          source_scope: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claim_id: string
          completed_at?: string | null
          created_at?: string
          file_id: string
          id?: string
          intelligence_id?: string | null
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          run_after?: string
          segment_id?: string | null
          source_scope?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claim_id?: string
          completed_at?: string | null
          created_at?: string
          file_id?: string
          id?: string
          intelligence_id?: string | null
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          run_after?: string
          segment_id?: string | null
          source_scope?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_meaning_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "document_meaning_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "document_meaning_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_meaning_queue_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_meaning_queue_intelligence_id_fkey"
            columns: ["intelligence_id"]
            isOneToOne: false
            referencedRelation: "claim_document_intelligence"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_meaning_queue_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "claim_file_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      document_templates: {
        Row: {
          category: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          file_name: string
          file_path: string
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          file_name: string
          file_path: string
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          file_name?: string
          file_path?: string
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      docupost_contacts: {
        Row: {
          address1: string
          address2: string | null
          city: string
          created_at: string
          created_by: string | null
          id: string
          label: string | null
          name: string
          org_id: string
          state: string
          updated_at: string
          zip: string
        }
        Insert: {
          address1: string
          address2?: string | null
          city: string
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string | null
          name: string
          org_id: string
          state: string
          updated_at?: string
          zip: string
        }
        Update: {
          address1?: string
          address2?: string | null
          city?: string
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string | null
          name?: string
          org_id?: string
          state?: string
          updated_at?: string
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "docupost_contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      email_connections: {
        Row: {
          created_at: string
          email_address: string
          encrypted_password: string
          id: string
          imap_host: string
          imap_port: number
          is_active: boolean
          last_sync_at: string | null
          last_sync_error: string | null
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_address: string
          encrypted_password: string
          id?: string
          imap_host?: string
          imap_port?: number
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          provider?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_address?: string
          encrypted_password?: string
          id?: string
          imap_host?: string
          imap_port?: number
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_send_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_templates: {
        Row: {
          body: string
          category: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          subject: string
          updated_at: string
        }
        Insert: {
          body: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          subject: string
          updated_at?: string
        }
        Update: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          subject?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      emails: {
        Row: {
          body: string
          claim_id: string
          created_at: string | null
          id: string
          provider_message_id: string | null
          recipient_email: string
          recipient_name: string | null
          recipient_type: string | null
          send_status: string | null
          sent_at: string | null
          sent_by: string | null
          subject: string
        }
        Insert: {
          body: string
          claim_id: string
          created_at?: string | null
          id?: string
          provider_message_id?: string | null
          recipient_email: string
          recipient_name?: string | null
          recipient_type?: string | null
          send_status?: string | null
          sent_at?: string | null
          sent_by?: string | null
          subject: string
        }
        Update: {
          body?: string
          claim_id?: string
          created_at?: string | null
          id?: string
          provider_message_id?: string | null
          recipient_email?: string
          recipient_name?: string | null
          recipient_type?: string | null
          send_status?: string | null
          sent_at?: string | null
          sent_by?: string | null
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "emails_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "emails_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      encryption_keys: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          key_id: string
          key_name: string
          rotated_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          key_id: string
          key_name: string
          rotated_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          key_id?: string
          key_name?: string
          rotated_at?: string | null
        }
        Relationships: []
      }
      endorsement_audit_log: {
        Row: {
          actor_id: string | null
          check_id: string
          created_at: string
          endorsement_id: string
          event_data: Json | null
          event_description: string | null
          event_type: string
          id: string
          ip_address: string | null
          user_agent: string | null
        }
        Insert: {
          actor_id?: string | null
          check_id: string
          created_at?: string
          endorsement_id: string
          event_data?: Json | null
          event_description?: string | null
          event_type: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
        }
        Update: {
          actor_id?: string | null
          check_id?: string
          created_at?: string
          endorsement_id?: string
          event_data?: Json | null
          event_description?: string | null
          event_type?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "endorsement_audit_log_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "endorsement_audit_log_endorsement_id_fkey"
            columns: ["endorsement_id"]
            isOneToOne: false
            referencedRelation: "check_endorsements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "endorsement_audit_log_endorsement_id_fkey"
            columns: ["endorsement_id"]
            isOneToOne: false
            referencedRelation: "stale_endorsements"
            referencedColumns: ["endorsement_id"]
          },
        ]
      }
      endorsement_automated_reminders: {
        Row: {
          endorsement_id: string
          id: string
          recipient_email: string
          reminder_number: number
          sent_at: string | null
          tenant_id: string | null
        }
        Insert: {
          endorsement_id: string
          id?: string
          recipient_email: string
          reminder_number: number
          sent_at?: string | null
          tenant_id?: string | null
        }
        Update: {
          endorsement_id?: string
          id?: string
          recipient_email?: string
          reminder_number?: number
          sent_at?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "endorsement_automated_reminders_endorsement_id_fkey"
            columns: ["endorsement_id"]
            isOneToOne: false
            referencedRelation: "check_endorsements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "endorsement_automated_reminders_endorsement_id_fkey"
            columns: ["endorsement_id"]
            isOneToOne: false
            referencedRelation: "stale_endorsements"
            referencedColumns: ["endorsement_id"]
          },
          {
            foreignKeyName: "endorsement_automated_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      endorsement_requests: {
        Row: {
          check_id: string
          created_at: string
          delivery_error: string | null
          delivery_status: string | null
          email_address: string | null
          endorsement_id: string
          id: string
          method: string
          phone_number: string | null
          sent_at: string
          sent_by: string | null
        }
        Insert: {
          check_id: string
          created_at?: string
          delivery_error?: string | null
          delivery_status?: string | null
          email_address?: string | null
          endorsement_id: string
          id?: string
          method: string
          phone_number?: string | null
          sent_at?: string
          sent_by?: string | null
        }
        Update: {
          check_id?: string
          created_at?: string
          delivery_error?: string | null
          delivery_status?: string | null
          email_address?: string | null
          endorsement_id?: string
          id?: string
          method?: string
          phone_number?: string | null
          sent_at?: string
          sent_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "endorsement_requests_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "endorsement_requests_endorsement_id_fkey"
            columns: ["endorsement_id"]
            isOneToOne: false
            referencedRelation: "check_endorsements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "endorsement_requests_endorsement_id_fkey"
            columns: ["endorsement_id"]
            isOneToOne: false
            referencedRelation: "stale_endorsements"
            referencedColumns: ["endorsement_id"]
          },
        ]
      }
      escalation_actions: {
        Row: {
          artifact_document_id: string | null
          artifact_type: string
          claim_id: string
          created_at: string
          created_by: string | null
          draft_content: string | null
          escalation_strength: string
          fired_rule_ids: string[]
          id: string
          state_code: string
          status: string
          updated_at: string
        }
        Insert: {
          artifact_document_id?: string | null
          artifact_type: string
          claim_id: string
          created_at?: string
          created_by?: string | null
          draft_content?: string | null
          escalation_strength: string
          fired_rule_ids?: string[]
          id?: string
          state_code: string
          status?: string
          updated_at?: string
        }
        Update: {
          artifact_document_id?: string | null
          artifact_type?: string
          claim_id?: string
          created_at?: string
          created_by?: string | null
          draft_content?: string | null
          escalation_strength?: string
          fired_rule_ids?: string[]
          id?: string
          state_code?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "escalation_actions_artifact_document_id_fkey"
            columns: ["artifact_document_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalation_actions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "escalation_actions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "escalation_actions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      escalation_artifact_templates: {
        Row: {
          artifact_type: string
          created_at: string
          id: string
          insert_block_type: string
          is_active: boolean
          state_code: string
          template_body: string
          updated_at: string
          version: number
        }
        Insert: {
          artifact_type: string
          created_at?: string
          id?: string
          insert_block_type: string
          is_active?: boolean
          state_code: string
          template_body: string
          updated_at?: string
          version?: number
        }
        Update: {
          artifact_type?: string
          created_at?: string
          id?: string
          insert_block_type?: string
          is_active?: boolean
          state_code?: string
          template_body?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      escalation_trigger_rules: {
        Row: {
          condition_logic: Json
          created_at: string
          escalation_strength: string
          id: string
          is_active: boolean
          priority_order: number
          recommended_action: string
          recommended_artifact: string | null
          regulation_citation: string
          regulation_summary: string
          state_code: string
          trigger_category: string
          trigger_name: string
          updated_at: string
        }
        Insert: {
          condition_logic?: Json
          created_at?: string
          escalation_strength: string
          id?: string
          is_active?: boolean
          priority_order?: number
          recommended_action: string
          recommended_artifact?: string | null
          regulation_citation: string
          regulation_summary: string
          state_code: string
          trigger_category: string
          trigger_name: string
          updated_at?: string
        }
        Update: {
          condition_logic?: Json
          created_at?: string
          escalation_strength?: string
          id?: string
          is_active?: boolean
          priority_order?: number
          recommended_action?: string
          recommended_artifact?: string | null
          regulation_citation?: string
          regulation_summary?: string
          state_code?: string
          trigger_category?: string
          trigger_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      esign_event_logs: {
        Row: {
          claim_id: string | null
          created_at: string | null
          id: string
          message: string | null
          payload: Json | null
          request_id: string | null
          signer_id: string | null
          stage: string
          status: string
        }
        Insert: {
          claim_id?: string | null
          created_at?: string | null
          id?: string
          message?: string | null
          payload?: Json | null
          request_id?: string | null
          signer_id?: string | null
          stage: string
          status: string
        }
        Update: {
          claim_id?: string | null
          created_at?: string | null
          id?: string
          message?: string | null
          payload?: Json | null
          request_id?: string | null
          signer_id?: string | null
          stage?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "esign_event_logs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "esign_event_logs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "esign_event_logs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esign_event_logs_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "signature_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esign_event_logs_signer_id_fkey"
            columns: ["signer_id"]
            isOneToOne: false
            referencedRelation: "signature_signers"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_effectiveness: {
        Row: {
          carrier_response: string | null
          claim_id: string | null
          created_at: string
          created_by: string | null
          evidence_category: string | null
          evidence_type: string
          id: string
          improvement_suggestions: Json | null
          moved_settlement: boolean | null
          quality_score: number | null
          settlement_impact_amount: number | null
          sufficiency_rating: string | null
          was_cited_in_settlement: boolean | null
        }
        Insert: {
          carrier_response?: string | null
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          evidence_category?: string | null
          evidence_type: string
          id?: string
          improvement_suggestions?: Json | null
          moved_settlement?: boolean | null
          quality_score?: number | null
          settlement_impact_amount?: number | null
          sufficiency_rating?: string | null
          was_cited_in_settlement?: boolean | null
        }
        Update: {
          carrier_response?: string | null
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          evidence_category?: string | null
          evidence_type?: string
          id?: string
          improvement_suggestions?: Json | null
          moved_settlement?: boolean | null
          quality_score?: number | null
          settlement_impact_amount?: number | null
          sufficiency_rating?: string | null
          was_cited_in_settlement?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "evidence_effectiveness_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "evidence_effectiveness_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "evidence_effectiveness_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses_categories: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      expenses_payees: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      extracted_document_data: {
        Row: {
          acv_total: number | null
          check_issue_date: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          date_confidence: number | null
          date_evidence: string | null
          deductible: number | null
          depreciation: number | null
          document_date: string | null
          document_type: string
          extracted_data: Json
          extraction_confidence: number | null
          id: string
          line_items: Json | null
          loss_date: string | null
          rcv_total: number | null
          received_date: string | null
          service_period_end: string | null
          service_period_start: string | null
          source_file_name: string | null
        }
        Insert: {
          acv_total?: number | null
          check_issue_date?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          date_confidence?: number | null
          date_evidence?: string | null
          deductible?: number | null
          depreciation?: number | null
          document_date?: string | null
          document_type: string
          extracted_data?: Json
          extraction_confidence?: number | null
          id?: string
          line_items?: Json | null
          loss_date?: string | null
          rcv_total?: number | null
          received_date?: string | null
          service_period_end?: string | null
          service_period_start?: string | null
          source_file_name?: string | null
        }
        Update: {
          acv_total?: number | null
          check_issue_date?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          date_confidence?: number | null
          date_evidence?: string | null
          deductible?: number | null
          depreciation?: number | null
          document_date?: string | null
          document_type?: string
          extracted_data?: Json
          extraction_confidence?: number | null
          id?: string
          line_items?: Json | null
          loss_date?: string | null
          rcv_total?: number | null
          received_date?: string | null
          service_period_end?: string | null
          service_period_start?: string | null
          source_file_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extracted_document_data_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "extracted_document_data_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "extracted_document_data_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      file_comments: {
        Row: {
          body: string
          created_at: string
          file_id: string
          id: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          file_id: string
          id?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          file_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "file_comments_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "claim_files"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_assets: {
        Row: {
          asset_type: string
          claim_id: string | null
          content_md: string | null
          created_at: string
          created_by: string | null
          id: string
          metadata_json: Json | null
          redacted: boolean | null
          title: string
          updated_at: string
        }
        Insert: {
          asset_type: string
          claim_id?: string | null
          content_md?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          metadata_json?: Json | null
          redacted?: boolean | null
          title: string
          updated_at?: string
        }
        Update: {
          asset_type?: string
          claim_id?: string | null
          content_md?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          metadata_json?: Json | null
          redacted?: boolean | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_assets_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "generated_assets_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "generated_assets_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      glba_security_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          description: string | null
          event_type: string
          id: string
          ip_address: unknown
          metadata: Json
          severity: string
          subject_record_id: string | null
          subject_record_type: string | null
          subject_user_id: string | null
          tenant_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          description?: string | null
          event_type: string
          id?: string
          ip_address?: unknown
          metadata?: Json
          severity?: string
          subject_record_id?: string | null
          subject_record_type?: string | null
          subject_user_id?: string | null
          tenant_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          description?: string | null
          event_type?: string
          id?: string
          ip_address?: unknown
          metadata?: Json
          severity?: string
          subject_record_id?: string | null
          subject_record_type?: string | null
          subject_user_id?: string | null
          tenant_id?: string | null
        }
        Relationships: []
      }
      global_automation_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          setting_key: string
          setting_value: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          setting_key: string
          setting_value?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          setting_key?: string
          setting_value?: Json
          updated_at?: string
        }
        Relationships: []
      }
      guided_claim_access: {
        Row: {
          claim_id: string
          created_at: string
          id: string
          relationship: string
          user_id: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          id?: string
          relationship?: string
          user_id: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          id?: string
          relationship?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guided_claim_access_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "guided_claim_access_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "guided_claim_access_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      guided_claim_map: {
        Row: {
          claim_id: string
          confidence: number | null
          created_at: string
          escalation_flags: Json | null
          id: string
          issue_summary: string | null
          missing_documents: Json | null
          pressure_points: Json | null
          recommended_next_step: string | null
          timeline: Json | null
          updated_at: string
        }
        Insert: {
          claim_id: string
          confidence?: number | null
          created_at?: string
          escalation_flags?: Json | null
          id?: string
          issue_summary?: string | null
          missing_documents?: Json | null
          pressure_points?: Json | null
          recommended_next_step?: string | null
          timeline?: Json | null
          updated_at?: string
        }
        Update: {
          claim_id?: string
          confidence?: number | null
          created_at?: string
          escalation_flags?: Json | null
          id?: string
          issue_summary?: string | null
          missing_documents?: Json | null
          pressure_points?: Json | null
          recommended_next_step?: string | null
          timeline?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guided_claim_map_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "guided_claim_map_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "guided_claim_map_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: true
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      guided_communications: {
        Row: {
          actual_attachments: Json | null
          analysis: Json | null
          body: string
          cc_email: string | null
          claim_id: string
          comm_type: string
          created_at: string
          id: string
          issue_summary: string | null
          marked_sent_at: string | null
          recipient_email: string | null
          recommended_attachments: Json | null
          response_file_id: string | null
          response_received_at: string | null
          sent_at: string | null
          sent_to: string | null
          short_body: string | null
          status: string
          subject: string | null
          task_type: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          actual_attachments?: Json | null
          analysis?: Json | null
          body: string
          cc_email?: string | null
          claim_id: string
          comm_type?: string
          created_at?: string
          id?: string
          issue_summary?: string | null
          marked_sent_at?: string | null
          recipient_email?: string | null
          recommended_attachments?: Json | null
          response_file_id?: string | null
          response_received_at?: string | null
          sent_at?: string | null
          sent_to?: string | null
          short_body?: string | null
          status?: string
          subject?: string | null
          task_type?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          actual_attachments?: Json | null
          analysis?: Json | null
          body?: string
          cc_email?: string | null
          claim_id?: string
          comm_type?: string
          created_at?: string
          id?: string
          issue_summary?: string | null
          marked_sent_at?: string | null
          recipient_email?: string | null
          recommended_attachments?: Json | null
          response_file_id?: string | null
          response_received_at?: string | null
          sent_at?: string | null
          sent_to?: string | null
          short_body?: string | null
          status?: string
          subject?: string | null
          task_type?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guided_communications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "guided_communications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "guided_communications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      hidden_loss_checklist_items: {
        Row: {
          category: string
          common_locations: string | null
          created_at: string
          description: string
          detection_tips: string | null
          display_order: number | null
          id: string
          is_active: boolean | null
          item_name: string
          loss_type: string
          typical_cost_range: string | null
        }
        Insert: {
          category: string
          common_locations?: string | null
          created_at?: string
          description: string
          detection_tips?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          item_name: string
          loss_type: string
          typical_cost_range?: string | null
        }
        Update: {
          category?: string
          common_locations?: string | null
          created_at?: string
          description?: string
          detection_tips?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          item_name?: string
          loss_type?: string
          typical_cost_range?: string | null
        }
        Relationships: []
      }
      homeowner_bank_link_tokens: {
        Row: {
          check_intake_item_id: string | null
          claim_id: string | null
          created_at: string
          expires_at: string
          homeowner_email: string
          homeowner_name: string
          id: string
          opened_at: string | null
          scope: string
          sent_by_user_id: string
          stakeholder_account_id: string | null
          status: string
          tenant_id: string
          token: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          check_intake_item_id?: string | null
          claim_id?: string | null
          created_at?: string
          expires_at?: string
          homeowner_email: string
          homeowner_name: string
          id?: string
          opened_at?: string | null
          scope: string
          sent_by_user_id: string
          stakeholder_account_id?: string | null
          status?: string
          tenant_id: string
          token: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          check_intake_item_id?: string | null
          claim_id?: string | null
          created_at?: string
          expires_at?: string
          homeowner_email?: string
          homeowner_name?: string
          id?: string
          opened_at?: string | null
          scope?: string
          sent_by_user_id?: string
          stakeholder_account_id?: string | null
          status?: string
          tenant_id?: string
          token?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_bank_link_tokens_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_bank_link_tokens_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_bank_link_tokens_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_bank_link_tokens_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_bank_link_tokens_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_bank_link_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      homeowner_check_uploads: {
        Row: {
          contractor_profile_id: string
          contractor_user_id: string
          converted_check_id: string | null
          created_at: string
          file_mime: string | null
          file_path: string
          homeowner_email: string
          homeowner_user_id: string | null
          id: string
          lead_id: string | null
          note: string | null
          status: string
          updated_at: string
        }
        Insert: {
          contractor_profile_id: string
          contractor_user_id: string
          converted_check_id?: string | null
          created_at?: string
          file_mime?: string | null
          file_path: string
          homeowner_email: string
          homeowner_user_id?: string | null
          id?: string
          lead_id?: string | null
          note?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          contractor_profile_id?: string
          contractor_user_id?: string
          converted_check_id?: string | null
          created_at?: string
          file_mime?: string | null
          file_path?: string
          homeowner_email?: string
          homeowner_user_id?: string | null
          id?: string
          lead_id?: string | null
          note?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_check_uploads_contractor_profile_id_fkey"
            columns: ["contractor_profile_id"]
            isOneToOne: false
            referencedRelation: "contractor_directory_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_check_uploads_contractor_profile_id_fkey"
            columns: ["contractor_profile_id"]
            isOneToOne: false
            referencedRelation: "contractor_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_check_uploads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "homeowner_intro_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      homeowner_directory_leads: {
        Row: {
          action: string
          contractor_id: string | null
          created_at: string
          email: string
          id: string
          referrer: string | null
          user_agent: string | null
          zip: string
        }
        Insert: {
          action?: string
          contractor_id?: string | null
          created_at?: string
          email: string
          id?: string
          referrer?: string | null
          user_agent?: string | null
          zip: string
        }
        Update: {
          action?: string
          contractor_id?: string | null
          created_at?: string
          email?: string
          id?: string
          referrer?: string | null
          user_agent?: string | null
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_directory_leads_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor_directory_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_directory_leads_contractor_id_fkey"
            columns: ["contractor_id"]
            isOneToOne: false
            referencedRelation: "contractor_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      homeowner_intro_requests: {
        Row: {
          accepted_at: string | null
          access_token: string
          contacted_at: string | null
          contractor_profile_id: string
          contractor_user_id: string
          created_at: string
          dtp_claim_number: string | null
          dtp_insurance_carrier: string | null
          dtp_policy_number: string | null
          dtp_property_address: string | null
          dtp_signature_ip: string | null
          dtp_signature_name: string | null
          dtp_signature_user_agent: string | null
          dtp_signed_at: string | null
          homeowner_email: string
          homeowner_name: string
          homeowner_phone: string | null
          id: string
          ip_hash: string | null
          loss_type: string | null
          message: string | null
          property_zip: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          access_token?: string
          contacted_at?: string | null
          contractor_profile_id: string
          contractor_user_id: string
          created_at?: string
          dtp_claim_number?: string | null
          dtp_insurance_carrier?: string | null
          dtp_policy_number?: string | null
          dtp_property_address?: string | null
          dtp_signature_ip?: string | null
          dtp_signature_name?: string | null
          dtp_signature_user_agent?: string | null
          dtp_signed_at?: string | null
          homeowner_email: string
          homeowner_name: string
          homeowner_phone?: string | null
          id?: string
          ip_hash?: string | null
          loss_type?: string | null
          message?: string | null
          property_zip?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          access_token?: string
          contacted_at?: string | null
          contractor_profile_id?: string
          contractor_user_id?: string
          created_at?: string
          dtp_claim_number?: string | null
          dtp_insurance_carrier?: string | null
          dtp_policy_number?: string | null
          dtp_property_address?: string | null
          dtp_signature_ip?: string | null
          dtp_signature_name?: string | null
          dtp_signature_user_agent?: string | null
          dtp_signed_at?: string | null
          homeowner_email?: string
          homeowner_name?: string
          homeowner_phone?: string | null
          id?: string
          ip_hash?: string | null
          loss_type?: string | null
          message?: string | null
          property_zip?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_intro_requests_contractor_profile_id_fkey"
            columns: ["contractor_profile_id"]
            isOneToOne: false
            referencedRelation: "contractor_directory_view"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_intro_requests_contractor_profile_id_fkey"
            columns: ["contractor_profile_id"]
            isOneToOne: false
            referencedRelation: "contractor_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      homeowner_ledger_check_uploads: {
        Row: {
          amount_estimate: number | null
          assigned_to_user_id: string | null
          attached_check_id: string | null
          back_path: string | null
          claim_id: string | null
          created_at: string
          front_path: string
          homeowner_note: string | null
          id: string
          partner_code: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          tenant_id: string
          token_id: string | null
          updated_at: string
        }
        Insert: {
          amount_estimate?: number | null
          assigned_to_user_id?: string | null
          attached_check_id?: string | null
          back_path?: string | null
          claim_id?: string | null
          created_at?: string
          front_path: string
          homeowner_note?: string | null
          id?: string
          partner_code?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id: string
          token_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_estimate?: number | null
          assigned_to_user_id?: string | null
          attached_check_id?: string | null
          back_path?: string | null
          claim_id?: string | null
          created_at?: string
          front_path?: string
          homeowner_note?: string | null
          id?: string
          partner_code?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id?: string
          token_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_ledger_check_uploads_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_ledger_check_uploads_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_ledger_check_uploads_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeowner_ledger_check_uploads_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "homeowner_ledger_tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      homeowner_ledger_events: {
        Row: {
          actor_label: string | null
          amount: number | null
          check_id: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          event_type: string
          id: string
          occurred_at: string
          payload_json: Json
          tenant_id: string
        }
        Insert: {
          actor_label?: string | null
          amount?: number | null
          check_id?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          event_type: string
          id?: string
          occurred_at?: string
          payload_json?: Json
          tenant_id: string
        }
        Update: {
          actor_label?: string | null
          amount?: number | null
          check_id?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          event_type?: string
          id?: string
          occurred_at?: string
          payload_json?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_ledger_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_ledger_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_ledger_events_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      homeowner_ledger_tokens: {
        Row: {
          claim_id: string | null
          created_at: string
          created_by: string | null
          expires_at: string | null
          homeowner_email: string | null
          homeowner_name: string | null
          homeowner_phone: string | null
          id: string
          last_viewed_at: string | null
          partner_code: string | null
          revoked_at: string | null
          sent_by_user_id: string | null
          tenant_id: string
          token: string
          updated_at: string
          view_count: number
        }
        Insert: {
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          homeowner_email?: string | null
          homeowner_name?: string | null
          homeowner_phone?: string | null
          id?: string
          last_viewed_at?: string | null
          partner_code?: string | null
          revoked_at?: string | null
          sent_by_user_id?: string | null
          tenant_id: string
          token?: string
          updated_at?: string
          view_count?: number
        }
        Update: {
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          homeowner_email?: string | null
          homeowner_name?: string | null
          homeowner_phone?: string | null
          id?: string
          last_viewed_at?: string | null
          partner_code?: string | null
          revoked_at?: string | null
          sent_by_user_id?: string | null
          tenant_id?: string
          token?: string
          updated_at?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "homeowner_ledger_tokens_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_ledger_tokens_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "homeowner_ledger_tokens_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      increase_settings: {
        Row: {
          id: string
          setting_key: string
          setting_value: Json
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          id?: string
          setting_key: string
          setting_value: Json
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          id?: string
          setting_key?: string
          setting_value?: Json
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: []
      }
      industry_notes_cache: {
        Row: {
          cache_key: string
          content: string
          created_at: string
          denial_theme: string | null
          expires_at: string
          id: string
          material: string | null
          peril: string | null
          source_type: string
          source_url: string | null
          state_code: string | null
          updated_at: string
        }
        Insert: {
          cache_key: string
          content: string
          created_at?: string
          denial_theme?: string | null
          expires_at?: string
          id?: string
          material?: string | null
          peril?: string | null
          source_type?: string
          source_url?: string | null
          state_code?: string | null
          updated_at?: string
        }
        Update: {
          cache_key?: string
          content?: string
          created_at?: string
          denial_theme?: string | null
          expires_at?: string
          id?: string
          material?: string | null
          peril?: string | null
          source_type?: string
          source_url?: string | null
          state_code?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      inspections: {
        Row: {
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          inspection_date: string
          inspection_time: string | null
          inspection_type: string | null
          inspector_name: string | null
          notes: string | null
          status: string
          updated_at: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          inspection_date: string
          inspection_time?: string | null
          inspection_type?: string | null
          inspector_name?: string | null
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          inspection_date?: string
          inspection_time?: string | null
          inspection_type?: string | null
          inspector_name?: string | null
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inspections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "inspections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "inspections_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      insurance_companies: {
        Row: {
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          phone: string | null
          phone_extension: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          phone?: string | null
          phone_extension?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          phone?: string | null
          phone_extension?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      inventory_scan_runs: {
        Row: {
          claim_id: string
          confirmed_count: number
          created_at: string
          created_by: string | null
          detected_count: number
          error_message: string | null
          id: string
          photo_ids: string[]
          results: Json | null
          status: string
        }
        Insert: {
          claim_id: string
          confirmed_count?: number
          created_at?: string
          created_by?: string | null
          detected_count?: number
          error_message?: string | null
          id?: string
          photo_ids?: string[]
          results?: Json | null
          status?: string
        }
        Update: {
          claim_id?: string
          confirmed_count?: number
          created_at?: string
          created_by?: string | null
          detected_count?: number
          error_message?: string | null
          id?: string
          photo_ids?: string[]
          results?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_scan_runs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "inventory_scan_runs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "inventory_scan_runs_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      jobnimbus_sync_queue: {
        Row: {
          claim_id: string | null
          contractor_id: string | null
          created_at: string | null
          error_message: string | null
          id: string
          notification_details: Json | null
          notification_status: string | null
          payload: Json | null
          processed_at: string | null
          status: string | null
          sync_type: string
        }
        Insert: {
          claim_id?: string | null
          contractor_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          notification_details?: Json | null
          notification_status?: string | null
          payload?: Json | null
          processed_at?: string | null
          status?: string | null
          sync_type: string
        }
        Update: {
          claim_id?: string | null
          contractor_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          notification_details?: Json | null
          notification_status?: string | null
          payload?: Json | null
          processed_at?: string | null
          status?: string | null
          sync_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobnimbus_sync_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "jobnimbus_sync_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "jobnimbus_sync_queue_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      learned_rule_candidates: {
        Row: {
          activation_status: string
          carrier: string | null
          confidence_score: number
          created_at: string
          created_from_claim_ids: string[]
          dispute_type: string | null
          evidence_request: string | null
          id: string
          loss_count: number
          material: string | null
          normalized_pattern: string
          notes: string | null
          rebuttal_strategy: string | null
          rule_type: string
          source_document_type: string | null
          source_phrase: string | null
          state: string | null
          supporting_claim_count: number
          trade: string | null
          trigger_pattern: string
          updated_at: string
          weakness_category: string | null
          win_count: number
        }
        Insert: {
          activation_status?: string
          carrier?: string | null
          confidence_score?: number
          created_at?: string
          created_from_claim_ids?: string[]
          dispute_type?: string | null
          evidence_request?: string | null
          id?: string
          loss_count?: number
          material?: string | null
          normalized_pattern: string
          notes?: string | null
          rebuttal_strategy?: string | null
          rule_type: string
          source_document_type?: string | null
          source_phrase?: string | null
          state?: string | null
          supporting_claim_count?: number
          trade?: string | null
          trigger_pattern: string
          updated_at?: string
          weakness_category?: string | null
          win_count?: number
        }
        Update: {
          activation_status?: string
          carrier?: string | null
          confidence_score?: number
          created_at?: string
          created_from_claim_ids?: string[]
          dispute_type?: string | null
          evidence_request?: string | null
          id?: string
          loss_count?: number
          material?: string | null
          normalized_pattern?: string
          notes?: string | null
          rebuttal_strategy?: string | null
          rule_type?: string
          source_document_type?: string | null
          source_phrase?: string | null
          state?: string | null
          supporting_claim_count?: number
          trade?: string | null
          trigger_pattern?: string
          updated_at?: string
          weakness_category?: string | null
          win_count?: number
        }
        Relationships: []
      }
      learned_rules_active: {
        Row: {
          candidate_id: string
          carrier: string | null
          confidence_score: number
          created_at: string
          dispute_type: string | null
          evidence_request: string | null
          id: string
          is_enabled: boolean
          material: string | null
          normalized_pattern: string
          rebuttal_strategy: string | null
          rule_type: string
          state: string | null
          trade: string | null
          trigger_pattern: string
          weakness_category: string | null
        }
        Insert: {
          candidate_id: string
          carrier?: string | null
          confidence_score?: number
          created_at?: string
          dispute_type?: string | null
          evidence_request?: string | null
          id?: string
          is_enabled?: boolean
          material?: string | null
          normalized_pattern: string
          rebuttal_strategy?: string | null
          rule_type: string
          state?: string | null
          trade?: string | null
          trigger_pattern: string
          weakness_category?: string | null
        }
        Update: {
          candidate_id?: string
          carrier?: string | null
          confidence_score?: number
          created_at?: string
          dispute_type?: string | null
          evidence_request?: string | null
          id?: string
          is_enabled?: boolean
          material?: string | null
          normalized_pattern?: string
          rebuttal_strategy?: string | null
          rule_type?: string
          state?: string | null
          trade?: string | null
          trigger_pattern?: string
          weakness_category?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "learned_rules_active_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "learned_rule_candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      line_item_requirement_rules: {
        Row: {
          code_requirement_text: string | null
          common_pushback: string | null
          created_at: string
          evidence_required: string[] | null
          id: string
          manufacturer_family: string | null
          manufacturer_requirement_text: string | null
          normalized_item: string
          policy_theory: string | null
          rebuttal_template: string | null
          trade: string
          updated_at: string
        }
        Insert: {
          code_requirement_text?: string | null
          common_pushback?: string | null
          created_at?: string
          evidence_required?: string[] | null
          id?: string
          manufacturer_family?: string | null
          manufacturer_requirement_text?: string | null
          normalized_item: string
          policy_theory?: string | null
          rebuttal_template?: string | null
          trade?: string
          updated_at?: string
        }
        Update: {
          code_requirement_text?: string | null
          common_pushback?: string | null
          created_at?: string
          evidence_required?: string[] | null
          id?: string
          manufacturer_family?: string | null
          manufacturer_requirement_text?: string | null
          normalized_item?: string
          policy_theory?: string | null
          rebuttal_template?: string | null
          trade?: string
          updated_at?: string
        }
        Relationships: []
      }
      linked_claims: {
        Row: {
          claim_id: string
          created_by: string | null
          external_claim_id: string | null
          external_instance_url: string
          id: string
          instance_name: string
          last_synced_at: string | null
          linked_at: string | null
          sync_status: string | null
        }
        Insert: {
          claim_id: string
          created_by?: string | null
          external_claim_id?: string | null
          external_instance_url: string
          id?: string
          instance_name: string
          last_synced_at?: string | null
          linked_at?: string | null
          sync_status?: string | null
        }
        Update: {
          claim_id?: string
          created_by?: string | null
          external_claim_id?: string | null
          external_instance_url?: string
          id?: string
          instance_name?: string
          last_synced_at?: string | null
          linked_at?: string | null
          sync_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "linked_claims_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "linked_claims_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "linked_claims_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      linked_workspaces: {
        Row: {
          created_at: string | null
          created_by: string | null
          external_instance_url: string
          id: string
          instance_name: string
          last_synced_at: string | null
          sync_secret: string
          sync_status: string | null
          target_sales_rep_id: string | null
          target_sales_rep_name: string | null
          target_workspace_id: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          external_instance_url: string
          id?: string
          instance_name: string
          last_synced_at?: string | null
          sync_secret: string
          sync_status?: string | null
          target_sales_rep_id?: string | null
          target_sales_rep_name?: string | null
          target_workspace_id?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          external_instance_url?: string
          id?: string
          instance_name?: string
          last_synced_at?: string | null
          sync_secret?: string
          sync_status?: string | null
          target_sales_rep_id?: string | null
          target_sales_rep_name?: string | null
          target_workspace_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "linked_workspaces_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      loss_draft_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          amount: number | null
          created_at: string
          id: string
          loss_draft_id: string
          new_values: Json | null
          notes: string | null
          old_values: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          amount?: number | null
          created_at?: string
          id?: string
          loss_draft_id: string
          new_values?: Json | null
          notes?: string | null
          old_values?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          amount?: number | null
          created_at?: string
          id?: string
          loss_draft_id?: string
          new_values?: Json | null
          notes?: string | null
          old_values?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "loss_draft_audit_log_loss_draft_id_fkey"
            columns: ["loss_draft_id"]
            isOneToOne: false
            referencedRelation: "loss_draft_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loss_draft_audit_log_loss_draft_id_fkey"
            columns: ["loss_draft_id"]
            isOneToOne: false
            referencedRelation: "loss_draft_tracking"
            referencedColumns: ["id"]
          },
        ]
      }
      loss_draft_documents: {
        Row: {
          created_at: string
          document_label: string
          document_type: string
          file_id: string | null
          file_name: string | null
          file_path: string | null
          id: string
          is_required: boolean
          is_submitted: boolean
          loss_draft_id: string
          notes: string | null
          submitted_at: string | null
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          document_label: string
          document_type: string
          file_id?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          is_required?: boolean
          is_submitted?: boolean
          loss_draft_id: string
          notes?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          document_label?: string
          document_type?: string
          file_id?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          is_required?: boolean
          is_submitted?: boolean
          loss_draft_id?: string
          notes?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loss_draft_documents_loss_draft_id_fkey"
            columns: ["loss_draft_id"]
            isOneToOne: false
            referencedRelation: "loss_draft_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loss_draft_documents_loss_draft_id_fkey"
            columns: ["loss_draft_id"]
            isOneToOne: false
            referencedRelation: "loss_draft_tracking"
            referencedColumns: ["id"]
          },
        ]
      }
      loss_draft_releases: {
        Row: {
          amount_released: number | null
          amount_requested: number
          created_at: string
          created_by: string | null
          draw_number: number
          holdback_amount: number | null
          id: string
          loss_draft_id: string
          notes: string | null
          release_date: string | null
          released_at: string | null
          requested_at: string
          status: string
        }
        Insert: {
          amount_released?: number | null
          amount_requested?: number
          created_at?: string
          created_by?: string | null
          draw_number: number
          holdback_amount?: number | null
          id?: string
          loss_draft_id: string
          notes?: string | null
          release_date?: string | null
          released_at?: string | null
          requested_at?: string
          status?: string
        }
        Update: {
          amount_released?: number | null
          amount_requested?: number
          created_at?: string
          created_by?: string | null
          draw_number?: number
          holdback_amount?: number | null
          id?: string
          loss_draft_id?: string
          notes?: string | null
          release_date?: string | null
          released_at?: string | null
          requested_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "loss_draft_releases_loss_draft_id_fkey"
            columns: ["loss_draft_id"]
            isOneToOne: false
            referencedRelation: "loss_draft_dashboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loss_draft_releases_loss_draft_id_fkey"
            columns: ["loss_draft_id"]
            isOneToOne: false
            referencedRelation: "loss_draft_tracking"
            referencedColumns: ["id"]
          },
        ]
      }
      loss_draft_tracking: {
        Row: {
          check_intake_item_id: string | null
          check_received_back_date: string | null
          check_received_date: string | null
          check_sent_date: string | null
          claim_id: string | null
          created_at: string
          created_by: string | null
          draw_amount_released: number | null
          draw_amount_requested: number | null
          draw_stage: number
          escrow_status: string
          follow_up_count: number | null
          follow_up_date: string | null
          holdback_amount: number | null
          id: string
          last_contact_at: string | null
          lender_website_url: string | null
          loan_number: string | null
          loss_draft_contact: string | null
          loss_draft_email: string | null
          loss_draft_fax: string | null
          loss_draft_phone: string | null
          monitoring_type: string
          mortgage_company_id: string | null
          mortgage_servicer: string
          notes: string | null
          shipping_method_return: string | null
          shipping_method_sent: string | null
          total_escrowed: number | null
          tracking_number_return: string | null
          tracking_number_sent: string | null
          updated_at: string
        }
        Insert: {
          check_intake_item_id?: string | null
          check_received_back_date?: string | null
          check_received_date?: string | null
          check_sent_date?: string | null
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          draw_amount_released?: number | null
          draw_amount_requested?: number | null
          draw_stage?: number
          escrow_status?: string
          follow_up_count?: number | null
          follow_up_date?: string | null
          holdback_amount?: number | null
          id?: string
          last_contact_at?: string | null
          lender_website_url?: string | null
          loan_number?: string | null
          loss_draft_contact?: string | null
          loss_draft_email?: string | null
          loss_draft_fax?: string | null
          loss_draft_phone?: string | null
          monitoring_type?: string
          mortgage_company_id?: string | null
          mortgage_servicer: string
          notes?: string | null
          shipping_method_return?: string | null
          shipping_method_sent?: string | null
          total_escrowed?: number | null
          tracking_number_return?: string | null
          tracking_number_sent?: string | null
          updated_at?: string
        }
        Update: {
          check_intake_item_id?: string | null
          check_received_back_date?: string | null
          check_received_date?: string | null
          check_sent_date?: string | null
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          draw_amount_released?: number | null
          draw_amount_requested?: number | null
          draw_stage?: number
          escrow_status?: string
          follow_up_count?: number | null
          follow_up_date?: string | null
          holdback_amount?: number | null
          id?: string
          last_contact_at?: string | null
          lender_website_url?: string | null
          loan_number?: string | null
          loss_draft_contact?: string | null
          loss_draft_email?: string | null
          loss_draft_fax?: string | null
          loss_draft_phone?: string | null
          monitoring_type?: string
          mortgage_company_id?: string | null
          mortgage_servicer?: string
          notes?: string | null
          shipping_method_return?: string | null
          shipping_method_sent?: string | null
          total_escrowed?: number | null
          tracking_number_return?: string | null
          tracking_number_sent?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loss_draft_tracking_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_mortgage_company_id_fkey"
            columns: ["mortgage_company_id"]
            isOneToOne: false
            referencedRelation: "mortgage_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      loss_types: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      manufacturer_specs: {
        Row: {
          content: string
          created_at: string
          id: string
          keywords: string[] | null
          manufacturer: string
          product_category: string
          product_name: string | null
          source_url: string | null
          spec_type: string
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          keywords?: string[] | null
          manufacturer: string
          product_category: string
          product_name?: string | null
          source_url?: string | null
          spec_type: string
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          keywords?: string[] | null
          manufacturer?: string
          product_category?: string
          product_name?: string | null
          source_url?: string | null
          spec_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      micro_deposit_verifications: {
        Row: {
          actum_history_id_1: string | null
          actum_history_id_2: string | null
          actum_order_id_1: string | null
          actum_order_id_2: string | null
          amount_1_cents: number
          amount_2_cents: number
          attempts: number
          created_at: string
          expires_at: string
          id: string
          initiated_by: string
          max_attempts: number
          stakeholder_account_id: string
          status: string
          tenant_id: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          actum_history_id_1?: string | null
          actum_history_id_2?: string | null
          actum_order_id_1?: string | null
          actum_order_id_2?: string | null
          amount_1_cents: number
          amount_2_cents: number
          attempts?: number
          created_at?: string
          expires_at?: string
          id?: string
          initiated_by: string
          max_attempts?: number
          stakeholder_account_id: string
          status?: string
          tenant_id: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          actum_history_id_1?: string | null
          actum_history_id_2?: string | null
          actum_order_id_1?: string | null
          actum_order_id_2?: string | null
          amount_1_cents?: number
          amount_2_cents?: number
          attempts?: number
          created_at?: string
          expires_at?: string
          id?: string
          initiated_by?: string
          max_attempts?: number
          stakeholder_account_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "micro_deposit_verifications_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "micro_deposit_verifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mortgage_companies: {
        Row: {
          address_line_1: string | null
          address_line_2: string | null
          address_line_3: string | null
          address_line_4: string | null
          address_line_5: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          last_four_ssn: string | null
          loan_number: string | null
          mortgage_site: string | null
          name: string
          phone: string | null
          phone_extension: string | null
          portal_password: string | null
          portal_username: string | null
          updated_at: string
        }
        Insert: {
          address_line_1?: string | null
          address_line_2?: string | null
          address_line_3?: string | null
          address_line_4?: string | null
          address_line_5?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          last_four_ssn?: string | null
          loan_number?: string | null
          mortgage_site?: string | null
          name: string
          phone?: string | null
          phone_extension?: string | null
          portal_password?: string | null
          portal_username?: string | null
          updated_at?: string
        }
        Update: {
          address_line_1?: string | null
          address_line_2?: string | null
          address_line_3?: string | null
          address_line_4?: string | null
          address_line_5?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          last_four_ssn?: string | null
          loan_number?: string | null
          mortgage_site?: string | null
          name?: string
          phone?: string | null
          phone_extension?: string | null
          portal_password?: string | null
          portal_username?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      mortgage_releases: {
        Row: {
          amount: number
          check_id: string | null
          claim_id: string
          created_at: string
          created_by: string | null
          id: string
          mortgage_company_name: string | null
          notes: string | null
          reference_number: string | null
          release_date: string
          release_method: string | null
          updated_at: string
        }
        Insert: {
          amount?: number
          check_id?: string | null
          claim_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          mortgage_company_name?: string | null
          notes?: string | null
          reference_number?: string | null
          release_date: string
          release_method?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          check_id?: string | null
          claim_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          mortgage_company_name?: string | null
          notes?: string | null
          reference_number?: string | null
          release_date?: string
          release_method?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mortgage_releases_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "claim_checks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mortgage_releases_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "mortgage_releases_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "mortgage_releases_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_delivery_logs: {
        Row: {
          channel: string
          created_at: string
          delivery_status: string
          escalation_level: number
          id: string
          notification_type: string
          provider_response: Json | null
          task_id: string
          user_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          delivery_status: string
          escalation_level?: number
          id?: string
          notification_type: string
          provider_response?: Json | null
          task_id: string
          user_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          delivery_status?: string
          escalation_level?: number
          id?: string
          notification_type?: string
          provider_response?: Json | null
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_delivery_logs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string
          email_enabled: boolean
          id: string
          in_app_enabled: boolean
          sms_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          sms_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          sms_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          claim_id: string
          created_at: string
          id: string
          is_read: boolean
          update_id: string
          user_id: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          id?: string
          is_read?: boolean
          update_id: string
          user_id: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          id?: string
          is_read?: boolean
          update_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "notifications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "notifications_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_update_id_fkey"
            columns: ["update_id"]
            isOneToOne: false
            referencedRelation: "claim_updates"
            referencedColumns: ["id"]
          },
        ]
      }
      onesx_orders: {
        Row: {
          address: string | null
          callback_payload: Json | null
          claim_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          expedited_delivery: boolean
          id: string
          last_error: string | null
          last_status_at: string | null
          latitude: number | null
          longitude: number | null
          meta_data: Json
          notes: string | null
          number_of_facets: number | null
          onesx_order_id: string | null
          payment_message: string | null
          payment_status: string | null
          primary_pitch: string | null
          report_files: Json
          report_types: string[]
          request_payload: Json | null
          response_payload: Json | null
          secondary_pitch: string | null
          status: string
          total: number | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          callback_payload?: Json | null
          claim_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          expedited_delivery?: boolean
          id?: string
          last_error?: string | null
          last_status_at?: string | null
          latitude?: number | null
          longitude?: number | null
          meta_data?: Json
          notes?: string | null
          number_of_facets?: number | null
          onesx_order_id?: string | null
          payment_message?: string | null
          payment_status?: string | null
          primary_pitch?: string | null
          report_files?: Json
          report_types?: string[]
          request_payload?: Json | null
          response_payload?: Json | null
          secondary_pitch?: string | null
          status?: string
          total?: number | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          callback_payload?: Json | null
          claim_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          expedited_delivery?: boolean
          id?: string
          last_error?: string | null
          last_status_at?: string | null
          latitude?: number | null
          longitude?: number | null
          meta_data?: Json
          notes?: string | null
          number_of_facets?: number | null
          onesx_order_id?: string | null
          payment_message?: string | null
          payment_status?: string | null
          primary_pitch?: string | null
          report_files?: Json
          report_types?: string[]
          request_payload?: Json | null
          response_payload?: Json | null
          secondary_pitch?: string | null
          status?: string
          total?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "onesx_orders_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "onesx_orders_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "onesx_orders_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          id: string
          org_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      org_sales_commissions: {
        Row: {
          claim_id: string
          commission_amount: number | null
          commission_percentage: number | null
          created_at: string
          id: string
          notes: string | null
          org_id: string
          sales_rep_id: string | null
          updated_at: string
        }
        Insert: {
          claim_id: string
          commission_amount?: number | null
          commission_percentage?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          org_id: string
          sales_rep_id?: string | null
          updated_at?: string
        }
        Update: {
          claim_id?: string
          commission_amount?: number | null
          commission_percentage?: number | null
          created_at?: string
          id?: string
          notes?: string | null
          org_id?: string
          sales_rep_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_sales_commissions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "org_sales_commissions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "org_sales_commissions_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_sales_commissions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      orgs: {
        Row: {
          created_at: string
          domain: string | null
          id: string
          logo_url: string | null
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          id?: string
          logo_url?: string | null
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      outstanding_checks: {
        Row: {
          amount: number
          check_number: string | null
          created_at: string
          id: string
          payee: string
          updated_at: string
        }
        Insert: {
          amount?: number
          check_number?: string | null
          created_at?: string
          id?: string
          payee: string
          updated_at?: string
        }
        Update: {
          amount?: number
          check_number?: string | null
          created_at?: string
          id?: string
          payee?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_methods: {
        Row: {
          card_last_four: string | null
          created_at: string
          created_by: string
          id: string
          label: string
          method_type: string
          updated_at: string
        }
        Insert: {
          card_last_four?: string | null
          created_at?: string
          created_by: string
          id?: string
          label: string
          method_type?: string
          updated_at?: string
        }
        Update: {
          card_last_four?: string | null
          created_at?: string
          created_by?: string
          id?: string
          label?: string
          method_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      photo_line_item_links: {
        Row: {
          confidence_score: number | null
          created_at: string
          created_by: string | null
          extracted_data_id: string | null
          id: string
          line_item_description: string | null
          line_item_index: number | null
          match_type: string
          photo_id: string
          updated_at: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          created_by?: string | null
          extracted_data_id?: string | null
          id?: string
          line_item_description?: string | null
          line_item_index?: number | null
          match_type?: string
          photo_id: string
          updated_at?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          created_by?: string | null
          extracted_data_id?: string | null
          id?: string
          line_item_description?: string | null
          line_item_index?: number | null
          match_type?: string
          photo_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "photo_line_item_links_extracted_data_id_fkey"
            columns: ["extracted_data_id"]
            isOneToOne: false
            referencedRelation: "extracted_document_data"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photo_line_item_links_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "claim_photos"
            referencedColumns: ["id"]
          },
        ]
      }
      pii_reveal_logs: {
        Row: {
          created_at: string
          field_name: string
          id: string
          record_id: string
          record_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          field_name: string
          id?: string
          record_id: string
          record_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          field_name?: string
          id?: string
          record_id?: string
          record_type?: string
          user_id?: string
        }
        Relationships: []
      }
      prediction_accuracy_metrics: {
        Row: {
          actual_move: string | null
          carrier_name: string | null
          claim_id: string | null
          claim_type: string | null
          confidence_at_prediction: number | null
          created_at: string
          days_difference: number | null
          id: string
          match: boolean | null
          predicted_move: string
          prediction_id: string | null
          resolved_at: string | null
        }
        Insert: {
          actual_move?: string | null
          carrier_name?: string | null
          claim_id?: string | null
          claim_type?: string | null
          confidence_at_prediction?: number | null
          created_at?: string
          days_difference?: number | null
          id?: string
          match?: boolean | null
          predicted_move: string
          prediction_id?: string | null
          resolved_at?: string | null
        }
        Update: {
          actual_move?: string | null
          carrier_name?: string | null
          claim_id?: string | null
          claim_type?: string | null
          confidence_at_prediction?: number | null
          created_at?: string
          days_difference?: number | null
          id?: string
          match?: boolean | null
          predicted_move?: string
          prediction_id?: string | null
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_accuracy_metrics_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "prediction_accuracy_metrics_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "prediction_accuracy_metrics_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_accuracy_metrics_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "claim_predictive_analysis"
            referencedColumns: ["id"]
          },
        ]
      }
      privacy_notice_acknowledgments: {
        Row: {
          acknowledged_at: string
          claim_id: string | null
          consumer_email: string | null
          consumer_name: string | null
          created_at: string
          delivery_method: string
          id: string
          ip_address: unknown
          notice_version: string
          tenant_id: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          acknowledged_at?: string
          claim_id?: string | null
          consumer_email?: string | null
          consumer_name?: string | null
          created_at?: string
          delivery_method?: string
          id?: string
          ip_address?: unknown
          notice_version: string
          tenant_id: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          acknowledged_at?: string
          claim_id?: string | null
          consumer_email?: string | null
          consumer_name?: string | null
          created_at?: string
          delivery_method?: string
          id?: string
          ip_address?: unknown
          notice_version?: string
          tenant_id?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          approval_status: string
          created_at: string | null
          email: string
          email_signature: string | null
          external_instance_name: string | null
          external_instance_url: string | null
          full_name: string | null
          id: string
          jobnimbus_api_key: string | null
          jobnimbus_enabled: boolean | null
          jobnimbus_notification_mode: string | null
          jobnimbus_user_id: string | null
          license_number: string | null
          license_state: string | null
          logo_url: string | null
          phone: string | null
          stripe_account_id: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          approval_status?: string
          created_at?: string | null
          email: string
          email_signature?: string | null
          external_instance_name?: string | null
          external_instance_url?: string | null
          full_name?: string | null
          id: string
          jobnimbus_api_key?: string | null
          jobnimbus_enabled?: boolean | null
          jobnimbus_notification_mode?: string | null
          jobnimbus_user_id?: string | null
          license_number?: string | null
          license_state?: string | null
          logo_url?: string | null
          phone?: string | null
          stripe_account_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          approval_status?: string
          created_at?: string | null
          email?: string
          email_signature?: string | null
          external_instance_name?: string | null
          external_instance_url?: string | null
          full_name?: string | null
          id?: string
          jobnimbus_api_key?: string | null
          jobnimbus_enabled?: boolean | null
          jobnimbus_notification_mode?: string | null
          jobnimbus_user_id?: string | null
          license_number?: string | null
          license_state?: string | null
          logo_url?: string | null
          phone?: string | null
          stripe_account_id?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      qualifying_language_templates: {
        Row: {
          created_at: string
          id: string
          is_active: boolean | null
          state_specific: string | null
          template_name: string
          template_text: string
          template_type: string
          usage_context: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          state_specific?: string | null
          template_name: string
          template_text: string
          template_type: string
          usage_context?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          state_specific?: string | null
          template_name?: string
          template_text?: string
          template_type?: string
          usage_context?: string | null
        }
        Relationships: []
      }
      rebuttal_playbook_cards: {
        Row: {
          argument_type: string
          carrier_ready_template: string
          created_at: string
          display_name: string
          documentation_checklist: Json
          id: string
          last_used_at: string | null
          principle: string
          updated_at: string
          usage_count: number | null
          what_proves_damage: string
          why_different: string
        }
        Insert: {
          argument_type: string
          carrier_ready_template: string
          created_at?: string
          display_name: string
          documentation_checklist?: Json
          id?: string
          last_used_at?: string | null
          principle: string
          updated_at?: string
          usage_count?: number | null
          what_proves_damage: string
          why_different: string
        }
        Update: {
          argument_type?: string
          carrier_ready_template?: string
          created_at?: string
          display_name?: string
          documentation_checklist?: Json
          id?: string
          last_used_at?: string | null
          principle?: string
          updated_at?: string
          usage_count?: number | null
          what_proves_damage?: string
          why_different?: string
        }
        Relationships: []
      }
      recipient_tax_profiles: {
        Row: {
          account_number: string | null
          address_city: string | null
          address_state: string | null
          address_street: string | null
          address_zip: string | null
          created_at: string
          id: string
          notes: string | null
          recipient_key: string
          recipient_name: string | null
          tenant_id: string
          tin: string | null
          updated_at: string
        }
        Insert: {
          account_number?: string | null
          address_city?: string | null
          address_state?: string | null
          address_street?: string | null
          address_zip?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          recipient_key: string
          recipient_name?: string | null
          tenant_id: string
          tin?: string | null
          updated_at?: string
        }
        Update: {
          account_number?: string | null
          address_city?: string | null
          address_state?: string | null
          address_street?: string | null
          address_zip?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          recipient_key?: string
          recipient_name?: string | null
          tenant_id?: string
          tin?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipient_tax_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_alerts: {
        Row: {
          actioned_at: string | null
          alert_type: Database["public"]["Enums"]["referral_alert_type"]
          claim_id: string
          created_at: string
          email_sent: boolean
          id: string
          is_actioned: boolean
          is_dismissed: boolean
          message: string | null
          notification_method: string
          trigger_reason: string
          updated_at: string
        }
        Insert: {
          actioned_at?: string | null
          alert_type: Database["public"]["Enums"]["referral_alert_type"]
          claim_id: string
          created_at?: string
          email_sent?: boolean
          id?: string
          is_actioned?: boolean
          is_dismissed?: boolean
          message?: string | null
          notification_method?: string
          trigger_reason: string
          updated_at?: string
        }
        Update: {
          actioned_at?: string | null
          alert_type?: Database["public"]["Enums"]["referral_alert_type"]
          claim_id?: string
          created_at?: string
          email_sent?: boolean
          id?: string
          is_actioned?: boolean
          is_dismissed?: boolean
          message?: string | null
          notification_method?: string
          trigger_reason?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_alerts_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "referral_alerts_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "referral_alerts_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_events: {
        Row: {
          created_at: string
          discount_applied_cents: number
          id: string
          notes: string | null
          referral_code_used: string
          referred_tenant_id: string
          referred_user_id: string
          referrer_tenant_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          discount_applied_cents?: number
          id?: string
          notes?: string | null
          referral_code_used: string
          referred_tenant_id: string
          referred_user_id: string
          referrer_tenant_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          discount_applied_cents?: number
          id?: string
          notes?: string | null
          referral_code_used?: string
          referred_tenant_id?: string
          referred_user_id?: string
          referrer_tenant_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_events_referred_tenant_id_fkey"
            columns: ["referred_tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_events_referrer_tenant_id_fkey"
            columns: ["referrer_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_professionals: {
        Row: {
          company: string | null
          created_at: string
          created_by: string | null
          description: string | null
          discovery_source: string | null
          email: string | null
          id: string
          is_active: boolean
          is_auto_discovered: boolean
          is_premium: boolean
          logo_url: string | null
          name: string
          phone: string | null
          premium_expires_at: string | null
          professional_type: Database["public"]["Enums"]["professional_type"]
          rating: number | null
          reviews_count: number | null
          specialties: string[]
          states_served: string[]
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          discovery_source?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          is_auto_discovered?: boolean
          is_premium?: boolean
          logo_url?: string | null
          name: string
          phone?: string | null
          premium_expires_at?: string | null
          professional_type: Database["public"]["Enums"]["professional_type"]
          rating?: number | null
          reviews_count?: number | null
          specialties?: string[]
          states_served?: string[]
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          discovery_source?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          is_auto_discovered?: boolean
          is_premium?: boolean
          logo_url?: string | null
          name?: string
          phone?: string | null
          premium_expires_at?: string | null
          professional_type?: Database["public"]["Enums"]["professional_type"]
          rating?: number | null
          reviews_count?: number | null
          specialties?: string[]
          states_served?: string[]
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      referral_recommendations: {
        Row: {
          claim_id: string
          created_at: string
          id: string
          position: number
          professional_id: string
          recommendation_reason: string
          selected_at: string | null
          was_selected: boolean
        }
        Insert: {
          claim_id: string
          created_at?: string
          id?: string
          position?: number
          professional_id: string
          recommendation_reason: string
          selected_at?: string | null
          was_selected?: boolean
        }
        Update: {
          claim_id?: string
          created_at?: string
          id?: string
          position?: number
          professional_id?: string
          recommendation_reason?: string
          selected_at?: string | null
          was_selected?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "referral_recommendations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "referral_recommendations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "referral_recommendations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_recommendations_professional_id_fkey"
            columns: ["professional_id"]
            isOneToOne: false
            referencedRelation: "referral_professionals"
            referencedColumns: ["id"]
          },
        ]
      }
      referrers: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          phone: string | null
          stripe_account_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          phone?: string | null
          stripe_account_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          phone?: string | null
          stripe_account_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      reserve_config: {
        Row: {
          auto_replenish: boolean
          current_reserve_balance: number
          id: string
          primary_account_id: string | null
          replenish_threshold: number
          reserve_pct: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          auto_replenish?: boolean
          current_reserve_balance?: number
          id?: string
          primary_account_id?: string | null
          replenish_threshold?: number
          reserve_pct?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          auto_replenish?: boolean
          current_reserve_balance?: number
          id?: string
          primary_account_id?: string | null
          replenish_threshold?: number
          reserve_pct?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reserve_config_primary_account_id_fkey"
            columns: ["primary_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reserve_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      role_version_tracker: {
        Row: {
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      scenario_accuracy_metrics: {
        Row: {
          action_executed_at: string | null
          actual_litigation_delta: number | null
          actual_pressure_delta: number | null
          actual_wsi_delta: number | null
          claim_id: string
          created_at: string
          id: string
          outcome_measured_at: string | null
          projected_litigation_delta: number | null
          projected_pressure_delta: number | null
          projected_wsi_delta: number | null
          scenario_action: string
          scenario_simulation_id: string | null
          variance_litigation: number | null
          variance_pressure: number | null
          variance_wsi: number | null
        }
        Insert: {
          action_executed_at?: string | null
          actual_litigation_delta?: number | null
          actual_pressure_delta?: number | null
          actual_wsi_delta?: number | null
          claim_id: string
          created_at?: string
          id?: string
          outcome_measured_at?: string | null
          projected_litigation_delta?: number | null
          projected_pressure_delta?: number | null
          projected_wsi_delta?: number | null
          scenario_action: string
          scenario_simulation_id?: string | null
          variance_litigation?: number | null
          variance_pressure?: number | null
          variance_wsi?: number | null
        }
        Update: {
          action_executed_at?: string | null
          actual_litigation_delta?: number | null
          actual_pressure_delta?: number | null
          actual_wsi_delta?: number | null
          claim_id?: string
          created_at?: string
          id?: string
          outcome_measured_at?: string | null
          projected_litigation_delta?: number | null
          projected_pressure_delta?: number | null
          projected_wsi_delta?: number | null
          scenario_action?: string
          scenario_simulation_id?: string | null
          variance_litigation?: number | null
          variance_pressure?: number | null
          variance_wsi?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scenario_accuracy_metrics_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "scenario_accuracy_metrics_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "scenario_accuracy_metrics_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scenario_accuracy_metrics_scenario_simulation_id_fkey"
            columns: ["scenario_simulation_id"]
            isOneToOne: false
            referencedRelation: "claim_scenario_simulations"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_check_messages: {
        Row: {
          body: string
          check_id: string
          created_at: string
          id: string
          sender_tenant_id: string
          sender_user_id: string
        }
        Insert: {
          body: string
          check_id: string
          created_at?: string
          id?: string
          sender_tenant_id: string
          sender_user_id: string
        }
        Update: {
          body?: string
          check_id?: string
          created_at?: string
          id?: string
          sender_tenant_id?: string
          sender_user_id?: string
        }
        Relationships: []
      }
      shared_checks: {
        Row: {
          access_level: string
          check_id: string
          created_at: string
          id: string
          revoked_at: string | null
          shared_by: string
          source_tenant_id: string
          target_tenant_id: string
        }
        Insert: {
          access_level?: string
          check_id: string
          created_at?: string
          id?: string
          revoked_at?: string | null
          shared_by: string
          source_tenant_id: string
          target_tenant_id: string
        }
        Update: {
          access_level?: string
          check_id?: string
          created_at?: string
          id?: string
          revoked_at?: string | null
          shared_by?: string
          source_tenant_id?: string
          target_tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_checks_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_checks_source_tenant_id_fkey"
            columns: ["source_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_checks_target_tenant_id_fkey"
            columns: ["target_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      signature_document_presets: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          document_type: string
          fields: Json
          id: string
          label: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          document_type: string
          fields?: Json
          id?: string
          label: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          document_type?: string
          fields?: Json
          id?: string
          label?: string
          updated_at?: string
        }
        Relationships: []
      }
      signature_field_templates: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string | null
          field_data: Json
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          field_data?: Json
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          field_data?: Json
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      signature_field_values: {
        Row: {
          checked: boolean | null
          field_id: string
          id: string
          signer_id: string
          submitted_at: string
          value: string | null
        }
        Insert: {
          checked?: boolean | null
          field_id: string
          id?: string
          signer_id: string
          submitted_at?: string
          value?: string | null
        }
        Update: {
          checked?: boolean | null
          field_id?: string
          id?: string
          signer_id?: string
          submitted_at?: string
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signature_field_values_field_id_fkey"
            columns: ["field_id"]
            isOneToOne: false
            referencedRelation: "signature_fields"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signature_field_values_signer_id_fkey"
            columns: ["signer_id"]
            isOneToOne: false
            referencedRelation: "signature_signers"
            referencedColumns: ["id"]
          },
        ]
      }
      signature_fields: {
        Row: {
          checkbox_label: string | null
          created_at: string
          field_type: string
          height: number
          id: string
          label: string | null
          page: number
          placeholder: string | null
          required: boolean
          signature_request_id: string
          signer_index: number
          width: number
          x: number
          y: number
        }
        Insert: {
          checkbox_label?: string | null
          created_at?: string
          field_type: string
          height?: number
          id?: string
          label?: string | null
          page?: number
          placeholder?: string | null
          required?: boolean
          signature_request_id: string
          signer_index?: number
          width?: number
          x?: number
          y?: number
        }
        Update: {
          checkbox_label?: string | null
          created_at?: string
          field_type?: string
          height?: number
          id?: string
          label?: string | null
          page?: number
          placeholder?: string | null
          required?: boolean
          signature_request_id?: string
          signer_index?: number
          width?: number
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "signature_fields_signature_request_id_fkey"
            columns: ["signature_request_id"]
            isOneToOne: false
            referencedRelation: "signature_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      signature_requests: {
        Row: {
          check_intake_item_id: string | null
          claim_id: string | null
          completed_at: string | null
          completion_status: string | null
          created_at: string | null
          created_by: string | null
          delivery_mode: string | null
          document_name: string
          document_path: string
          document_type: string | null
          field_data: Json | null
          final_pdf_path: string | null
          id: string
          last_attempted_at: string | null
          last_error: string | null
          last_provider_response: string | null
          provider_message_id: string | null
          provider_status: string | null
          sent_at: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          check_intake_item_id?: string | null
          claim_id?: string | null
          completed_at?: string | null
          completion_status?: string | null
          created_at?: string | null
          created_by?: string | null
          delivery_mode?: string | null
          document_name: string
          document_path: string
          document_type?: string | null
          field_data?: Json | null
          final_pdf_path?: string | null
          id?: string
          last_attempted_at?: string | null
          last_error?: string | null
          last_provider_response?: string | null
          provider_message_id?: string | null
          provider_status?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          check_intake_item_id?: string | null
          claim_id?: string | null
          completed_at?: string | null
          completion_status?: string | null
          created_at?: string | null
          created_by?: string | null
          delivery_mode?: string | null
          document_name?: string
          document_path?: string
          document_type?: string | null
          field_data?: Json | null
          final_pdf_path?: string | null
          id?: string
          last_attempted_at?: string | null
          last_error?: string | null
          last_provider_response?: string | null
          provider_message_id?: string | null
          provider_status?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signature_requests_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signature_requests_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "signature_requests_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "signature_requests_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      signature_signers: {
        Row: {
          access_token: string
          created_at: string | null
          delivery_error: string | null
          delivery_status: string | null
          email_provider_message_id: string | null
          email_sent_at: string | null
          expires_at: string | null
          field_values: Json | null
          id: string
          ip_address: string | null
          signature_data: string | null
          signature_request_id: string
          signed_at: string | null
          signer_email: string
          signer_name: string
          signer_type: string
          signing_order: number
          status: string
          token_hash: string | null
          user_agent: string | null
          viewed_at: string | null
        }
        Insert: {
          access_token?: string
          created_at?: string | null
          delivery_error?: string | null
          delivery_status?: string | null
          email_provider_message_id?: string | null
          email_sent_at?: string | null
          expires_at?: string | null
          field_values?: Json | null
          id?: string
          ip_address?: string | null
          signature_data?: string | null
          signature_request_id: string
          signed_at?: string | null
          signer_email: string
          signer_name: string
          signer_type: string
          signing_order?: number
          status?: string
          token_hash?: string | null
          user_agent?: string | null
          viewed_at?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string | null
          delivery_error?: string | null
          delivery_status?: string | null
          email_provider_message_id?: string | null
          email_sent_at?: string | null
          expires_at?: string | null
          field_values?: Json | null
          id?: string
          ip_address?: string | null
          signature_data?: string | null
          signature_request_id?: string
          signed_at?: string | null
          signer_email?: string
          signer_name?: string
          signer_type?: string
          signing_order?: number
          status?: string
          token_hash?: string | null
          user_agent?: string | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signature_signers_signature_request_id_fkey"
            columns: ["signature_request_id"]
            isOneToOne: false
            referencedRelation: "signature_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_follow_up_recommendations: {
        Row: {
          ai_confidence: number | null
          claim_id: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          dismissed: boolean | null
          dismissed_reason: string | null
          id: string
          is_completed: boolean | null
          priority: string
          reason: string
          recommendation_type: string
          recommended_date: string
          suggested_template_id: string | null
          target_recipient: string | null
          updated_at: string
        }
        Insert: {
          ai_confidence?: number | null
          claim_id: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          dismissed?: boolean | null
          dismissed_reason?: string | null
          id?: string
          is_completed?: boolean | null
          priority?: string
          reason: string
          recommendation_type: string
          recommended_date: string
          suggested_template_id?: string | null
          target_recipient?: string | null
          updated_at?: string
        }
        Update: {
          ai_confidence?: number | null
          claim_id?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          dismissed?: boolean | null
          dismissed_reason?: string | null
          id?: string
          is_completed?: boolean | null
          priority?: string
          reason?: string
          recommendation_type?: string
          recommended_date?: string
          suggested_template_id?: string | null
          target_recipient?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "smart_follow_up_recommendations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "smart_follow_up_recommendations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "smart_follow_up_recommendations_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smart_follow_up_recommendations_suggested_template_id_fkey"
            columns: ["suggested_template_id"]
            isOneToOne: false
            referencedRelation: "email_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_conversation_state: {
        Row: {
          active_claim_id: string | null
          created_at: string
          expires_at: string
          id: string
          last_command: string | null
          last_response: string | null
          pending_action: Json | null
          phone_number: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_claim_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          last_command?: string | null
          last_response?: string | null
          pending_action?: Json | null
          phone_number: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_claim_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          last_command?: string | null
          last_response?: string | null
          pending_action?: Json | null
          phone_number?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_conversation_state_active_claim_id_fkey"
            columns: ["active_claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "sms_conversation_state_active_claim_id_fkey"
            columns: ["active_claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "sms_conversation_state_active_claim_id_fkey"
            columns: ["active_claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_messages: {
        Row: {
          claim_id: string
          created_at: string
          direction: string
          from_number: string
          id: string
          message_body: string
          status: string
          telnyx_message_id: string | null
          to_number: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          claim_id: string
          created_at?: string
          direction?: string
          from_number: string
          id?: string
          message_body: string
          status?: string
          telnyx_message_id?: string | null
          to_number: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          claim_id?: string
          created_at?: string
          direction?: string
          from_number?: string
          id?: string
          message_body?: string
          status?: string
          telnyx_message_id?: string | null
          to_number?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_messages_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "sms_messages_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "sms_messages_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          body: string
          category: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          body: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          body?: string
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      stakeholder_account_verification_log: {
        Row: {
          actor_user_id: string | null
          created_at: string
          details: Json | null
          event_type: string
          id: string
          ip_address: string | null
          stakeholder_account_id: string
          tenant_id: string
          user_agent: string | null
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json | null
          event_type: string
          id?: string
          ip_address?: string | null
          stakeholder_account_id: string
          tenant_id: string
          user_agent?: string | null
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json | null
          event_type?: string
          id?: string
          ip_address?: string | null
          stakeholder_account_id?: string
          tenant_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stakeholder_account_verification_lo_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stakeholder_account_verification_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stakeholder_accounts: {
        Row: {
          account_type: string
          acct_type: string
          authentecheck_bank_name: string | null
          authentecheck_completed_at: string | null
          authentecheck_consumer_code: string | null
          authentecheck_initiated_at: string | null
          authentecheck_order_id: string | null
          authentecheck_postback: Json | null
          authentecheck_session_url: string | null
          chk_aba: string
          chk_acct: string
          consumer_unique: string | null
          created_at: string
          created_by: string
          custname: string
          homeowner_email: string | null
          homeowner_link_token_id: string | null
          homeowner_name: string | null
          id: string
          is_active: boolean
          is_partner_payout: boolean
          is_primary: boolean
          nickname: string
          origin: string
          tenant_id: string
          updated_at: string
          verification_amount_1_cents: number | null
          verification_amount_2_cents: number | null
          verification_attempts: number
          verification_completed_at: string | null
          verification_failure_reason: string | null
          verification_initiated_at: string | null
          verification_recipient_email: string | null
          verification_status: string
          verification_token: string | null
          verification_token_expires_at: string | null
          verified_at: string | null
        }
        Insert: {
          account_type?: string
          acct_type?: string
          authentecheck_bank_name?: string | null
          authentecheck_completed_at?: string | null
          authentecheck_consumer_code?: string | null
          authentecheck_initiated_at?: string | null
          authentecheck_order_id?: string | null
          authentecheck_postback?: Json | null
          authentecheck_session_url?: string | null
          chk_aba: string
          chk_acct: string
          consumer_unique?: string | null
          created_at?: string
          created_by: string
          custname: string
          homeowner_email?: string | null
          homeowner_link_token_id?: string | null
          homeowner_name?: string | null
          id?: string
          is_active?: boolean
          is_partner_payout?: boolean
          is_primary?: boolean
          nickname: string
          origin?: string
          tenant_id: string
          updated_at?: string
          verification_amount_1_cents?: number | null
          verification_amount_2_cents?: number | null
          verification_attempts?: number
          verification_completed_at?: string | null
          verification_failure_reason?: string | null
          verification_initiated_at?: string | null
          verification_recipient_email?: string | null
          verification_status?: string
          verification_token?: string | null
          verification_token_expires_at?: string | null
          verified_at?: string | null
        }
        Update: {
          account_type?: string
          acct_type?: string
          authentecheck_bank_name?: string | null
          authentecheck_completed_at?: string | null
          authentecheck_consumer_code?: string | null
          authentecheck_initiated_at?: string | null
          authentecheck_order_id?: string | null
          authentecheck_postback?: Json | null
          authentecheck_session_url?: string | null
          chk_aba?: string
          chk_acct?: string
          consumer_unique?: string | null
          created_at?: string
          created_by?: string
          custname?: string
          homeowner_email?: string | null
          homeowner_link_token_id?: string | null
          homeowner_name?: string | null
          id?: string
          is_active?: boolean
          is_partner_payout?: boolean
          is_primary?: boolean
          nickname?: string
          origin?: string
          tenant_id?: string
          updated_at?: string
          verification_amount_1_cents?: number | null
          verification_amount_2_cents?: number | null
          verification_attempts?: number
          verification_completed_at?: string | null
          verification_failure_reason?: string | null
          verification_initiated_at?: string | null
          verification_recipient_email?: string | null
          verification_status?: string
          verification_token?: string | null
          verification_token_expires_at?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stakeholder_accounts_homeowner_link_fk"
            columns: ["homeowner_link_token_id"]
            isOneToOne: false
            referencedRelation: "homeowner_bank_link_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stakeholder_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stakeholder_limit_requests: {
        Row: {
          category: string
          created_at: string
          id: string
          reason: string | null
          requested_by: string
          requested_limit: number
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          reason?: string | null
          requested_by: string
          requested_limit: number
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          reason?: string | null
          requested_by?: string
          requested_limit?: number
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stakeholder_limit_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      state_insurance_regulations: {
        Row: {
          consequence_description: string | null
          created_at: string
          deadline_days: number | null
          description: string
          id: string
          regulation_citation: string
          regulation_title: string
          regulation_type: string
          state_code: string
          state_name: string
          updated_at: string
        }
        Insert: {
          consequence_description?: string | null
          created_at?: string
          deadline_days?: number | null
          description: string
          id?: string
          regulation_citation: string
          regulation_title: string
          regulation_type: string
          state_code: string
          state_name: string
          updated_at?: string
        }
        Update: {
          consequence_description?: string | null
          created_at?: string
          deadline_days?: number | null
          description?: string
          id?: string
          regulation_citation?: string
          regulation_title?: string
          regulation_type?: string
          state_code?: string
          state_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      status_urgency_notifications_log: {
        Row: {
          claim_id: string
          created_at: string
          first_breached_at: string
          id: string
          inspection_id: string | null
          is_resolved: boolean
          last_notified_at: string
          notification_kind: string
          resolved_at: string | null
          rule_id: string
          sms_recipient_count: number
          status_at_breach: string
          total_sent: number
          updated_at: string
          warning_id: string | null
        }
        Insert: {
          claim_id: string
          created_at?: string
          first_breached_at?: string
          id?: string
          inspection_id?: string | null
          is_resolved?: boolean
          last_notified_at?: string
          notification_kind?: string
          resolved_at?: string | null
          rule_id: string
          sms_recipient_count?: number
          status_at_breach: string
          total_sent?: number
          updated_at?: string
          warning_id?: string | null
        }
        Update: {
          claim_id?: string
          created_at?: string
          first_breached_at?: string
          id?: string
          inspection_id?: string | null
          is_resolved?: boolean
          last_notified_at?: string
          notification_kind?: string
          resolved_at?: string | null
          rule_id?: string
          sms_recipient_count?: number
          status_at_breach?: string
          total_sent?: number
          updated_at?: string
          warning_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "status_urgency_notifications_log_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "status_urgency_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      status_urgency_rules: {
        Row: {
          count_mode: string
          created_at: string
          display_label: string
          id: string
          is_enabled: boolean
          notes: string | null
          rule_key: string
          status_names: string[]
          threshold_days: number
          trigger_kind: string
          updated_at: string
        }
        Insert: {
          count_mode?: string
          created_at?: string
          display_label: string
          id?: string
          is_enabled?: boolean
          notes?: string | null
          rule_key: string
          status_names: string[]
          threshold_days: number
          trigger_kind?: string
          updated_at?: string
        }
        Update: {
          count_mode?: string
          created_at?: string
          display_label?: string
          id?: string
          is_enabled?: boolean
          notes?: string | null
          rule_key?: string
          status_names?: string[]
          threshold_days?: number
          trigger_kind?: string
          updated_at?: string
        }
        Relationships: []
      }
      storage_backup_log: {
        Row: {
          backup_bucket: string
          backup_path: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          source_bucket: string
          source_path: string
          status: string
        }
        Insert: {
          backup_bucket: string
          backup_path: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          source_bucket: string
          source_path: string
          status?: string
        }
        Update: {
          backup_bucket?: string
          backup_path?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          source_bucket?: string
          source_path?: string
          status?: string
        }
        Relationships: []
      }
      strategic_weight_versions: {
        Row: {
          carrier_risk_weight: number
          compliance_weight: number
          coverage_weight: number
          created_at: string
          created_by: string | null
          effective_date: string
          evidence_weight: number
          id: string
          leverage_weight: number
          notes: string | null
          version_name: string
        }
        Insert: {
          carrier_risk_weight?: number
          compliance_weight?: number
          coverage_weight?: number
          created_at?: string
          created_by?: string | null
          effective_date?: string
          evidence_weight?: number
          id?: string
          leverage_weight?: number
          notes?: string | null
          version_name: string
        }
        Update: {
          carrier_risk_weight?: number
          compliance_weight?: number
          coverage_weight?: number
          created_at?: string
          created_by?: string | null
          effective_date?: string
          evidence_weight?: number
          id?: string
          leverage_weight?: number
          notes?: string | null
          version_name?: string
        }
        Relationships: []
      }
      strategy_outcome_tracking: {
        Row: {
          claim_id: string
          created_at: string
          executed_at: string
          gap_at_execution: number | null
          gap_pct_at_execution: number | null
          gap_reduction_pct_30d: number | null
          id: string
          outcome_measured: boolean | null
          outcome_measured_at: string | null
          payment_30d_after: number | null
          resistance_at_execution: string | null
          resistance_change: string | null
          strategy_type: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          executed_at?: string
          gap_at_execution?: number | null
          gap_pct_at_execution?: number | null
          gap_reduction_pct_30d?: number | null
          id?: string
          outcome_measured?: boolean | null
          outcome_measured_at?: string | null
          payment_30d_after?: number | null
          resistance_at_execution?: string | null
          resistance_change?: string | null
          strategy_type: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          executed_at?: string
          gap_at_execution?: number | null
          gap_pct_at_execution?: number | null
          gap_reduction_pct_30d?: number | null
          id?: string
          outcome_measured?: boolean | null
          outcome_measured_at?: string | null
          payment_30d_after?: number | null
          resistance_at_execution?: string | null
          resistance_change?: string | null
          strategy_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_outcome_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "strategy_outcome_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "strategy_outcome_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "suppressed_emails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      task_activity_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata_json: Json | null
          task_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata_json?: Json | null
          task_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata_json?: Json | null
          task_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_activity_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_automations: {
        Row: {
          created_at: string | null
          description: string | null
          due_date_offset: number | null
          id: string
          is_active: boolean | null
          priority: string | null
          title: string
          trigger_check_field: string | null
          trigger_check_value: string | null
          trigger_status: string | null
          trigger_sub_status_id: string | null
          trigger_type: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          due_date_offset?: number | null
          id?: string
          is_active?: boolean | null
          priority?: string | null
          title: string
          trigger_check_field?: string | null
          trigger_check_value?: string | null
          trigger_status?: string | null
          trigger_sub_status_id?: string | null
          trigger_type: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          due_date_offset?: number | null
          id?: string
          is_active?: boolean | null
          priority?: string | null
          title?: string
          trigger_check_field?: string | null
          trigger_check_value?: string | null
          trigger_status?: string | null
          trigger_sub_status_id?: string | null
          trigger_type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_automations_trigger_sub_status_id_fkey"
            columns: ["trigger_sub_status_id"]
            isOneToOne: false
            referencedRelation: "claim_sub_statuses"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          active_rank: number | null
          age_score: number
          assigned_to: string | null
          blocked_reason: string | null
          claim_id: string | null
          completed_at: string | null
          countdown_enabled: boolean
          created_at: string
          created_by: string | null
          deadline_source: string | null
          description: string | null
          done_definition: string | null
          due_at: string | null
          due_date: string | null
          email_enabled: boolean
          escalation_enabled: boolean
          escalation_level: number
          follow_up_current_count: number | null
          follow_up_enabled: boolean | null
          follow_up_interval_days: number | null
          follow_up_last_sent_at: string | null
          follow_up_max_count: number | null
          follow_up_next_at: string | null
          follow_up_stop_reason: string | null
          follow_up_stopped_at: string | null
          gravity_score: number
          id: string
          immediate_enabled: boolean
          impact_score: number
          last_acknowledged_at: string | null
          last_notified_at: string | null
          last_touched_at: string | null
          linked_entity_id: string | null
          linked_entity_type: string | null
          max_snooze_count: number
          next_notification_at: string | null
          notification_channels: string[]
          notification_strategy: string
          paused_at: string | null
          priority: string | null
          priority_level: string
          push_enabled: boolean
          requires_acknowledgement: boolean
          sms_enabled: boolean
          snooze_allowed: boolean
          snooze_count: number
          snoozed_until: string | null
          started_at: string | null
          status: string
          title: string
          updated_at: string
          urgency_score: number
          urgent_reason: string | null
        }
        Insert: {
          active_rank?: number | null
          age_score?: number
          assigned_to?: string | null
          blocked_reason?: string | null
          claim_id?: string | null
          completed_at?: string | null
          countdown_enabled?: boolean
          created_at?: string
          created_by?: string | null
          deadline_source?: string | null
          description?: string | null
          done_definition?: string | null
          due_at?: string | null
          due_date?: string | null
          email_enabled?: boolean
          escalation_enabled?: boolean
          escalation_level?: number
          follow_up_current_count?: number | null
          follow_up_enabled?: boolean | null
          follow_up_interval_days?: number | null
          follow_up_last_sent_at?: string | null
          follow_up_max_count?: number | null
          follow_up_next_at?: string | null
          follow_up_stop_reason?: string | null
          follow_up_stopped_at?: string | null
          gravity_score?: number
          id?: string
          immediate_enabled?: boolean
          impact_score?: number
          last_acknowledged_at?: string | null
          last_notified_at?: string | null
          last_touched_at?: string | null
          linked_entity_id?: string | null
          linked_entity_type?: string | null
          max_snooze_count?: number
          next_notification_at?: string | null
          notification_channels?: string[]
          notification_strategy?: string
          paused_at?: string | null
          priority?: string | null
          priority_level?: string
          push_enabled?: boolean
          requires_acknowledgement?: boolean
          sms_enabled?: boolean
          snooze_allowed?: boolean
          snooze_count?: number
          snoozed_until?: string | null
          started_at?: string | null
          status?: string
          title: string
          updated_at?: string
          urgency_score?: number
          urgent_reason?: string | null
        }
        Update: {
          active_rank?: number | null
          age_score?: number
          assigned_to?: string | null
          blocked_reason?: string | null
          claim_id?: string | null
          completed_at?: string | null
          countdown_enabled?: boolean
          created_at?: string
          created_by?: string | null
          deadline_source?: string | null
          description?: string | null
          done_definition?: string | null
          due_at?: string | null
          due_date?: string | null
          email_enabled?: boolean
          escalation_enabled?: boolean
          escalation_level?: number
          follow_up_current_count?: number | null
          follow_up_enabled?: boolean | null
          follow_up_interval_days?: number | null
          follow_up_last_sent_at?: string | null
          follow_up_max_count?: number | null
          follow_up_next_at?: string | null
          follow_up_stop_reason?: string | null
          follow_up_stopped_at?: string | null
          gravity_score?: number
          id?: string
          immediate_enabled?: boolean
          impact_score?: number
          last_acknowledged_at?: string | null
          last_notified_at?: string | null
          last_touched_at?: string | null
          linked_entity_id?: string | null
          linked_entity_type?: string | null
          max_snooze_count?: number
          next_notification_at?: string | null
          notification_channels?: string[]
          notification_strategy?: string
          paused_at?: string | null
          priority?: string | null
          priority_level?: string
          push_enabled?: boolean
          requires_acknowledgement?: boolean
          sms_enabled?: boolean
          snooze_allowed?: boolean
          snooze_count?: number
          snoozed_until?: string | null
          started_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          urgency_score?: number
          urgent_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_bank_accounts: {
        Row: {
          account_holder_name: string
          account_number_last4: string
          account_type: string
          bank_name: string
          created_at: string
          id: string
          is_primary: boolean
          routing_number: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_holder_name: string
          account_number_last4: string
          account_type?: string
          bank_name: string
          created_at?: string
          id?: string
          is_primary?: boolean
          routing_number: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_holder_name?: string
          account_number_last4?: string
          account_type?: string
          bank_name?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          routing_number?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_bank_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_billing_accounts: {
        Row: {
          account_holder_name: string
          account_number_encrypted: string
          account_number_last4: string
          account_type: string
          ach_authorized_at: string | null
          ach_authorized_by: string | null
          actum_consumer_unique: string | null
          auto_debit_enabled: boolean
          created_at: string
          entity_type: string
          id: string
          nickname: string | null
          routing_number: string
          stakeholder_account_id: string | null
          tenant_id: string
          updated_at: string
          verification_status: string
        }
        Insert: {
          account_holder_name: string
          account_number_encrypted: string
          account_number_last4: string
          account_type?: string
          ach_authorized_at?: string | null
          ach_authorized_by?: string | null
          actum_consumer_unique?: string | null
          auto_debit_enabled?: boolean
          created_at?: string
          entity_type?: string
          id?: string
          nickname?: string | null
          routing_number: string
          stakeholder_account_id?: string | null
          tenant_id: string
          updated_at?: string
          verification_status?: string
        }
        Update: {
          account_holder_name?: string
          account_number_encrypted?: string
          account_number_last4?: string
          account_type?: string
          ach_authorized_at?: string | null
          ach_authorized_by?: string | null
          actum_consumer_unique?: string | null
          auto_debit_enabled?: boolean
          created_at?: string
          entity_type?: string
          id?: string
          nickname?: string | null
          routing_number?: string
          stakeholder_account_id?: string | null
          tenant_id?: string
          updated_at?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_billing_accounts_stakeholder_account_id_fkey"
            columns: ["stakeholder_account_id"]
            isOneToOne: false
            referencedRelation: "stakeholder_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_billing_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_credit_balances: {
        Row: {
          balance: number
          created_at: string
          has_payment_method: boolean
          id: string
          lifetime_purchased: number
          lifetime_used: number
          maintenance_current_period_end: string | null
          maintenance_price_id: string | null
          maintenance_subscription_id: string | null
          maintenance_subscription_status: string | null
          payment_method_last4: string | null
          payment_method_type: string | null
          stripe_customer_id: string | null
          tenant_id: string
          updated_at: string
          usd_per_credit: number
        }
        Insert: {
          balance?: number
          created_at?: string
          has_payment_method?: boolean
          id?: string
          lifetime_purchased?: number
          lifetime_used?: number
          maintenance_current_period_end?: string | null
          maintenance_price_id?: string | null
          maintenance_subscription_id?: string | null
          maintenance_subscription_status?: string | null
          payment_method_last4?: string | null
          payment_method_type?: string | null
          stripe_customer_id?: string | null
          tenant_id: string
          updated_at?: string
          usd_per_credit?: number
        }
        Update: {
          balance?: number
          created_at?: string
          has_payment_method?: boolean
          id?: string
          lifetime_purchased?: number
          lifetime_used?: number
          maintenance_current_period_end?: string | null
          maintenance_price_id?: string | null
          maintenance_subscription_id?: string | null
          maintenance_subscription_status?: string | null
          payment_method_last4?: string | null
          payment_method_type?: string | null
          stripe_customer_id?: string | null
          tenant_id?: string
          updated_at?: string
          usd_per_credit?: number
        }
        Relationships: [
          {
            foreignKeyName: "tenant_credit_balances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_credit_transactions: {
        Row: {
          amount: number
          balance_after: number
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          reference_id: string | null
          reference_type: string | null
          tenant_id: string
          transaction_type: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          reference_id?: string | null
          reference_type?: string | null
          tenant_id: string
          transaction_type: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          reference_id?: string | null
          reference_type?: string | null
          tenant_id?: string
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_credit_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_documents: {
        Row: {
          created_at: string
          doc_type: string
          expires_at: string | null
          file_name: string
          file_path: string
          file_size: number | null
          id: string
          mime_type: string | null
          notes: string | null
          tenant_id: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          doc_type: string
          expires_at?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          tenant_id: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          doc_type?: string
          expires_at?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          tenant_id?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_email_settings: {
        Row: {
          created_at: string
          dns_records: Json | null
          domain_status: string
          from_address: string | null
          from_name: string | null
          id: string
          last_verification_error: string | null
          provider: string
          reply_to: string | null
          resend_domain_id: string | null
          sending_domain: string | null
          sending_mode: string
          tenant_id: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          dns_records?: Json | null
          domain_status?: string
          from_address?: string | null
          from_name?: string | null
          id?: string
          last_verification_error?: string | null
          provider?: string
          reply_to?: string | null
          resend_domain_id?: string | null
          sending_domain?: string | null
          sending_mode?: string
          tenant_id: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          dns_records?: Json | null
          domain_status?: string
          from_address?: string | null
          from_name?: string | null
          id?: string
          last_verification_error?: string | null
          provider?: string
          reply_to?: string | null
          resend_domain_id?: string | null
          sending_domain?: string | null
          sending_mode?: string
          tenant_id?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_email_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_maintenance_payments: {
        Row: {
          actum_consumer_unique: string | null
          actum_history_id: string | null
          actum_order_id: string | null
          amount_cents: number
          created_at: string
          failure_reason: string | null
          id: string
          idempotence_key: string | null
          method: string
          notes: string | null
          period_end: string
          period_start: string
          received_at: string
          recorded_by: string | null
          reference: string | null
          status: string
          submitted_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          actum_consumer_unique?: string | null
          actum_history_id?: string | null
          actum_order_id?: string | null
          amount_cents: number
          created_at?: string
          failure_reason?: string | null
          id?: string
          idempotence_key?: string | null
          method?: string
          notes?: string | null
          period_end: string
          period_start: string
          received_at?: string
          recorded_by?: string | null
          reference?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          actum_consumer_unique?: string | null
          actum_history_id?: string | null
          actum_order_id?: string | null
          amount_cents?: number
          created_at?: string
          failure_reason?: string | null
          id?: string
          idempotence_key?: string | null
          method?: string
          notes?: string | null
          period_end?: string
          period_start?: string
          received_at?: string
          recorded_by?: string | null
          reference?: string | null
          status?: string
          submitted_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_maintenance_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_openai_credentials: {
        Row: {
          created_at: string
          created_by: string | null
          encrypted_key: string
          key_last_4: string
          last_error: string | null
          last_validated_at: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          encrypted_key: string
          key_last_4: string
          last_error?: string | null
          last_validated_at?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          encrypted_key?: string
          key_last_4?: string
          last_error?: string | null
          last_validated_at?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_openai_credentials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_partner_code_aliases: {
        Row: {
          code: string
          created_at: string
          id: string
          tenant_id: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          tenant_id: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_partner_code_aliases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_partnerships: {
        Row: {
          accepted_at: string | null
          created_at: string
          created_by: string
          id: string
          invite_code: string
          invitee_tenant_id: string | null
          inviter_tenant_id: string
          revoked_at: string | null
          status: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          created_by: string
          id?: string
          invite_code: string
          invitee_tenant_id?: string | null
          inviter_tenant_id: string
          revoked_at?: string | null
          status?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          created_by?: string
          id?: string
          invite_code?: string
          invitee_tenant_id?: string | null
          inviter_tenant_id?: string
          revoked_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_partnerships_invitee_tenant_id_fkey"
            columns: ["invitee_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_partnerships_inviter_tenant_id_fkey"
            columns: ["inviter_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          ach_policy_acknowledged_at: string | null
          ach_policy_acknowledged_by: string | null
          ach_policy_version: string | null
          actum_environment: string
          actum_parent_id: string | null
          actum_password: string | null
          actum_sub_id: string | null
          actum_sub_id_ccd: string | null
          actum_sub_id_ppd: string | null
          actum_syspass: string | null
          actum_test_parent_id: string | null
          actum_test_password: string | null
          actum_test_sub_id_ccd: string | null
          actum_test_sub_id_ppd: string | null
          actum_test_syspass: string | null
          actum_test_username: string | null
          actum_username: string | null
          actum_webhook_secret: string | null
          beneficial_owner_dob: string | null
          beneficial_owner_id_url: string | null
          beneficial_owner_name: string | null
          business_address: string | null
          business_phone: string | null
          created_at: string
          custom_domain: string | null
          data_retention_years: number
          ein: string | null
          email_from_address: string | null
          email_from_name: string | null
          email_provider: string | null
          email_provider_config: Json | null
          email_reply_to: string | null
          id: string
          internal_notes: string | null
          is_founding_partner: boolean
          is_system_tenant: boolean | null
          kyc_completed_at: string | null
          kyc_completed_by: string | null
          kyc_notes: string | null
          kyc_status: string
          legal_business_name: string | null
          logo_url: string | null
          max_checks_per_month: number | null
          max_sales_reps: number
          max_subcontractors: number
          monthly_rate_cents: number
          name: string
          partner_code: string
          per_check_billing_enabled: boolean | null
          per_check_rate_cents: number | null
          plan_tier: Database["public"]["Enums"]["tenant_plan_tier"] | null
          primary_color: string | null
          privacy_notice_version: string
          qualified_individual_user_id: string | null
          referral_code: string | null
          referral_discount_cents: number
          referred_by_tenant_id: string | null
          secondary_color: string | null
          slug: string
          stripe_customer_id: string | null
          subscription_status: string | null
          updated_at: string
          wisp_acknowledged_at: string | null
          wisp_acknowledged_by: string | null
        }
        Insert: {
          ach_policy_acknowledged_at?: string | null
          ach_policy_acknowledged_by?: string | null
          ach_policy_version?: string | null
          actum_environment?: string
          actum_parent_id?: string | null
          actum_password?: string | null
          actum_sub_id?: string | null
          actum_sub_id_ccd?: string | null
          actum_sub_id_ppd?: string | null
          actum_syspass?: string | null
          actum_test_parent_id?: string | null
          actum_test_password?: string | null
          actum_test_sub_id_ccd?: string | null
          actum_test_sub_id_ppd?: string | null
          actum_test_syspass?: string | null
          actum_test_username?: string | null
          actum_username?: string | null
          actum_webhook_secret?: string | null
          beneficial_owner_dob?: string | null
          beneficial_owner_id_url?: string | null
          beneficial_owner_name?: string | null
          business_address?: string | null
          business_phone?: string | null
          created_at?: string
          custom_domain?: string | null
          data_retention_years?: number
          ein?: string | null
          email_from_address?: string | null
          email_from_name?: string | null
          email_provider?: string | null
          email_provider_config?: Json | null
          email_reply_to?: string | null
          id?: string
          internal_notes?: string | null
          is_founding_partner?: boolean
          is_system_tenant?: boolean | null
          kyc_completed_at?: string | null
          kyc_completed_by?: string | null
          kyc_notes?: string | null
          kyc_status?: string
          legal_business_name?: string | null
          logo_url?: string | null
          max_checks_per_month?: number | null
          max_sales_reps?: number
          max_subcontractors?: number
          monthly_rate_cents?: number
          name: string
          partner_code?: string
          per_check_billing_enabled?: boolean | null
          per_check_rate_cents?: number | null
          plan_tier?: Database["public"]["Enums"]["tenant_plan_tier"] | null
          primary_color?: string | null
          privacy_notice_version?: string
          qualified_individual_user_id?: string | null
          referral_code?: string | null
          referral_discount_cents?: number
          referred_by_tenant_id?: string | null
          secondary_color?: string | null
          slug: string
          stripe_customer_id?: string | null
          subscription_status?: string | null
          updated_at?: string
          wisp_acknowledged_at?: string | null
          wisp_acknowledged_by?: string | null
        }
        Update: {
          ach_policy_acknowledged_at?: string | null
          ach_policy_acknowledged_by?: string | null
          ach_policy_version?: string | null
          actum_environment?: string
          actum_parent_id?: string | null
          actum_password?: string | null
          actum_sub_id?: string | null
          actum_sub_id_ccd?: string | null
          actum_sub_id_ppd?: string | null
          actum_syspass?: string | null
          actum_test_parent_id?: string | null
          actum_test_password?: string | null
          actum_test_sub_id_ccd?: string | null
          actum_test_sub_id_ppd?: string | null
          actum_test_syspass?: string | null
          actum_test_username?: string | null
          actum_username?: string | null
          actum_webhook_secret?: string | null
          beneficial_owner_dob?: string | null
          beneficial_owner_id_url?: string | null
          beneficial_owner_name?: string | null
          business_address?: string | null
          business_phone?: string | null
          created_at?: string
          custom_domain?: string | null
          data_retention_years?: number
          ein?: string | null
          email_from_address?: string | null
          email_from_name?: string | null
          email_provider?: string | null
          email_provider_config?: Json | null
          email_reply_to?: string | null
          id?: string
          internal_notes?: string | null
          is_founding_partner?: boolean
          is_system_tenant?: boolean | null
          kyc_completed_at?: string | null
          kyc_completed_by?: string | null
          kyc_notes?: string | null
          kyc_status?: string
          legal_business_name?: string | null
          logo_url?: string | null
          max_checks_per_month?: number | null
          max_sales_reps?: number
          max_subcontractors?: number
          monthly_rate_cents?: number
          name?: string
          partner_code?: string
          per_check_billing_enabled?: boolean | null
          per_check_rate_cents?: number | null
          plan_tier?: Database["public"]["Enums"]["tenant_plan_tier"] | null
          primary_color?: string | null
          privacy_notice_version?: string
          qualified_individual_user_id?: string | null
          referral_code?: string | null
          referral_discount_cents?: number
          referred_by_tenant_id?: string | null
          secondary_color?: string | null
          slug?: string
          stripe_customer_id?: string | null
          subscription_status?: string | null
          updated_at?: string
          wisp_acknowledged_at?: string | null
          wisp_acknowledged_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenants_referred_by_tenant_id_fkey"
            columns: ["referred_by_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      urgency_sms_recipients: {
        Row: {
          created_at: string
          created_by: string | null
          display_name: string
          id: string
          is_active: boolean
          phone_number: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          display_name: string
          id?: string
          is_active?: boolean
          phone_number: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          display_name?: string
          id?: string
          is_active?: boolean
          phone_number?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_licenses: {
        Row: {
          ce_credits_completed: number | null
          ce_credits_required: number | null
          ce_renewal_date: string | null
          created_at: string
          expiration_date: string | null
          id: string
          is_active: boolean | null
          issue_date: string | null
          license_number: string
          license_state: string
          license_type: string
          notes: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ce_credits_completed?: number | null
          ce_credits_required?: number | null
          ce_renewal_date?: string | null
          created_at?: string
          expiration_date?: string | null
          id?: string
          is_active?: boolean | null
          issue_date?: string | null
          license_number: string
          license_state: string
          license_type?: string
          notes?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ce_credits_completed?: number | null
          ce_credits_required?: number | null
          ce_renewal_date?: string | null
          created_at?: string
          expiration_date?: string | null
          id?: string
          is_active?: boolean | null
          issue_date?: string | null
          license_number?: string
          license_state?: string
          license_type?: string
          notes?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_notes: {
        Row: {
          content: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_phone_links: {
        Row: {
          created_at: string
          id: string
          is_verified: boolean
          phone_number: string
          updated_at: string
          user_id: string
          verification_code: string | null
          verification_expires_at: string | null
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_verified?: boolean
          phone_number: string
          updated_at?: string
          user_id: string
          verification_code?: string | null
          verification_expires_at?: string | null
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_verified?: boolean
          phone_number?: string
          updated_at?: string
          user_id?: string
          verification_code?: string | null
          verification_expires_at?: string | null
          verified_at?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_sessions: {
        Row: {
          created_at: string
          device_info: string | null
          expires_at: string
          id: string
          ip_address: string | null
          is_active: boolean
          last_activity_at: string
          role_version: number
          session_token: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_info?: string | null
          expires_at?: string
          id?: string
          ip_address?: string | null
          is_active?: boolean
          last_activity_at?: string
          role_version?: number
          session_token: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_info?: string | null
          expires_at?: string
          id?: string
          ip_address?: string | null
          is_active?: boolean
          last_activity_at?: string
          role_version?: number
          session_token?: string
          user_id?: string
        }
        Relationships: []
      }
      workflow_automation_rules: {
        Row: {
          action_config: Json | null
          action_type: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          priority_order: number | null
          trigger_config: Json | null
          trigger_event: string
          updated_at: string
        }
        Insert: {
          action_config?: Json | null
          action_type: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          priority_order?: number | null
          trigger_config?: Json | null
          trigger_event: string
          updated_at?: string
        }
        Update: {
          action_config?: Json | null
          action_type?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          priority_order?: number | null
          trigger_config?: Json | null
          trigger_event?: string
          updated_at?: string
        }
        Relationships: []
      }
      workspace_invites: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          invited_by: string | null
          invited_domain: string | null
          invited_email: string | null
          invited_org_id: string | null
          role: string
          status: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          invited_domain?: string | null
          invited_email?: string | null
          invited_org_id?: string | null
          role?: string
          status?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          invited_domain?: string | null
          invited_email?: string | null
          invited_org_id?: string | null
          role?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invites_invited_org_id_fkey"
            columns: ["invited_org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          id: string
          invited_by: string | null
          joined_at: string | null
          org_id: string
          role: string
          status: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by?: string | null
          joined_at?: string | null
          org_id: string
          role?: string
          status?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string | null
          joined_at?: string | null
          org_id?: string
          role?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_messages: {
        Row: {
          body: string
          created_at: string
          id: string
          sender_id: string
          thread_id: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          sender_id: string
          thread_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          sender_id?: string
          thread_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "workspace_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_threads: {
        Row: {
          claim_id: string | null
          created_at: string
          created_by: string | null
          id: string
          subject: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          subject?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          claim_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          subject?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_threads_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "workspace_threads_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "workspace_threads_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_threads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          owner_org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          owner_org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          owner_org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_owner_org_id_fkey"
            columns: ["owner_org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      zip_geocache: {
        Row: {
          city: string | null
          created_at: string
          lat: number
          lng: number
          state: string | null
          zip: string
        }
        Insert: {
          city?: string | null
          created_at?: string
          lat: number
          lng: number
          state?: string | null
          zip: string
        }
        Update: {
          city?: string | null
          created_at?: string
          lat?: number
          lng?: number
          state?: string | null
          zip?: string
        }
        Relationships: []
      }
    }
    Views: {
      check_dashboard_counts: {
        Row: {
          approved_for_deposit: number | null
          branch_deposit: number | null
          manual_review: number | null
          reissue_requested: number | null
          total_checks: number | null
          total_deposited: number | null
          total_deposited_value: number | null
        }
        Relationships: []
      }
      claim_last_activity: {
        Row: {
          claim_id: string | null
          days_inactive: number | null
          last_activity_at: string | null
        }
        Insert: {
          claim_id?: string | null
          days_inactive?: never
          last_activity_at?: never
        }
        Update: {
          claim_id?: string | null
          days_inactive?: never
          last_activity_at?: never
        }
        Relationships: []
      }
      claim_money_snapshot: {
        Row: {
          acv_value: number | null
          claim_id: string | null
          deductible_total: number | null
          dep_recoverable: number | null
          dep_total: number | null
          gap: number | null
          has_settlement: boolean | null
          money_confidence: string | null
          paid_acv: number | null
          paid_rd: number | null
          paid_total: number | null
          rcv_claimed: number | null
          rd_available: number | null
          unclassified_payment_total: number | null
        }
        Relationships: []
      }
      contractor_directory_view: {
        Row: {
          avatar_url: string | null
          avg_rating: number | null
          bio: string | null
          coi_expires_at: string | null
          created_at: string | null
          directory_opt_in: boolean | null
          display_name: string | null
          home_base_lat: number | null
          home_base_lng: number | null
          id: string | null
          is_directory_listed: boolean | null
          jobs_count: number | null
          license_number: string | null
          review_count: number | null
          service_metros: string[] | null
          service_radius_miles: number | null
          service_states: string[] | null
          service_zip_prefixes: string[] | null
          tier: string | null
          trades: string[] | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      darwin_source_accuracy_stats: {
        Row: {
          avg_accuracy_score: number | null
          avg_geometry_quality: number | null
          avg_pct_delta_eave: number | null
          avg_pct_delta_footprint: number | null
          avg_pct_delta_hip: number | null
          avg_pct_delta_rake: number | null
          avg_pct_delta_ridge: number | null
          avg_pct_delta_roof_area: number | null
          avg_pct_delta_squares: number | null
          avg_pct_delta_valley: number | null
          geometry_source: string | null
          grade_a_count: number | null
          grade_b_count: number | null
          grade_c_count: number | null
          grade_d_count: number | null
          grade_f_count: number | null
          pitch_match_pct: number | null
          roof_form_match_pct: number | null
          validation_count: number | null
        }
        Relationships: []
      }
      deposit_aging_dashboard: {
        Row: {
          accounting_synced_at: string | null
          aging_bucket: string | null
          amount: number | null
          bank_confirmation_count: number | null
          bank_confirmed_at: string | null
          carrier_name: string | null
          check_number: string | null
          cleared_at: string | null
          closeout_complete: boolean | null
          created_at: string | null
          days_in_state: number | null
          deposit_slip_count: number | null
          id: string | null
          open_exception_count: number | null
          provider: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_at: string | null
          sla_confirm_breach: boolean | null
          sla_deposit_breach: boolean | null
          sla_sync_breach: boolean | null
          stamped_receipt_count: number | null
          status: Database["public"]["Enums"]["deposit_item_status"] | null
        }
        Insert: {
          accounting_synced_at?: string | null
          aging_bucket?: never
          amount?: number | null
          bank_confirmation_count?: never
          bank_confirmed_at?: string | null
          carrier_name?: string | null
          check_number?: string | null
          cleared_at?: string | null
          closeout_complete?: boolean | null
          created_at?: string | null
          days_in_state?: never
          deposit_slip_count?: never
          id?: string | null
          open_exception_count?: never
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_at?: string | null
          sla_confirm_breach?: never
          sla_deposit_breach?: never
          sla_sync_breach?: never
          stamped_receipt_count?: never
          status?: Database["public"]["Enums"]["deposit_item_status"] | null
        }
        Update: {
          accounting_synced_at?: string | null
          aging_bucket?: never
          amount?: number | null
          bank_confirmation_count?: never
          bank_confirmed_at?: string | null
          carrier_name?: string | null
          check_number?: string | null
          cleared_at?: string | null
          closeout_complete?: boolean | null
          created_at?: string | null
          days_in_state?: never
          deposit_slip_count?: never
          id?: string | null
          open_exception_count?: never
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_at?: string | null
          sla_confirm_breach?: never
          sla_deposit_breach?: never
          sla_sync_breach?: never
          stamped_receipt_count?: never
          status?: Database["public"]["Enums"]["deposit_item_status"] | null
        }
        Relationships: []
      }
      deposit_aging_summary: {
        Row: {
          awaiting_accounting_sync: number | null
          awaiting_bank_confirm: number | null
          awaiting_deposit: number | null
          awaiting_reconciliation: number | null
          complete: number | null
          items_with_open_exceptions: number | null
          missing_deposit_slip: number | null
          open_exceptions: number | null
          sla_confirm_breaches: number | null
          sla_deposit_breaches: number | null
          sla_sync_breaches: number | null
          unreconciled_amount: number | null
          unsynced_amount: number | null
        }
        Relationships: []
      }
      deposit_daily_log: {
        Row: {
          confirmed_amount: number | null
          deposit_date: string | null
          item_count: number | null
          nsf_count: number | null
          provider: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_amount: number | null
          total_amount: number | null
          total_variance: number | null
        }
        Relationships: []
      }
      deposit_exception_kpis: {
        Row: {
          avg_hours_to_resolve: number | null
          critical_open: number | null
          open_count: number | null
          reopen_count: number | null
          resolved_count: number | null
          total_exceptions: number | null
        }
        Relationships: []
      }
      deposit_manager_rollup: {
        Row: {
          active_owners: number | null
          closed_amount: number | null
          items_closed: number | null
          items_created: number | null
          nsf_count: number | null
          period_date: string | null
          total_amount: number | null
          variance_count: number | null
        }
        Relationships: []
      }
      deposit_ops_kpis: {
        Row: {
          avg_days_to_bank_confirm: number | null
          avg_days_to_closeout: number | null
          avg_days_to_deposit: number | null
          avg_days_to_reconcile: number | null
          avg_days_to_sync: number | null
          cleared_pending: number | null
          closed_out: number | null
          in_pipeline: number | null
          nsf_rate_pct: number | null
          reconciled_pending: number | null
          total_closed_amount: number | null
          total_items: number | null
          total_nsf_amount: number | null
          total_open_amount: number | null
          variance_rate_pct: number | null
        }
        Relationships: []
      }
      deposit_owner_performance: {
        Row: {
          avg_days_to_closeout: number | null
          avg_days_to_confirm: number | null
          avg_days_to_reconcile: number | null
          closed_amount: number | null
          nsf_count: number | null
          open_amount: number | null
          open_items: number | null
          owner_id: string | null
          sla_breaches: number | null
          total_assigned: number | null
          total_closed: number | null
          variance_count: number | null
        }
        Relationships: []
      }
      deposit_queue_scored: {
        Row: {
          accounting_synced_at: string | null
          amount: number | null
          bank_confirmed_at: string | null
          carrier_name: string | null
          check_number: string | null
          claim_id: string | null
          cleared_at: string | null
          closeout_complete: boolean | null
          created_at: string | null
          id: string | null
          next_action: string | null
          next_action_reason: string | null
          nsf_flag: boolean | null
          open_exception_count: number | null
          owner_id: string | null
          priority_score: number | null
          provider: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_at: string | null
          status: Database["public"]["Enums"]["deposit_item_status"] | null
          variance_amount: number | null
        }
        Insert: {
          accounting_synced_at?: string | null
          amount?: number | null
          bank_confirmed_at?: string | null
          carrier_name?: string | null
          check_number?: string | null
          claim_id?: string | null
          cleared_at?: string | null
          closeout_complete?: boolean | null
          created_at?: string | null
          id?: string | null
          next_action?: string | null
          next_action_reason?: string | null
          nsf_flag?: boolean | null
          open_exception_count?: never
          owner_id?: string | null
          priority_score?: never
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_at?: string | null
          status?: Database["public"]["Enums"]["deposit_item_status"] | null
          variance_amount?: number | null
        }
        Update: {
          accounting_synced_at?: string | null
          amount?: number | null
          bank_confirmed_at?: string | null
          carrier_name?: string | null
          check_number?: string | null
          claim_id?: string | null
          cleared_at?: string | null
          closeout_complete?: boolean | null
          created_at?: string | null
          id?: string | null
          next_action?: string | null
          next_action_reason?: string | null
          nsf_flag?: boolean | null
          open_exception_count?: never
          owner_id?: string | null
          priority_score?: never
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reconciled_at?: string | null
          status?: Database["public"]["Enums"]["deposit_item_status"] | null
          variance_amount?: number | null
        }
        Relationships: []
      }
      deposit_reconciliation_summary: {
        Row: {
          cleared_amount: number | null
          exceptions: number | null
          failed: number | null
          failed_amount: number | null
          in_flight: number | null
          in_flight_amount: number | null
          nsf_amount: number | null
          nsf_count: number | null
          reconciled: number | null
          reconciled_amount: number | null
          returned: number | null
          succeeded: number | null
          total_variance: number | null
          unconfirmed_amount: number | null
          unconfirmed_count: number | null
          unreconciled_amount: number | null
          unsynced_count: number | null
          variance_count: number | null
        }
        Relationships: []
      }
      deposit_reminder_queue: {
        Row: {
          amount: number | null
          carrier_name: string | null
          check_number: string | null
          created_at: string | null
          deposit_item_id: string | null
          open_exception_count: number | null
          owner_id: string | null
          provider: Database["public"]["Enums"]["deposit_provider"] | null
          reminder_type: string | null
          status: Database["public"]["Enums"]["deposit_item_status"] | null
        }
        Insert: {
          amount?: number | null
          carrier_name?: string | null
          check_number?: string | null
          created_at?: string | null
          deposit_item_id?: string | null
          open_exception_count?: never
          owner_id?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reminder_type?: never
          status?: Database["public"]["Enums"]["deposit_item_status"] | null
        }
        Update: {
          amount?: number | null
          carrier_name?: string | null
          check_number?: string | null
          created_at?: string | null
          deposit_item_id?: string | null
          open_exception_count?: never
          owner_id?: string | null
          provider?: Database["public"]["Enums"]["deposit_provider"] | null
          reminder_type?: never
          status?: Database["public"]["Enums"]["deposit_item_status"] | null
        }
        Relationships: []
      }
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      loss_draft_dashboard: {
        Row: {
          carrier_name: string | null
          check_amount: number | null
          check_intake_item_id: string | null
          check_number: string | null
          check_received_date: string | null
          check_sent_date: string | null
          check_status: string | null
          claim_id: string | null
          claim_number: string | null
          created_at: string | null
          days_in_escrow: number | null
          draw_amount_released: number | null
          draw_stage: number | null
          escrow_status: string | null
          follow_up_count: number | null
          follow_up_date: string | null
          holdback_amount: number | null
          id: string | null
          insurance_company: string | null
          is_stale: boolean | null
          last_contact_at: string | null
          missing_docs_count: number | null
          monitoring_type: string | null
          mortgage_servicer: string | null
          payee_line: string | null
          policyholder_name: string | null
          tenant_id: string | null
          total_escrowed: number | null
          unreleased_amount: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loss_draft_tracking_check_intake_item_id_fkey"
            columns: ["check_intake_item_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "loss_draft_tracking_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_carrier_analytics: {
        Row: {
          avg_days_open: number | null
          carrier: string | null
          denied_count: number | null
          total_claimed: number | null
          total_claims: number | null
          total_paid: number | null
        }
        Relationships: []
      }
      portfolio_intelligence: {
        Row: {
          avg_days_open: number | null
          denied_claims: number | null
          pct_at_risk: number | null
          total_active_claims: number | null
          total_outstanding_gap: number | null
          total_unreleased_depreciation: number | null
        }
        Relationships: []
      }
      recovery_by_carrier: {
        Row: {
          avg_days_to_recovery: number | null
          avg_recovery_pct: number | null
          avg_resistance: number | null
          avg_velocity: number | null
          carrier_name: string | null
          escalation_count: number | null
          total_claims: number | null
        }
        Relationships: []
      }
      recovery_by_escalation: {
        Row: {
          avg_days_to_recovery: number | null
          avg_recovery_pct: number | null
          avg_resistance: number | null
          avg_velocity: number | null
          escalation_used: boolean | null
          total_claims: number | null
        }
        Relationships: []
      }
      recovery_by_loss_type: {
        Row: {
          avg_days_to_recovery: number | null
          avg_recovery_pct: number | null
          avg_velocity: number | null
          escalation_count: number | null
          loss_type: string | null
          total_claims: number | null
        }
        Relationships: []
      }
      stale_endorsements: {
        Row: {
          amount: number | null
          carrier_name: string | null
          check_id: string | null
          check_number: string | null
          claim_id: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string | null
          endorsement_id: string | null
          hours_since_last_contact: number | null
          last_reminder_at: string | null
          payee_name: string | null
          payee_type: string | null
          reminder_count: number | null
          request_sent_at: string | null
          staleness_status: string | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "check_endorsements_check_id_fkey"
            columns: ["check_id"]
            isOneToOne: false
            referencedRelation: "check_intake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "check_intake_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_last_activity"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "check_intake_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claim_money_snapshot"
            referencedColumns: ["claim_id"]
          },
          {
            foreignKeyName: "check_intake_items_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      acquire_darwin_job: {
        Args: {
          p_claimed_by: string
          p_job_type: string
          p_ttl_seconds?: number
        }
        Returns: Json
      }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      admin_delete_check: {
        Args: { p_actor_id: string; p_check_id: string; p_reason: string }
        Returns: Json
      }
      admin_set_contractor_pro: {
        Args: { p_approve: boolean; p_contractor_id: string }
        Returns: Json
      }
      apply_referral_code: {
        Args: {
          p_new_tenant_id: string
          p_new_user_id: string
          p_referring_code: string
        }
        Returns: Json
      }
      assign_deposit_owner: {
        Args: {
          p_actor_id: string
          p_deposit_item_ids: string[]
          p_owner_id: string
        }
        Returns: Json
      }
      auto_generate_claim_microtasks: { Args: never; Returns: number }
      backfill_check_billing_events: { Args: never; Returns: Json }
      bulk_deposit_closeout: {
        Args: { p_actor_id: string; p_deposit_item_ids: string[] }
        Returns: Json
      }
      bulk_resolve_deposit_exceptions: {
        Args: {
          p_actor_id: string
          p_exception_ids: string[]
          p_resolution_notes: string
        }
        Returns: Json
      }
      bulk_sync_deposit_accounting: {
        Args: { p_actor_id: string; p_deposit_item_ids: string[] }
        Returns: Json
      }
      bump_claim_intelligence_version: {
        Args: { _claim_id: string; _reason: string }
        Returns: undefined
      }
      can_manage_roles: { Args: { _user_id: string }; Returns: boolean }
      classify_payee_type: { Args: { _name: string }; Returns: string }
      cleanup_expired_ai_response_cache: { Args: never; Returns: number }
      compute_claim_last_activity: {
        Args: { p_claim_id: string }
        Returns: string
      }
      contractor_accepts_leads: {
        Args: { _profile_id: string; _user_id: string }
        Returns: boolean
      }
      contractor_verification_status: {
        Args: { p_contractor_id: string }
        Returns: Json
      }
      create_claim_for_staff:
        | {
            Args: {
              p_claim_number: string
              p_client_id: string
              p_insurance_company_id: string
              p_insurance_email: string
              p_insurance_phone: string
              p_loss_date: string
              p_loss_description: string
              p_loss_type_id: string
              p_policy_number: string
              p_policyholder_address: string
              p_policyholder_email: string
              p_policyholder_name: string
              p_policyholder_phone: string
              p_referrer_id: string
            }
            Returns: {
              adjuster_email: string | null
              adjuster_name: string | null
              adjuster_phone: string | null
              ale_limit: number | null
              automation_mode: Database["public"]["Enums"]["automation_mode"]
              automation_resume_at: string | null
              claim_amount: number | null
              claim_email_id: string | null
              claim_number: string | null
              claim_tracking_number: string | null
              client_id: string | null
              construction_status: string | null
              contract_pdf_path: string | null
              created_at: string | null
              date_claim_filed: string | null
              deductible: number | null
              dwelling_limit: number | null
              esign_audit_url: string | null
              esign_completed_at: string | null
              esign_document_id: string | null
              esign_error_message: string | null
              esign_provider: string | null
              esign_sent_at: string | null
              esign_signing_link: string | null
              esign_status: string | null
              fedex_tracking_number: string | null
              fraud_flag: boolean | null
              fraud_flag_reason: string | null
              fraud_flagged_at: string | null
              fraud_flagged_by: string | null
              geocoded_at: string | null
              id: string
              insurance_company: string | null
              insurance_company_id: string | null
              insurance_email: string | null
              insurance_phone: string | null
              is_closed: boolean
              is_guided_mode: boolean
              jobnimbus_job_id: string | null
              last_activity_at: string | null
              latest_signature_request_id: string | null
              latitude: number | null
              loan_number: string | null
              longitude: number | null
              loss_date: string | null
              loss_description: string | null
              loss_type: string | null
              loss_type_id: string | null
              mortgage_company_id: string | null
              mortgage_portal_password: string | null
              mortgage_portal_site: string | null
              mortgage_portal_username: string | null
              org_id: string | null
              other_structures_limit: number | null
              partner_assigned_user_email: string | null
              partner_assigned_user_id: string | null
              partner_assigned_user_name: string | null
              partner_construction_status: string | null
              personal_property_limit: number | null
              policy_number: string | null
              policyholder_address: string | null
              policyholder_email: string | null
              policyholder_name: string | null
              policyholder_phone: string | null
              referrer_id: string | null
              retention_purge_after: string | null
              signature_cc_email: string | null
              signed_pdf_url: string | null
              ssn_last_four: string | null
              state_code: string | null
              status: string | null
              sub_status_id: string | null
              updated_at: string | null
              workspace_id: string | null
            }
            SetofOptions: {
              from: "*"
              to: "claims"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: {
              p_claim_number: string
              p_client_id: string
              p_insurance_company_id: string
              p_insurance_email: string
              p_insurance_phone: string
              p_loss_date: string
              p_loss_description: string
              p_loss_type_id: string
              p_mortgage_company_id?: string
              p_policy_number: string
              p_policyholder_address: string
              p_policyholder_email: string
              p_policyholder_name: string
              p_policyholder_phone: string
              p_referrer_id: string
            }
            Returns: {
              adjuster_email: string | null
              adjuster_name: string | null
              adjuster_phone: string | null
              ale_limit: number | null
              automation_mode: Database["public"]["Enums"]["automation_mode"]
              automation_resume_at: string | null
              claim_amount: number | null
              claim_email_id: string | null
              claim_number: string | null
              claim_tracking_number: string | null
              client_id: string | null
              construction_status: string | null
              contract_pdf_path: string | null
              created_at: string | null
              date_claim_filed: string | null
              deductible: number | null
              dwelling_limit: number | null
              esign_audit_url: string | null
              esign_completed_at: string | null
              esign_document_id: string | null
              esign_error_message: string | null
              esign_provider: string | null
              esign_sent_at: string | null
              esign_signing_link: string | null
              esign_status: string | null
              fedex_tracking_number: string | null
              fraud_flag: boolean | null
              fraud_flag_reason: string | null
              fraud_flagged_at: string | null
              fraud_flagged_by: string | null
              geocoded_at: string | null
              id: string
              insurance_company: string | null
              insurance_company_id: string | null
              insurance_email: string | null
              insurance_phone: string | null
              is_closed: boolean
              is_guided_mode: boolean
              jobnimbus_job_id: string | null
              last_activity_at: string | null
              latest_signature_request_id: string | null
              latitude: number | null
              loan_number: string | null
              longitude: number | null
              loss_date: string | null
              loss_description: string | null
              loss_type: string | null
              loss_type_id: string | null
              mortgage_company_id: string | null
              mortgage_portal_password: string | null
              mortgage_portal_site: string | null
              mortgage_portal_username: string | null
              org_id: string | null
              other_structures_limit: number | null
              partner_assigned_user_email: string | null
              partner_assigned_user_id: string | null
              partner_assigned_user_name: string | null
              partner_construction_status: string | null
              personal_property_limit: number | null
              policy_number: string | null
              policyholder_address: string | null
              policyholder_email: string | null
              policyholder_name: string | null
              policyholder_phone: string | null
              referrer_id: string | null
              retention_purge_after: string | null
              signature_cc_email: string | null
              signed_pdf_url: string | null
              ssn_last_four: string | null
              state_code: string | null
              status: string | null
              sub_status_id: string | null
              updated_at: string | null
              workspace_id: string | null
            }
            SetofOptions: {
              from: "*"
              to: "claims"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      create_endorsements_from_payees: {
        Args: { p_check_id: string }
        Returns: Json
      }
      decide_stakeholder_limit_request: {
        Args: {
          _approved_limit: number
          _decision: string
          _notes: string
          _request_id: string
        }
        Returns: undefined
      }
      decrypt_pii: {
        Args: { p_ciphertext: string; p_key_name?: string }
        Returns: string
      }
      decrypt_tenant_openai_key: { Args: { p_tenant: string }; Returns: string }
      deduct_tenant_credits: {
        Args: {
          p_amount: number
          p_description?: string
          p_reference_id?: string
          p_reference_type?: string
          p_tenant_id: string
        }
        Returns: Json
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      deposit_action: {
        Args: {
          p_action: string
          p_actor_id: string
          p_amount?: number
          p_batch_id?: string
          p_check_id?: string
          p_deposit_item_id?: string
          p_extra?: Json
          p_notes?: string
          p_provider?: string
        }
        Returns: Json
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enablelongtransactions: { Args: never; Returns: string }
      encrypt_pii: {
        Args: { p_key_name?: string; p_plaintext: string }
        Returns: string
      }
      encrypt_tenant_openai_key: { Args: { p_key: string }; Returns: string }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      find_nearest_building_footprint: {
        Args: { search_lat: number; search_lng: number; search_radius?: number }
        Returns: {
          area_sqft: number
          bbox: Json
          centroid_lat: number
          centroid_lng: number
          distance_meters: number
          geometry_json: string
          id: string
          source: string
          source_id: string
          state: string
          vertex_count: number
        }[]
      }
      generate_deposit_daily_digest: {
        Args: { p_actor_id?: string; p_digest_type?: string }
        Returns: Json
      }
      generate_next_deposit_action: {
        Args: { p_deposit_item_id: string }
        Returns: Json
      }
      generate_partner_code_value: { Args: never; Returns: string }
      generate_referral_code: {
        Args: { p_tenant_name: string }
        Returns: string
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      get_all_checks_safety_net: {
        Args: never
        Returns: {
          amount: number
          back_image_path: string
          carrier_name: string
          check_number: string
          claim_id: string
          created_at: string
          front_image_path: string
          has_loss_draft: boolean
          id: string
          payee_line: string
          status: string
          updated_at: string
        }[]
      }
      get_all_insurance_carriers: {
        Args: never
        Returns: {
          carrier_name: string
        }[]
      }
      get_check_claim_settlement: {
        Args: { p_check_id: string }
        Returns: Json
      }
      get_check_dashboard_counts: { Args: never; Returns: Json }
      get_check_dashboard_counts_for_tenant: {
        Args: { _tenant_id: string }
        Returns: Json
      }
      get_check_unread_counts: {
        Args: never
        Returns: {
          check_id: string
          last_message_at: string
          unread_count: number
        }[]
      }
      get_claim_money_snapshot: { Args: { p_claim_id: string }; Returns: Json }
      get_deposit_aging_summary: { Args: never; Returns: Json }
      get_deposit_exception_kpis: { Args: never; Returns: Json }
      get_deposit_ops_kpis: { Args: never; Returns: Json }
      get_deposit_reconciliation_summary: { Args: never; Returns: Json }
      get_deposit_setting: { Args: { p_key: string }; Returns: Json }
      get_expiring_licenses: {
        Args: { p_days_ahead?: number; p_user_id: string }
        Returns: {
          days_until_expiration: number
          expiration_date: string
          id: string
          license_number: string
          license_state: string
          license_type: string
        }[]
      }
      get_loss_draft_dashboard_counts: { Args: never; Returns: Json }
      get_loss_draft_dashboard_counts_for_tenant: {
        Args: { _tenant_id: string }
        Returns: Json
      }
      get_my_tenant_partner_codes: {
        Args: never
        Returns: {
          code: string
          tenant_id: string
        }[]
      }
      get_or_create_notification_preferences: {
        Args: { p_user_id: string }
        Returns: {
          created_at: string
          email_enabled: boolean
          id: string
          in_app_enabled: boolean
          sms_enabled: boolean
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "notification_preferences"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_partner_tenant_ids: {
        Args: { _tenant_id: string }
        Returns: string[]
      }
      get_portfolio_carrier_analytics: { Args: never; Returns: Json }
      get_portfolio_intelligence: { Args: never; Returns: Json }
      get_stuck_checks: {
        Args: never
        Returns: {
          amount: number
          carrier_name: string
          claim_id: string
          created_at: string
          hours_in_status: number
          id: string
          is_overdue: boolean
          payee_line: string
          sla_hours: number
          status: string
          updated_at: string
        }[]
      }
      get_tenant_check_usage: {
        Args: { _month_end?: string; _month_start?: string; _tenant_id: string }
        Returns: Json
      }
      get_tenant_users_with_profiles: {
        Args: { _tenant_id: string }
        Returns: {
          created_at: string
          email: string
          full_name: string
          id: string
          role: string
          user_id: string
        }[]
      }
      get_total_unread_check_messages: { Args: never; Returns: number }
      get_user_tenant_ids: { Args: { _user_id: string }; Returns: string[] }
      get_weekly_command_review: { Args: never; Returns: Json }
      gettransactionid: { Args: never; Returns: unknown }
      has_permission: {
        Args: { _permission: string; _user_id: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_workspace_access: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      heartbeat_darwin_job: {
        Args: { p_claimed_by: string; p_job_type: string }
        Returns: boolean
      }
      init_loss_draft_documents: {
        Args: { p_loss_draft_id: string }
        Returns: undefined
      }
      insert_building_footprints_batch: {
        Args: {
          p_areas_sqft: number[]
          p_bboxes: Json[]
          p_centroid_lats: number[]
          p_centroid_lngs: number[]
          p_source_ids: string[]
          p_sources: string[]
          p_states: string[]
          p_vertex_counts: number[]
          p_wkts: string[]
        }
        Returns: Json
      }
      invalidate_all_sessions: { Args: { p_user_id?: string }; Returns: number }
      invalidate_session: {
        Args: { p_session_token: string }
        Returns: boolean
      }
      is_approval_required: {
        Args: { p_action_type: string }
        Returns: boolean
      }
      is_checkalt_enabled: { Args: never; Returns: boolean }
      is_checkalt_enabled_for_tenant: {
        Args: { _tenant_id: string }
        Returns: boolean
      }
      is_master_owner: { Args: never; Returns: boolean }
      is_org_admin: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_read_only: { Args: { _user_id: string }; Returns: boolean }
      is_tenant_admin: {
        Args: { _tenant_id: string; _user_id: string }
        Returns: boolean
      }
      is_tenant_member: {
        Args: { _tenant_id: string; _user_id: string }
        Returns: boolean
      }
      list_checks_by_freedom_claim: {
        Args: { _freedom_claim_id: string; _partner_code: string }
        Returns: {
          amount: number
          back_image_path: string
          carrier_name: string
          check_number: string
          check_stage: Database["public"]["Enums"]["check_stage"]
          created_at: string
          deposit_recommendation: string
          detected_claim_number: string
          freedom_claim_id: string
          freedom_claim_number: string
          front_image_path: string
          id: string
          issue_date: string
          partner_status: string
          partner_status_label: string
          partner_status_updated_at: string
          payee_line: string
          status: string
          updated_at: string
        }[]
      }
      list_partner_shared_checks: {
        Args: {
          _include_shared?: boolean
          _limit?: number
          _partner_code: string
        }
        Returns: {
          amount: number
          back_image_path: string
          carrier: string
          check_number: string
          check_stage: Database["public"]["Enums"]["check_stage"]
          claim_number: string
          created_at: string
          freedom_claim_id: string
          front_image_path: string
          id: string
          insured_name: string
          is_shared: boolean
          partner_status: string
          partner_status_label: string
          status: string
        }[]
      }
      log_audit: {
        Args: {
          p_action: string
          p_metadata?: Json
          p_new_values?: Json
          p_old_values?: Json
          p_record_id?: string
          p_record_type: string
        }
        Returns: string
      }
      longtransactionsenabled: { Args: never; Returns: boolean }
      lookup_tenant_by_partner_code: {
        Args: { _code: string }
        Returns: {
          id: string
          name: string
        }[]
      }
      loss_draft_action:
        | {
            Args: {
              p_action: string
              p_actor_id: string
              p_amount?: number
              p_extra?: Json
              p_loss_draft_id: string
              p_notes?: string
            }
            Returns: undefined
          }
        | {
            Args: {
              p_action: string
              p_actor_id: string
              p_amount?: number
              p_loss_draft_id: string
              p_monitoring_type?: string
              p_notes?: string
              p_target_status?: string
              p_tracking_number?: string
            }
            Returns: Json
          }
      loss_draft_admin_delete: {
        Args: { p_actor_id: string; p_loss_draft_id: string; p_reason?: string }
        Returns: undefined
      }
      loss_draft_set_lender: {
        Args: {
          p_actor_id?: string
          p_lender_name: string
          p_loss_draft_id: string
        }
        Returns: undefined
      }
      loss_draft_toggle_document: {
        Args: {
          p_actor_id: string
          p_doc_id: string
          p_is_submitted: boolean
          p_notes?: string
        }
        Returns: Json
      }
      mark_deposit_closeout: {
        Args: {
          p_actor_id: string
          p_deposit_item_id: string
          p_notes?: string
        }
        Returns: Json
      }
      match_claim_document_chunks: {
        Args: {
          exclude_claim_id?: string
          filter_carrier?: string
          filter_decision?: Database["public"]["Enums"]["claim_doc_decision"]
          filter_evidence_type?: Database["public"]["Enums"]["claim_doc_evidence_type"]
          filter_loss_type?: Database["public"]["Enums"]["claim_doc_loss_type"]
          filter_state?: string
          filter_trade?: Database["public"]["Enums"]["claim_doc_trade"]
          match_count?: number
          query_embedding: string
        }
        Returns: {
          carrier_name: string
          chunk_index: number
          claim_id: string
          content: string
          decision_type: Database["public"]["Enums"]["claim_doc_decision"]
          denial_rationale: string
          evidence_type: Database["public"]["Enums"]["claim_doc_evidence_type"]
          file_id: string
          id: string
          loss_date: string
          loss_type: Database["public"]["Enums"]["claim_doc_loss_type"]
          outcome_paid_amount: number
          outcome_resolution_type: string
          policy_form: string
          similarity: number
          state_code: string
          trade: Database["public"]["Enums"]["claim_doc_trade"]
        }[]
      }
      match_knowledge_chunks: {
        Args: {
          filter_category?: string
          match_count?: number
          query_embedding: string
        }
        Returns: {
          chunk_index: number
          content: string
          doc_category: string
          doc_file_name: string
          document_id: string
          id: string
          metadata: Json
          similarity: number
        }[]
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      normalize_mortgage_company_name: {
        Args: { p_name: string }
        Returns: string
      }
      normalize_partner_check_status: {
        Args: {
          _check_stage: Database["public"]["Enums"]["check_stage"]
          _status: string
        }
        Returns: string
      }
      ocr_commit_results: {
        Args: {
          p_amount: number
          p_carrier_name: string
          p_check_id: string
          p_check_number: string
          p_check_status: string
          p_claim_id: string
          p_claim_number: string
          p_evaluated_by: string
          p_has_active_endorsements: boolean
          p_is_multi_payee: boolean
          p_issue_date: string
          p_ocr_status: string
          p_payee_line: string
          p_payees: Json
          p_raw_ocr: Json
          p_reasons: Json
          p_recommendation: string
          p_rules: Json
        }
        Returns: Json
      }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      process_deposit_webhook: {
        Args: {
          p_deposit_item_id?: string
          p_event_id: string
          p_event_type: string
          p_payload: Json
          p_provider: string
        }
        Returns: Json
      }
      process_endorsement_reminders: { Args: never; Returns: Json }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      rebalance_deposit_workload: {
        Args: { p_actor_id: string; p_max_per_owner?: number }
        Returns: Json
      }
      recompute_contractor_tier: {
        Args: { p_contractor_id: string }
        Returns: undefined
      }
      refresh_all_deposit_next_actions: {
        Args: { p_actor_id?: string }
        Returns: Json
      }
      refresh_portfolio_views: { Args: never; Returns: undefined }
      register_session: {
        Args: {
          p_device_info?: string
          p_ip_address?: string
          p_session_token: string
        }
        Returns: string
      }
      release_darwin_job: {
        Args: { p_error_message?: string; p_job_type: string }
        Returns: boolean
      }
      resolve_deposit_exception: {
        Args: {
          p_action?: string
          p_actor_id: string
          p_exception_id: string
          p_resolution_notes: string
        }
        Returns: Json
      }
      review_manager_approval: {
        Args: {
          p_approval_id: string
          p_decision: string
          p_notes?: string
          p_reviewer_id: string
        }
        Returns: Json
      }
      run_deposit_escalation_check: {
        Args: { p_actor_id?: string }
        Returns: Json
      }
      save_deposit_manager_snapshot: {
        Args: { p_actor_id?: string }
        Returns: Json
      }
      search_claims_by_proximity: {
        Args: {
          exclude_claim_id?: string
          radius_miles?: number
          target_insurance_company?: string
          target_lat: number
          target_lng: number
        }
        Returns: {
          claim_amount: number
          claim_id: string
          claim_number: string
          distance_miles: number
          insurance_company: string
          is_closed: boolean
          loss_date: string
          loss_type: string
          policyholder_address: string
          policyholder_name: string
          settlement_notes: string
          status: string
        }[]
      }
      search_public_contractors: {
        Args: {
          p_lat?: number
          p_limit?: number
          p_lng?: number
          p_min_rating?: number
          p_offset?: number
          p_search?: string
          p_sort?: string
          p_states?: string[]
          p_trades?: string[]
          p_zip?: string
        }
        Returns: {
          avg_rating: number
          bio: string
          created_at: string
          display_name: string
          distance_miles: number
          id: string
          jobs_count: number
          review_count: number
          service_radius_miles: number
          service_states: string[]
          service_zip_prefixes: string[]
          tier: string
          total_count: number
          trades: string[]
          zip_prefix_match: boolean
        }[]
      }
      seed_endorsements_from_payee_line: {
        Args: { _check_id: string }
        Returns: number
      }
      set_vault_secret: {
        Args: { secret_name: string; secret_value: string }
        Returns: undefined
      }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      submit_check_review_decision: {
        Args: {
          p_check_id: string
          p_confirmed_amount?: number
          p_confirmed_carrier_name?: string
          p_confirmed_check_number?: string
          p_confirmed_payee_line?: string
          p_deposit_path: string
          p_field_changes?: Json
          p_merge_payees?: Json
          p_reissue_reason?: string
          p_reissue_reason_category?: string
          p_reviewer_id: string
          p_reviewer_notes?: string
        }
        Returns: Json
      }
      submit_check_review_decision_safe: {
        Args: {
          p_check_id: string
          p_confirmed_amount?: number
          p_confirmed_carrier_name?: string
          p_confirmed_check_number?: string
          p_confirmed_payee_line?: string
          p_deposit_path: string
          p_field_changes?: Json
          p_merge_payees?: Json
          p_reissue_reason?: string
          p_reissue_reason_category?: string
          p_reviewer_id: string
          p_reviewer_notes?: string
        }
        Returns: Json
      }
      submit_homeowner_intro_request: {
        Args: {
          _contractor_profile_id: string
          _homeowner_email: string
          _homeowner_name: string
          _homeowner_phone?: string
          _loss_type?: string
          _message?: string
          _property_zip?: string
        }
        Returns: {
          access_token: string
          id: string
        }[]
      }
      submit_manager_approval: {
        Args: {
          p_actor_id: string
          p_approval_type: string
          p_description?: string
          p_item_count?: number
          p_payload: Json
          p_total_amount?: number
        }
        Returns: Json
      }
      system_tenant_id: { Args: never; Returns: string }
      to_standard_caps: { Args: { input: string }; Returns: string }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      user_belongs_to_tenant: {
        Args: { _tenant_id: string; _user_id: string }
        Returns: boolean
      }
      user_can_access_shared_check: {
        Args: { _check_id: string; _user_id: string }
        Returns: boolean
      }
      user_org_id: { Args: { _user_id: string }; Returns: string }
      validate_session: {
        Args: { p_session_token: string }
        Returns: {
          is_valid: boolean
          reason: string
          user_id: string
        }[]
      }
      vault_create_bridge_secret: { Args: { _secret: string }; Returns: string }
      vault_update_bridge_secret: {
        Args: { _secret: string }
        Returns: boolean
      }
      verify_micro_deposits: {
        Args: {
          p_amount_1: number
          p_amount_2: number
          p_verification_id: string
        }
        Returns: Json
      }
      whoami: { Args: never; Returns: string }
    }
    Enums: {
      app_role:
        | "admin"
        | "staff"
        | "client"
        | "contractor"
        | "referrer"
        | "read_only"
        | "guided"
      automation_mode: "active" | "passive" | "suspended" | "closed"
      cash_job_status:
        | "estimate"
        | "deposit_received"
        | "in_progress"
        | "final_payment_due"
        | "paid_in_full"
        | "cancelled"
      cash_job_work_type:
        | "roof"
        | "siding"
        | "gutters"
        | "windows"
        | "doors"
        | "interior"
        | "painting"
        | "flooring"
        | "hvac"
        | "plumbing"
        | "electrical"
        | "landscaping"
        | "other"
      cash_payment_method:
        | "cash"
        | "check"
        | "zelle"
        | "venmo"
        | "cashapp"
        | "credit_card"
        | "bank_transfer"
        | "other"
      check_stage:
        | "review"
        | "loss_draft"
        | "endorsing"
        | "ready_for_deposit"
        | "deposited"
        | "funds_released"
      claim_doc_decision:
        | "deny_full"
        | "deny_partial"
        | "accept"
        | "underpay"
        | "rfi"
        | "pending"
        | "supplement_approved"
        | "supplement_denied"
        | "unknown"
      claim_doc_evidence_type:
        | "estimate"
        | "denial_letter"
        | "approval_letter"
        | "engineer_report"
        | "moisture_map"
        | "core_sample"
        | "itel_report"
        | "ladder_assist"
        | "photo_analysis"
        | "policy"
        | "correspondence"
        | "invoice"
        | "supplement"
        | "rebuttal"
        | "demand"
        | "settlement"
        | "other"
      claim_doc_loss_type:
        | "wind"
        | "hail"
        | "water"
        | "fire"
        | "lightning"
        | "tornado"
        | "hurricane"
        | "theft"
        | "vandalism"
        | "collapse"
        | "mold"
        | "freeze"
        | "other"
      claim_doc_trade:
        | "roof"
        | "siding"
        | "gutters"
        | "windows"
        | "doors"
        | "interior"
        | "hvac"
        | "plumbing"
        | "electrical"
        | "foundation"
        | "fence"
        | "deck"
        | "garage"
        | "landscaping"
        | "contents"
        | "other"
      darwin_source_mode: "internal_only" | "hybrid"
      deposit_batch_status:
        | "open"
        | "sealed"
        | "submitted"
        | "partially_cleared"
        | "cleared"
        | "exception"
      deposit_item_status:
        | "pending_assignment"
        | "provider_assigned"
        | "submitted"
        | "processing"
        | "succeeded"
        | "failed"
        | "returned"
        | "reconciled"
        | "exception"
      deposit_provider:
        | "manual_branch"
        | "internal_ready"
        | "synctera"
        | "treasury_prime"
        | "increase"
        | "checkalt"
      professional_type: "contractor" | "public_adjuster" | "attorney"
      referral_alert_type:
        | "needs_contractor"
        | "needs_public_adjuster"
        | "needs_attorney"
      tenant_plan_tier: "starter" | "pro" | "enterprise"
      tenant_role: "admin" | "operator" | "viewer"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "admin",
        "staff",
        "client",
        "contractor",
        "referrer",
        "read_only",
        "guided",
      ],
      automation_mode: ["active", "passive", "suspended", "closed"],
      cash_job_status: [
        "estimate",
        "deposit_received",
        "in_progress",
        "final_payment_due",
        "paid_in_full",
        "cancelled",
      ],
      cash_job_work_type: [
        "roof",
        "siding",
        "gutters",
        "windows",
        "doors",
        "interior",
        "painting",
        "flooring",
        "hvac",
        "plumbing",
        "electrical",
        "landscaping",
        "other",
      ],
      cash_payment_method: [
        "cash",
        "check",
        "zelle",
        "venmo",
        "cashapp",
        "credit_card",
        "bank_transfer",
        "other",
      ],
      check_stage: [
        "review",
        "loss_draft",
        "endorsing",
        "ready_for_deposit",
        "deposited",
        "funds_released",
      ],
      claim_doc_decision: [
        "deny_full",
        "deny_partial",
        "accept",
        "underpay",
        "rfi",
        "pending",
        "supplement_approved",
        "supplement_denied",
        "unknown",
      ],
      claim_doc_evidence_type: [
        "estimate",
        "denial_letter",
        "approval_letter",
        "engineer_report",
        "moisture_map",
        "core_sample",
        "itel_report",
        "ladder_assist",
        "photo_analysis",
        "policy",
        "correspondence",
        "invoice",
        "supplement",
        "rebuttal",
        "demand",
        "settlement",
        "other",
      ],
      claim_doc_loss_type: [
        "wind",
        "hail",
        "water",
        "fire",
        "lightning",
        "tornado",
        "hurricane",
        "theft",
        "vandalism",
        "collapse",
        "mold",
        "freeze",
        "other",
      ],
      claim_doc_trade: [
        "roof",
        "siding",
        "gutters",
        "windows",
        "doors",
        "interior",
        "hvac",
        "plumbing",
        "electrical",
        "foundation",
        "fence",
        "deck",
        "garage",
        "landscaping",
        "contents",
        "other",
      ],
      darwin_source_mode: ["internal_only", "hybrid"],
      deposit_batch_status: [
        "open",
        "sealed",
        "submitted",
        "partially_cleared",
        "cleared",
        "exception",
      ],
      deposit_item_status: [
        "pending_assignment",
        "provider_assigned",
        "submitted",
        "processing",
        "succeeded",
        "failed",
        "returned",
        "reconciled",
        "exception",
      ],
      deposit_provider: [
        "manual_branch",
        "internal_ready",
        "synctera",
        "treasury_prime",
        "increase",
        "checkalt",
      ],
      professional_type: ["contractor", "public_adjuster", "attorney"],
      referral_alert_type: [
        "needs_contractor",
        "needs_public_adjuster",
        "needs_attorney",
      ],
      tenant_plan_tier: ["starter", "pro", "enterprise"],
      tenant_role: ["admin", "operator", "viewer"],
    },
  },
} as const
