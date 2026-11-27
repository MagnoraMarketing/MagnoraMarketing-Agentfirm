---
name: CEO daily report
slug: ceo-daily-report
assignee: ceo
project: magnora-operations
recurring: true
---

Lav "MAGNORA AI DAILY REPORT".

1. Check vigtige e-mails: læs Email-agentens seneste triage-kommentarer/issues (eller kør `gmail_search` med `is:important newer_than:1d`).
2. Check affiliate performance: brug Affiliate-agentens rapport eller `affiliate_stats` (yesterday).
3. Check afventende opgaver og godkendelser: `health_report` → pendingApprovals.
4. Check fejlede opgaver: `health_report` → failedItems, recentErrors, repeatedFailures, samt fejlede agent-runs i Paperclip.
5. Check social media-aktivitet: `social_post_history`.
6. Check møder/deadlines i åbne issues.
7. Gennemgå agent-aktivitet og budgetforbrug.
8. Lav dagens prioriteter (maks. 5) og uddeleger som child issues.
9. Skriv rapporten som dokument "daily-report" på dette issue:

```
MAGNORA AI DAILY REPORT – <dato>
1. Status (integrationer, agenter, budget)
2. E-mail
3. Affiliate
4. Social
5. Fejl og risici
6. Dagens prioriteter
7. Kræver din beslutning
```
