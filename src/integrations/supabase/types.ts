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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_checks: {
        Row: {
          amount: number
          check_date: string
          check_number: string | null
          check_type: string
          claim_id: string
          created_at: string | null
          created_by: string | null
          id: string
          notes: string | null
          received_date: string | null
          updated_at: string | null
        }
        Insert: {
          amount: number
          check_date: string
          check_number?: string | null
          check_type: string
          claim_id: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          received_date?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number
          check_date?: string
          check_number?: string | null
          check_type?: string
          claim_id?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          notes?: string | null
          received_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
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
            referencedRelation: "claims"
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
      claim_events: {
        Row: {
          actor: string | null
          claim_id: string
          created_at: string
          date_confidence: number | null
          date_evidence: string | null
          date_source: string
          doc_type: string | null
          event_type: string
          id: string
          metadata_json: Json
          occurred_at: string
          source_artifact_id: string | null
          source_artifact_type: string | null
          summary: string | null
          updated_at: string
        }
        Insert: {
          actor?: string | null
          claim_id: string
          created_at?: string
          date_confidence?: number | null
          date_evidence?: string | null
          date_source?: string
          doc_type?: string | null
          event_type: string
          id?: string
          metadata_json?: Json
          occurred_at: string
          source_artifact_id?: string | null
          source_artifact_type?: string | null
          summary?: string | null
          updated_at?: string
        }
        Update: {
          actor?: string | null
          claim_id?: string
          created_at?: string
          date_confidence?: number | null
          date_evidence?: string | null
          date_source?: string
          doc_type?: string | null
          event_type?: string
          id?: string
          metadata_json?: Json
          occurred_at?: string
          source_artifact_id?: string | null
          source_artifact_type?: string | null
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
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
          notes: string | null
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
          notes?: string | null
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
          notes?: string | null
          paid_to?: string | null
          payment_method?: string | null
          updated_at?: string | null
        }
        Relationships: [
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_files: {
        Row: {
          claim_id: string
          classification_confidence: number | null
          classification_metadata: Json | null
          darwin_processed_at: string | null
          document_classification: string | null
          email_id: string | null
          extracted_text: string | null
          file_name: string
          file_path: string
          file_size: number | null
          file_type: string | null
          folder_id: string | null
          id: string
          is_latest_version: boolean | null
          needs_text_backfill: boolean
          ocr_processed_at: string | null
          parent_file_id: string | null
          processed_by_darwin: boolean | null
          source: string | null
          uploaded_at: string | null
          uploaded_by: string | null
          version: number | null
          version_label: string | null
        }
        Insert: {
          claim_id: string
          classification_confidence?: number | null
          classification_metadata?: Json | null
          darwin_processed_at?: string | null
          document_classification?: string | null
          email_id?: string | null
          extracted_text?: string | null
          file_name: string
          file_path: string
          file_size?: number | null
          file_type?: string | null
          folder_id?: string | null
          id?: string
          is_latest_version?: boolean | null
          needs_text_backfill?: boolean
          ocr_processed_at?: string | null
          parent_file_id?: string | null
          processed_by_darwin?: boolean | null
          source?: string | null
          uploaded_at?: string | null
          uploaded_by?: string | null
          version?: number | null
          version_label?: string | null
        }
        Update: {
          claim_id?: string
          classification_confidence?: number | null
          classification_metadata?: Json | null
          darwin_processed_at?: string | null
          document_classification?: string | null
          email_id?: string | null
          extracted_text?: string | null
          file_name?: string
          file_path?: string
          file_size?: number | null
          file_type?: string | null
          folder_id?: string | null
          id?: string
          is_latest_version?: boolean | null
          needs_text_backfill?: boolean
          ocr_processed_at?: string | null
          parent_file_id?: string | null
          processed_by_darwin?: boolean | null
          source?: string | null
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
        }
        Insert: {
          claim_id: string
          created_at?: string | null
          created_by?: string | null
          display_order?: number | null
          id?: string
          is_predefined?: boolean | null
          name: string
        }
        Update: {
          claim_id?: string
          created_at?: string | null
          created_by?: string | null
          display_order?: number | null
          id?: string
          is_predefined?: boolean | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_folders_claim_id_fkey"
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_home_inventory: {
        Row: {
          actual_cash_value: number | null
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
          id: string
          is_total_loss: boolean | null
          item_description: string | null
          item_name: string
          manufacturer: string | null
          model_confirmed: boolean
          model_number: string | null
          needs_review: boolean
          notes: string | null
          original_purchase_date: string | null
          original_purchase_price: number | null
          photo_file_paths: string[] | null
          price_confirmed: boolean
          pricing_rationale: string | null
          pricing_source: string | null
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
          id?: string
          is_total_loss?: boolean | null
          item_description?: string | null
          item_name: string
          manufacturer?: string | null
          model_confirmed?: boolean
          model_number?: string | null
          needs_review?: boolean
          notes?: string | null
          original_purchase_date?: string | null
          original_purchase_price?: number | null
          photo_file_paths?: string[] | null
          price_confirmed?: boolean
          pricing_rationale?: string | null
          pricing_source?: string | null
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
          id?: string
          is_total_loss?: boolean | null
          item_description?: string | null
          item_name?: string
          manufacturer?: string | null
          model_confirmed?: boolean
          model_number?: string | null
          needs_review?: boolean
          notes?: string | null
          original_purchase_date?: string | null
          original_purchase_price?: number | null
          photo_file_paths?: string[] | null
          price_confirmed?: boolean
          pricing_rationale?: string | null
          pricing_source?: string | null
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
          is_reimbursed: boolean | null
          is_submitted_to_insurer: boolean | null
          notes: string | null
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
          is_reimbursed?: boolean | null
          is_submitted_to_insurer?: boolean | null
          notes?: string | null
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
          is_reimbursed?: boolean | null
          is_submitted_to_insurer?: boolean | null
          notes?: string | null
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_settlements: {
        Row: {
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
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          color?: string | null
          created_at?: string | null
          display_order?: number
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          color?: string | null
          created_at?: string | null
          display_order?: number
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
            referencedRelation: "claims"
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
          jobnimbus_job_id: string | null
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
          signed_pdf_url: string | null
          ssn_last_four: string | null
          state_code: string | null
          status: string | null
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
          jobnimbus_job_id?: string | null
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
          signed_pdf_url?: string | null
          ssn_last_four?: string | null
          state_code?: string | null
          status?: string | null
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
          jobnimbus_job_id?: string | null
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
          signed_pdf_url?: string | null
          ssn_last_four?: string | null
          state_code?: string | null
          status?: string | null
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
            referencedRelation: "claims"
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
          esign_date_height: number | null
          esign_date_page: number | null
          esign_date_width: number | null
          esign_date_x: number | null
          esign_date_y: number | null
          esign_email_body: string | null
          esign_email_subject: string | null
          esign_signature_height: number | null
          esign_signature_page: number | null
          esign_signature_width: number | null
          esign_signature_x: number | null
          esign_signature_y: number | null
          id: string
          letterhead_url: string | null
          online_check_writer_bank_account_id: string | null
          signnow_make_webhook_url: string | null
          updated_at: string
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
          esign_date_height?: number | null
          esign_date_page?: number | null
          esign_date_width?: number | null
          esign_date_x?: number | null
          esign_date_y?: number | null
          esign_email_body?: string | null
          esign_email_subject?: string | null
          esign_signature_height?: number | null
          esign_signature_page?: number | null
          esign_signature_width?: number | null
          esign_signature_x?: number | null
          esign_signature_y?: number | null
          id?: string
          letterhead_url?: string | null
          online_check_writer_bank_account_id?: string | null
          signnow_make_webhook_url?: string | null
          updated_at?: string
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
          esign_date_height?: number | null
          esign_date_page?: number | null
          esign_date_width?: number | null
          esign_date_x?: number | null
          esign_date_y?: number | null
          esign_email_body?: string | null
          esign_email_subject?: string | null
          esign_signature_height?: number | null
          esign_signature_page?: number | null
          esign_signature_width?: number | null
          esign_signature_x?: number | null
          esign_signature_y?: number | null
          id?: string
          letterhead_url?: string | null
          online_check_writer_bank_account_id?: string | null
          signnow_make_webhook_url?: string | null
          updated_at?: string
        }
        Relationships: []
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
          pdf_file_name?: string | null
          result?: string
        }
        Relationships: [
          {
            foreignKeyName: "darwin_analysis_results_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      darwin_declared_positions: {
        Row: {
          carrier_dependency_statement: string | null
          claim_id: string
          confidence_level: string | null
          created_at: string
          created_by: string | null
          id: string
          missing_inputs: string[] | null
          position_locked: boolean
          primary_carrier_error: string | null
          primary_cause_of_loss: string | null
          primary_coverage_theory: string | null
          reasoning_complete: boolean
          risk_flags: string[] | null
          updated_at: string
        }
        Insert: {
          carrier_dependency_statement?: string | null
          claim_id: string
          confidence_level?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          missing_inputs?: string[] | null
          position_locked?: boolean
          primary_carrier_error?: string | null
          primary_cause_of_loss?: string | null
          primary_coverage_theory?: string | null
          reasoning_complete?: boolean
          risk_flags?: string[] | null
          updated_at?: string
        }
        Update: {
          carrier_dependency_statement?: string | null
          claim_id?: string
          confidence_level?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          missing_inputs?: string[] | null
          position_locked?: boolean
          primary_carrier_error?: string | null
          primary_cause_of_loss?: string | null
          primary_coverage_theory?: string | null
          reasoning_complete?: boolean
          risk_flags?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "darwin_declared_positions_claim_id_fkey"
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
      }
      jobnimbus_sync_queue: {
        Row: {
          claim_id: string | null
          contractor_id: string
          created_at: string | null
          error_message: string | null
          id: string
          payload: Json | null
          processed_at: string | null
          status: string | null
          sync_type: string
        }
        Insert: {
          claim_id?: string | null
          contractor_id: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          payload?: Json | null
          processed_at?: string | null
          status?: string | null
          sync_type: string
        }
        Update: {
          claim_id?: string | null
          contractor_id?: string
          created_at?: string | null
          error_message?: string | null
          id?: string
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
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
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
      signature_requests: {
        Row: {
          claim_id: string
          completed_at: string | null
          created_at: string | null
          created_by: string | null
          document_name: string
          document_path: string
          field_data: Json | null
          id: string
          status: string
          updated_at: string | null
        }
        Insert: {
          claim_id: string
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          document_name: string
          document_path: string
          field_data?: Json | null
          id?: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          claim_id?: string
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          document_name?: string
          document_path?: string
          field_data?: Json | null
          id?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
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
          field_values: Json | null
          id: string
          signature_data: string | null
          signature_request_id: string
          signed_at: string | null
          signer_email: string
          signer_name: string
          signer_type: string
          signing_order: number
          status: string
        }
        Insert: {
          access_token?: string
          created_at?: string | null
          field_values?: Json | null
          id?: string
          signature_data?: string | null
          signature_request_id: string
          signed_at?: string | null
          signer_email: string
          signer_name: string
          signer_type: string
          signing_order?: number
          status?: string
        }
        Update: {
          access_token?: string
          created_at?: string | null
          field_values?: Json | null
          id?: string
          signature_data?: string | null
          signature_request_id?: string
          signed_at?: string | null
          signer_email?: string
          signer_name?: string
          signer_type?: string
          signing_order?: number
          status?: string
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
            referencedRelation: "claims"
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
          trigger_status: string | null
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
          trigger_status?: string | null
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
          trigger_status?: string | null
          trigger_type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      tasks: {
        Row: {
          assigned_to: string | null
          claim_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          follow_up_current_count: number | null
          follow_up_enabled: boolean | null
          follow_up_interval_days: number | null
          follow_up_last_sent_at: string | null
          follow_up_max_count: number | null
          follow_up_next_at: string | null
          follow_up_stop_reason: string | null
          follow_up_stopped_at: string | null
          id: string
          priority: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          claim_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          follow_up_current_count?: number | null
          follow_up_enabled?: boolean | null
          follow_up_interval_days?: number | null
          follow_up_last_sent_at?: string | null
          follow_up_max_count?: number | null
          follow_up_next_at?: string | null
          follow_up_stop_reason?: string | null
          follow_up_stopped_at?: string | null
          id?: string
          priority?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          claim_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          follow_up_current_count?: number | null
          follow_up_enabled?: boolean | null
          follow_up_interval_days?: number | null
          follow_up_last_sent_at?: string | null
          follow_up_max_count?: number | null
          follow_up_next_at?: string | null
          follow_up_stop_reason?: string | null
          follow_up_stopped_at?: string | null
          id?: string
          priority?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id"]
          },
        ]
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
    }
    Views: {
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
    }
    Functions: {
      acquire_darwin_job: {
        Args: {
          p_claimed_by: string
          p_job_type: string
          p_ttl_seconds?: number
        }
        Returns: Json
      }
      can_manage_roles: { Args: { _user_id: string }; Returns: boolean }
      create_claim_for_staff: {
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
          jobnimbus_job_id: string | null
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
          signed_pdf_url: string | null
          ssn_last_four: string | null
          state_code: string | null
          status: string | null
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
      decrypt_pii: {
        Args: { p_ciphertext: string; p_key_name?: string }
        Returns: string
      }
      encrypt_pii: {
        Args: { p_key_name?: string; p_plaintext: string }
        Returns: string
      }
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
      get_portfolio_carrier_analytics: { Args: never; Returns: Json }
      get_portfolio_intelligence: { Args: never; Returns: Json }
      get_weekly_command_review: { Args: never; Returns: Json }
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
      invalidate_all_sessions: { Args: { p_user_id?: string }; Returns: number }
      invalidate_session: {
        Args: { p_session_token: string }
        Returns: boolean
      }
      is_org_admin: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_read_only: { Args: { _user_id: string }; Returns: boolean }
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
      user_org_id: { Args: { _user_id: string }; Returns: string }
      validate_session: {
        Args: { p_session_token: string }
        Returns: {
          is_valid: boolean
          reason: string
          user_id: string
        }[]
      }
    }
    Enums: {
      app_role:
        | "admin"
        | "staff"
        | "client"
        | "contractor"
        | "referrer"
        | "read_only"
      automation_mode: "active" | "passive" | "suspended" | "closed"
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
    }
    CompositeTypes: {
      [_ in never]: never
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
      ],
      automation_mode: ["active", "passive", "suspended", "closed"],
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
    },
  },
} as const
