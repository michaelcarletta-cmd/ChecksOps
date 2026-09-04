# AWS staging realtime inventory → polling fallback

Supabase Realtime is not available on AWS staging. The Cognito client stubs
`channel().subscribe()` as a no-op. This batch adds `useAwsPollingFallback`
(interval refetch) wherever ordinary UI freshness depended on those channels.

| # | Channel / site | Tables watched | Fallback interval |
| --- | --- | --- | --- |
| 1 | `useCheckCommandRealtime` | `check_intake_items`, `check_files` | 15s |
| 2 | `CheckCommandCenter` shared-checks | `check_intake_items` (shared ids) | 20s |
| 3 | `CheckCommandCenter` checkops-realtime | `disbursement_splits`, `check_intake_items` | 20s |
| 4 | `CheckDetailPanel` check-detail-rt | `check_intake_items`, `check_endorsements` | 12s |
| 5 | `MortgageOpsQueue` | `mortgage_handling_requests` | 15s |
| 6 | `MortgageOpsRequestDetail` | `check_messages` | 12s |
| 7 | `SharedCheckThread` | `shared_check_messages` | 12s |
| 8 | `NotificationPopover` | `notifications` | 20s |
| 9 | `useReferralAlerts` | `referral_alerts` | 20s |
| 10 | `usePlatformAnnouncements` | `platform_announcements` | 30s (also has `refetchInterval`) |

Auth `onAuthStateChange` subscriptions are Cognito-backed and unchanged.
No WebSocket / AppSync realtime infrastructure in this batch.
